use crate::{domain, storage::Persisted, validation};
use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use ditalist_contracts::*;
use std::collections::{HashMap, HashSet};

fn eligible(task: &Task) -> bool {
    task.deleted_at.is_none()
        && task.completed_at.is_none()
        && task.agent_status == "approved"
        && task.reminder != "none"
        && task.due_date.is_some()
        && task.time.is_some()
}

fn schedule_changed(a: &Task, b: &Task) -> bool {
    a.due_date != b.due_date
        || a.time != b.time
        || a.reminder != b.reminder
        || a.deleted_at != b.deleted_at
        || a.completed_at != b.completed_at
        || a.agent_status != b.agent_status
}

fn scheduled_at(task: &Task) -> Option<DateTime<Utc>> {
    let date = validation::date(task.due_date.as_deref()?).ok()?;
    let time = validation::time(task.time.as_deref()?).ok()?;
    let nominal = date.and_time(time);
    // A clock-forward gap uses the first real local instant after the requested minute.
    let local = (0..=180).find_map(|minute| {
        Local
            .from_local_datetime(&(nominal + Duration::minutes(minute)))
            .earliest()
    })?;
    let advance = match task.reminder.as_str() {
        "5m" => 5,
        "15m" => 15,
        "30m" => 30,
        "1h" => 60,
        "1d" => 1440,
        _ => 0,
    };
    Some(local.with_timezone(&Utc) - Duration::minutes(advance))
}

pub(crate) fn reconcile(previous: &Persisted, next: &mut Persisted) {
    let before: HashMap<_, _> = previous
        .data
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let current: HashMap<_, _> = next
        .data
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    for event in &mut next.reminders {
        let task = current.get(event.task_id.as_str());
        if task.is_none_or(|task| {
            !eligible(task)
                || before
                    .get(task.id.as_str())
                    .is_some_and(|old| schedule_changed(old, task))
        }) {
            event.invalidated = true;
            event.snoozed_until = None;
        }
    }
    let mut scheduled: HashSet<String> = next
        .reminders
        .iter()
        .filter(|event| !event.invalidated)
        .map(|event| event.task_id.clone())
        .collect();
    for task in &next.data.tasks {
        if !eligible(task) || scheduled.contains(&task.id) {
            continue;
        }
        if let Some(due) = scheduled_at(task) {
            next.reminders.push(ReminderEvent {
                id: domain::uid(),
                task_id: task.id.clone(),
                version: *next.entity_versions.get(&task.id).unwrap_or(&1),
                due_at: domain::stamp(due),
                notified: false,
                handled: false,
                invalidated: false,
                snoozed_until: None,
            });
            scheduled.insert(task.id.clone());
        }
    }
}

pub(crate) fn due_at(event: &ReminderEvent) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(event.snoozed_until.as_ref().unwrap_or(&event.due_at))
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

pub(crate) fn active(event: &ReminderEvent, now: DateTime<Utc>) -> bool {
    !event.invalidated && !event.handled && due_at(event).is_some_and(|due| due <= now)
}

pub(crate) fn counts(state: &Persisted, now: DateTime<Utc>) -> (u32, u32, u32) {
    let today = domain::date_text(domain::today(now));
    let today_count = state
        .data
        .tasks
        .iter()
        .filter(|task| {
            task.deleted_at.is_none()
                && task.completed_at.is_none()
                && task.agent_status == "approved"
                && task.due_date.as_ref().is_some_and(|date| date <= &today)
        })
        .count() as u32;
    let existing: HashSet<_> = state
        .data
        .tasks
        .iter()
        .filter(|task| task.deleted_at.is_none())
        .map(|task| task.id.as_str())
        .collect();
    let pending = state
        .data
        .tasks
        .iter()
        .filter(|task| {
            task.deleted_at.is_none()
                && task.created_by == "agent"
                && task.agent_status == "pending"
        })
        .count()
        + state
            .approvals
            .iter()
            .filter(|approval| {
                approval.status == "pending" && existing.contains(approval.task_id.as_str())
            })
            .count();
    (
        today_count,
        pending as u32,
        state
            .reminders
            .iter()
            .filter(|event| active(event, now))
            .count() as u32,
    )
}

pub(crate) fn act(
    state: &mut Persisted,
    id: &str,
    action: &str,
    now: DateTime<Utc>,
) -> Result<(), CoreError> {
    let event = state
        .reminders
        .iter_mut()
        .find(|event| event.id == id)
        .ok_or_else(|| CoreError::new("not_found", "提醒不存在"))?;
    if event.invalidated || event.handled {
        return Ok(());
    }
    if !active(event, now) {
        return Err(validation::invalid("提醒尚未到时"));
    }
    match action {
        "notified" => event.notified = true,
        "acknowledge" | "ack" | "handled" => event.handled = true,
        "snooze" => {
            event.snoozed_until = Some(domain::stamp(now + Duration::minutes(10)));
            event.notified = false;
        }
        _ => return Err(validation::invalid("不支持的提醒操作")),
    }
    Ok(())
}

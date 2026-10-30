use crate::validation::{self, invalid};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Utc, Weekday};
use ditalist_contracts::*;
use regex::{Captures, Regex};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) const TASK_EDIT_FIELDS: &[&str] = &[
    "title",
    "content",
    "listId",
    "startDate",
    "dueDate",
    "time",
    "endTime",
    "priority",
    "repeat",
    "reminder",
    "tags",
    "subtasks",
    "sortOrder",
    "pinned",
];
const TASK_INPUT_FIELDS: &[&str] = &[
    "id",
    "title",
    "content",
    "listId",
    "startDate",
    "dueDate",
    "time",
    "endTime",
    "priority",
    "repeat",
    "reminder",
    "tags",
    "subtasks",
    "sortOrder",
    "pinned",
    "completedAt",
    "deletedAt",
    "createdAt",
    "updatedAt",
    "createdBy",
    "agentStatus",
    "recurrenceAnchor",
    "recurrenceId",
];

pub(crate) fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn today(now: DateTime<Utc>) -> NaiveDate {
    now.with_timezone(&Local).date_naive()
}
pub(crate) fn date_text(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}
pub(crate) fn uid() -> String {
    Uuid::new_v4().to_string()
}

pub(crate) fn empty_data() -> AppData {
    AppData {
        schema_version: 1,
        tasks: vec![],
        lists: vec![TaskList {
            id: "inbox".into(),
            name: "收集箱".into(),
            color: "#4772FA".into(),
            folder_id: None,
            archived: false,
            sort_order: 0.0,
        }],
        folders: vec![],
        habits: vec![],
        filters: vec![],
        focus_sessions: vec![],
        settings: Settings {
            theme: "light".into(),
            accent: "#4772FA".into(),
            week_start: 1,
            show_completed: false,
            calendar_mode: "month".into(),
            sidebar_collapsed: false,
            default_view: "today".into(),
            pomodoro_minutes: 25,
            break_minutes: 5,
            sound: true,
            notifications: true,
            floating_shortcut: "CommandOrControl+Alt+Space".into(),
            floating_default_list_id: "inbox".into(),
            floating_default_date: "today".into(),
            custom_tags: vec![],
            navigation: NavigationPreferences::default(),
        },
    }
}

pub(crate) fn new_task(input: Value, now: DateTime<Utc>) -> Result<Task, CoreError> {
    let mut value = json!({
        "id": uid(), "title": "", "content": "", "listId": "inbox", "startDate": null,
        "dueDate": null, "time": null, "endTime": null, "priority": 0, "repeat": "none", "reminder": "none",
        "tags": [], "subtasks": [], "completedAt": null, "deletedAt": null,
        "createdAt": stamp(now), "updatedAt": stamp(now), "sortOrder": now.timestamp_millis() as f64,
        "pinned": false, "createdBy": "user", "agentStatus": "approved"
    });
    validation::patch_known(&mut value, &input, TASK_INPUT_FIELDS)?;
    let mut task: Task =
        serde_json::from_value(value).map_err(|e| invalid(format!("任务格式错误：{e}")))?;
    validation::task(&mut task)?;
    Ok(task)
}

pub(crate) fn patch_task(
    task: &Task,
    patch: &Value,
    now: DateTime<Utc>,
) -> Result<Task, CoreError> {
    let mut value = serde_json::to_value(task).expect("task serializes");
    validation::patch_known(&mut value, patch, TASK_EDIT_FIELDS)?;
    value["updatedAt"] = json!(stamp(now));
    let mut changed: Task =
        serde_json::from_value(value).map_err(|e| invalid(format!("任务修改格式错误：{e}")))?;
    validation::task(&mut changed)?;
    Ok(changed)
}

pub(crate) fn next_recurring_date(
    day: NaiveDate,
    rule: &str,
    anchor: NaiveDate,
) -> Result<NaiveDate, CoreError> {
    let result = match rule {
        "daily" => day.checked_add_signed(Duration::days(1)),
        "weekly" => day.checked_add_signed(Duration::days(7)),
        "weekdays" => {
            let mut d = day;
            loop {
                d = d.succ_opt().ok_or_else(|| invalid("日期超出支持范围"))?;
                if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                    break;
                }
            }
            Some(d)
        }
        "monthly" => {
            let (year, month) = if day.month() == 12 {
                (day.year() + 1, 1)
            } else {
                (day.year(), day.month() + 1)
            };
            clamped_date(year, month, anchor.day())
        }
        "yearly" => clamped_date(day.year() + 1, anchor.month(), anchor.day()),
        "none" => Some(day),
        _ => return Err(invalid("不支持的重复规则")),
    };
    result.ok_or_else(|| invalid("日期超出支持范围"))
}

fn clamped_date(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
    (1..=day)
        .rev()
        .find_map(|d| NaiveDate::from_ymd_opt(year, month, d))
}

pub(crate) fn complete_task(
    data: &mut AppData,
    id: &str,
    completed: bool,
    now: DateTime<Utc>,
) -> Result<(), CoreError> {
    let index = data
        .tasks
        .iter()
        .position(|task| task.id == id)
        .ok_or_else(|| CoreError::new("not_found", "任务不存在"))?;
    let task = data.tasks[index].clone();
    if task.deleted_at.is_some() {
        return Err(invalid("回收站中的任务不能修改完成状态"));
    }
    if task.agent_status == "pending" {
        return Err(invalid("请先审核 Agent 新建任务"));
    }
    if completed == task.completed_at.is_some() {
        return Ok(());
    }
    data.tasks[index].completed_at = completed.then(|| stamp(now));
    data.tasks[index].updated_at = stamp(now);
    if !completed || task.repeat == "none" {
        return Ok(());
    }
    let due = task
        .due_date
        .as_deref()
        .map(validation::date)
        .transpose()?
        .unwrap_or_else(|| today(now));
    let anchor = task
        .recurrence_anchor
        .as_deref()
        .map(validation::date)
        .transpose()?
        .unwrap_or(due);
    let series = task
        .recurrence_id
        .clone()
        .unwrap_or_else(|| task.id.clone());
    data.tasks[index].recurrence_anchor = Some(date_text(anchor));
    data.tasks[index].recurrence_id = Some(series.clone());
    let next = next_recurring_date(due, &task.repeat, anchor)?;
    let next_text = date_text(next);
    if data.tasks.iter().any(|other| {
        other.recurrence_id.as_deref() == Some(&series)
            && other.due_date.as_deref() == Some(&next_text)
            && other.deleted_at.is_none()
    }) {
        return Ok(());
    }
    let span = task
        .start_date
        .as_deref()
        .map(validation::date)
        .transpose()?
        .map(|start| due - start)
        .unwrap_or(Duration::zero());
    let mut following = task;
    following.id = uid();
    following.due_date = Some(next_text);
    following.start_date = following.start_date.map(|_| date_text(next - span));
    following.completed_at = None;
    following.deleted_at = None;
    following.created_at = stamp(now);
    following.updated_at = stamp(now);
    following.recurrence_anchor = Some(date_text(anchor));
    following.recurrence_id = Some(series);
    for sub in &mut following.subtasks {
        sub.id = uid();
        sub.completed = false;
    }
    data.tasks.push(following);
    Ok(())
}

/// Mirrors the established parser while keeping all authoritative parsing in Rust.
pub(crate) fn quick_input(input: &str, list: &str, day: NaiveDate) -> Result<Value, CoreError> {
    validation::text(input, "快速输入", 1, 10_000)?;
    let mut title = input.trim().to_owned();
    let mut result = json!({"title": title, "listId": list});
    let mut tags = vec![];
    title = Regex::new(r"(^|\s)#([\p{L}\p{N}_-]+)")
        .unwrap()
        .replace_all(&title, |cap: &Captures| {
            let tag = cap[2].to_owned();
            if !tags.contains(&tag) {
                tags.push(tag);
            }
            " ".to_owned()
        })
        .into_owned();
    if !tags.is_empty() {
        result["tags"] = json!(tags);
    }
    title = Regex::new(r"(^|\s)!([123])($|\s)")
        .unwrap()
        .replacen(&title, 1, |cap: &Captures| {
            result["priority"] = json!(cap[2].parse::<u8>().unwrap());
            format!("{} {}", &cap[1], &cap[3])
        })
        .into_owned();
    title = Regex::new("每天|每周|每月|每年|每个工作日|工作日")
        .unwrap()
        .replacen(&title, 1, |cap: &Captures| {
            result["repeat"] = json!(match &cap[0] {
                "每天" => "daily",
                "每周" => "weekly",
                "每月" => "monthly",
                "每年" => "yearly",
                _ => "weekdays",
            });
            result["dueDate"] = json!(date_text(day));
            "".to_owned()
        })
        .into_owned();
    title = Regex::new("大后天|后天|明天|今天")
        .unwrap()
        .replacen(&title, 1, |cap: &Captures| {
            let offset = match &cap[0] {
                "大后天" => 3,
                "后天" => 2,
                "明天" => 1,
                _ => 0,
            };
            result["dueDate"] = json!(date_text(day + Duration::days(offset)));
            "".to_owned()
        })
        .into_owned();
    let date_re = Regex::new(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})").unwrap();
    if let Some(cap) = date_re.captures_iter(&title).find(|cap| {
        let hit = cap.get(0).unwrap();
        !title[..hit.start()]
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_digit())
            && !title[hit.end()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())
    }) {
        let parsed = NaiveDate::from_ymd_opt(
            cap[1].parse().unwrap_or(0),
            cap[2].parse().unwrap_or(0),
            cap[3].parse().unwrap_or(0),
        );
        if let Some(parsed) = parsed {
            let hit = cap.get(0).unwrap();
            result["dueDate"] = json!(date_text(parsed));
            title.replace_range(hit.start()..hit.end(), "");
        }
    }
    title = Regex::new(r"(上午|下午|晚上|早上|中午)?\s*(\d{1,2})[:：](\d{2})|(?:上午|下午|晚上|早上|中午)\s*\d{1,2}点(?:半|\d{1,2}分?)?").unwrap().replacen(&title, 1, |cap: &Captures| {
        let token = &cap[0];
        let sub = Regex::new(r"(上午|下午|晚上|早上|中午)?\s*(\d{1,2})(?:[:：](\d{2})|点(半|\d{1,2}分?)?)?").unwrap();
        let Some(parts) = sub.captures(token) else { return token.to_owned(); };
        let mut hour: u32 = parts[2].parse().unwrap();
        let minute = if let Some(m) = parts.get(3) { m.as_str().parse::<u32>().unwrap_or(0) } else if parts.get(4).map(|m| m.as_str()) == Some("半") { 30 } else { parts.get(4).map(|m| m.as_str().trim_end_matches('分').parse::<u32>().unwrap_or(0)).unwrap_or(0) };
        let period = parts.get(1).map(|m| m.as_str()).unwrap_or("");
        if (["下午", "晚上"].contains(&period) && hour < 12) || (period == "中午" && hour < 11) { hour += 12; }
        if hour > 23 || minute > 59 { return token.to_owned(); }
        result["time"] = json!(format!("{hour:02}:{minute:02}"));
        if result.get("dueDate").is_none() { result["dueDate"] = json!(date_text(day)); }
        "".to_owned()
    }).into_owned();
    let cleaned = title.split_whitespace().collect::<Vec<_>>().join(" ");
    result["title"] = json!(if cleaned.is_empty() {
        input.trim()
    } else {
        &cleaned
    });
    Ok(result)
}

pub(crate) fn move_list(
    data: &mut AppData,
    id: &str,
    target: &ListMoveTarget,
) -> Result<(), CoreError> {
    let source = data
        .lists
        .iter()
        .find(|list| list.id == id)
        .ok_or_else(|| CoreError::new("not_found", "清单不存在"))?;
    if source.id == "inbox" || source.archived {
        return Err(invalid("收集箱或归档清单不能移动"));
    }
    let folder_id = match target {
        ListMoveTarget::Group { folder_id } => {
            if let Some(folder) = folder_id
                && !data.folders.iter().any(|f| f.id == *folder)
            {
                return Err(invalid("文件夹不存在"));
            }
            folder_id.clone()
        }
        ListMoveTarget::List { list_id, position } => {
            if !["before", "after"].contains(&position.as_str()) {
                return Err(invalid("清单位置无效"));
            }
            let anchor = data
                .lists
                .iter()
                .find(|list| list.id == *list_id)
                .ok_or_else(|| CoreError::new("not_found", "目标清单不存在"))?;
            if anchor.id == id || anchor.id == "inbox" || anchor.archived {
                return Err(invalid("目标清单不能用于排序"));
            }
            anchor.folder_id.clone()
        }
    };
    let mut siblings: Vec<_> = data
        .lists
        .iter()
        .filter(|list| {
            !list.archived && list.id != "inbox" && list.id != id && list.folder_id == folder_id
        })
        .collect();
    siblings.sort_by(|a, b| a.sort_order.total_cmp(&b.sort_order));
    let mut ordered: Vec<_> = siblings.into_iter().map(|list| list.id.clone()).collect();
    let index = match target {
        ListMoveTarget::Group { .. } => ordered.len(),
        ListMoveTarget::List { list_id, position } => {
            ordered.iter().position(|v| v == list_id).unwrap() + usize::from(position == "after")
        }
    };
    ordered.insert(index, id.into());
    let positions: BTreeMap<_, _> = ordered
        .into_iter()
        .enumerate()
        .map(|(index, id)| (id, index as f64))
        .collect();
    for list in &mut data.lists {
        if let Some(order) = positions.get(&list.id) {
            list.folder_id = folder_id.clone();
            list.sort_order = *order;
        }
    }
    Ok(())
}

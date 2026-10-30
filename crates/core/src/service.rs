use crate::{
    domain, focus, import, navigation, reminders,
    storage::{Persisted, RecordedRequest, Store},
    validation,
};
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Utc};
use ditalist_contracts::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

#[derive(Clone)]
pub struct CoreService {
    inner: Arc<Mutex<Inner>>,
    clock: Clock,
}

struct Inner {
    store: Store,
    persisted: Persisted,
    focus: focus::Runtime,
    offered_reminders: BTreeSet<String>,
    last_counts: (u32, u32, u32),
    last_count_day: NaiveDate,
    pending_effects: Vec<CoreEffect>,
}

impl CoreService {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self, CoreError> {
        Self::open_with_clock(data_dir, Arc::new(Utc::now))
    }

    /// Explicit clock injection keeps calendar and recovery tests deterministic.
    pub fn open_with_clock(
        data_dir: impl AsRef<Path>,
        clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    ) -> Result<Self, CoreError> {
        let (store, persisted) = Store::open(data_dir.as_ref())?;
        let focus = focus::Runtime::new(&persisted.data);
        let now = clock();
        let last_counts = reminders::counts(&persisted, now);
        let last_count_day = domain::today(now);
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                store,
                persisted,
                focus,
                offered_reminders: BTreeSet::new(),
                last_counts,
                last_count_day,
                pending_effects: vec![],
            })),
            clock,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn snapshot(&self) -> CoreSnapshot {
        let inner = self.lock();
        let now = (self.clock)();
        let state = &inner.persisted;
        let (today_count, pending_count, reminder_count) = reminders::counts(state, now);
        CoreSnapshot {
            data: state.data.clone(),
            revision: state.revision,
            entity_versions: state.entity_versions.clone(),
            approvals: state.approvals.clone(),
            reminders: state.reminders.clone(),
            focus: inner.focus.snapshot(now),
            preferences: state.preferences.clone(),
            today_count,
            pending_count,
            reminder_count,
        }
    }

    pub fn get_request(&self, request_id: &str) -> Option<CommandReceipt> {
        self.lock()
            .persisted
            .requests
            .get(request_id)
            .map(|entry| entry.receipt.clone())
    }

    pub fn execute(
        &self,
        command: CoreCommand,
        caller: Caller,
    ) -> Result<CommandReceipt, CoreError> {
        authorize(&command.operation, caller)?;
        let fingerprint = command_fingerprint(&command, caller)?;
        let mut inner = self.lock();
        if let Some(receipt) =
            existing_receipt(&inner.persisted, &command.request_id, &fingerprint)?
        {
            return Ok(receipt);
        }
        let now = (self.clock)();
        let mut next = inner.persisted.clone();
        let mut focus = inner.focus.clone();
        let completed_focus = focus.tick(&mut next.data, now);
        let (status, result) = apply(&mut next, &mut focus, &command.operation, caller, now)?;
        validation::app(&mut next.data)?;
        update_versions(&inner.persisted, &mut next);
        reminders::reconcile(&inner.persisted, &mut next);
        invalidate_approvals(&mut next);
        let receipt = record_receipt(
            &mut next,
            command.request_id,
            fingerprint,
            status,
            result,
            now,
        )?;
        inner.store.commit(&inner.persisted, &next)?;
        inner.persisted = next;
        inner.focus = focus;
        inner.last_counts = reminders::counts(&inner.persisted, now);
        inner.last_count_day = domain::today(now);
        if let Some(message) = completed_focus {
            inner
                .pending_effects
                .push(CoreEffect::FocusCompleted(message));
        }
        Ok(receipt)
    }

    /// Settle an admitted request whose failed save was retried and now has a terminal
    /// business error. The host keeps retryable failures pending; this is not an IPC operation.
    pub fn settle_rejected(
        &self,
        command: CoreCommand,
        caller: Caller,
        error: CoreError,
    ) -> Result<CommandReceipt, CoreError> {
        if !matches!(
            error.code.as_str(),
            "conflict"
                | "invalid_input"
                | "not_found"
                | "forbidden"
                | "confirmation_required"
                | "unsupported_format"
        ) {
            return Err(validation::invalid("只有业务终态错误可以保存为拒绝回执"));
        }
        let fingerprint = command_fingerprint(&command, caller)?;
        let mut inner = self.lock();
        if let Some(receipt) =
            existing_receipt(&inner.persisted, &command.request_id, &fingerprint)?
        {
            return Ok(receipt);
        }
        let mut next = inner.persisted.clone();
        let receipt = record_receipt(
            &mut next,
            command.request_id,
            fingerprint,
            "rejected",
            json!({"error": error}),
            (self.clock)(),
        )?;
        inner.store.commit(&inner.persisted, &next)?;
        inner.persisted = next;
        Ok(receipt)
    }

    pub fn tick(&self) -> Result<Vec<CoreEffect>, CoreError> {
        let mut inner = self.lock();
        let now = (self.clock)();
        let mut effects = inner.pending_effects.clone();
        let today = domain::today(now);
        let counts = if inner.last_count_day != today {
            reminders::counts(&inner.persisted, now)
        } else {
            (
                inner.last_counts.0,
                inner.last_counts.1,
                inner
                    .persisted
                    .reminders
                    .iter()
                    .filter(|event| reminders::active(event, now))
                    .count() as u32,
            )
        };
        let focus_due = inner.focus.running()
            && inner
                .focus
                .deadline()
                .is_some_and(|deadline| deadline <= now);
        if focus_due || inner.last_counts != counts {
            let mut next = inner.persisted.clone();
            let mut focus = inner.focus.clone();
            let completed_focus = focus.tick(&mut next.data, now);
            next.revision += 1;
            inner.store.commit(&inner.persisted, &next)?;
            inner.persisted = next;
            inner.focus = focus;
            inner.last_counts = counts;
            effects.push(CoreEffect::Changed);
            if let Some(message) = completed_focus {
                effects.push(CoreEffect::FocusCompleted(message));
            }
        }
        inner.last_count_day = today;
        inner.pending_effects.clear();
        if inner.persisted.data.settings.notifications && !inner.persisted.preferences.quiet {
            let due: Vec<_> = inner
                .persisted
                .reminders
                .iter()
                .filter(|event| {
                    reminders::active(event, now)
                        && !event.notified
                        && reminders::due_at(event)
                            .is_some_and(|at| domain::today(at) == domain::today(now))
                        && !inner.offered_reminders.contains(&offer_key(event))
                })
                .map(|event| (event.id.clone(), offer_key(event)))
                .collect();
            if !due.is_empty() {
                for (_, key) in &due {
                    inner.offered_reminders.insert(key.clone());
                }
                effects.push(CoreEffect::ReminderDue(
                    due.into_iter().map(|(id, _)| id).collect(),
                ));
            }
        }
        Ok(effects)
    }

    pub fn next_wake_ms(&self) -> Option<u64> {
        let inner = self.lock();
        let now = (self.clock)();
        let mut waits = vec![];
        if !inner.pending_effects.is_empty() {
            waits.push(0);
        }
        for event in &inner.persisted.reminders {
            if event.handled || event.invalidated {
                continue;
            }
            if let Some(due) = reminders::due_at(event) {
                if due > now {
                    waits.push((due - now).num_milliseconds().max(0) as u64);
                } else if !event.notified
                    && domain::today(due) == domain::today(now)
                    && inner.persisted.data.settings.notifications
                    && !inner.persisted.preferences.quiet
                    && !inner.offered_reminders.contains(&offer_key(event))
                {
                    waits.push(0);
                }
            }
        }
        if inner.focus.running()
            && let Some(due) = inner.focus.deadline()
        {
            waits.push((due - now).num_milliseconds().max(0) as u64);
        }
        if inner.persisted.data.tasks.iter().any(|task| {
            task.due_date.is_some() && task.completed_at.is_none() && task.deleted_at.is_none()
        }) && let Some(tomorrow) = domain::today(now)
            .succ_opt()
            .and_then(|day| day.and_hms_opt(0, 0, 0))
            .and_then(|time| Local.from_local_datetime(&time).earliest())
        {
            waits.push(
                (tomorrow.with_timezone(&Utc) - now)
                    .num_milliseconds()
                    .max(0) as u64,
            );
        }
        waits.into_iter().min()
    }

    pub fn export_backup(&self) -> Result<String, CoreError> {
        let inner = self.lock();
        let approvals: Vec<_> = inner
            .persisted
            .approvals
            .iter()
            .filter(|approval| approval.status == "pending")
            .collect();
        let mut value = json!({ "format":"dida-local-backup", "exportedAt":domain::stamp((self.clock)()), "data":inner.persisted.data });
        if !approvals.is_empty() {
            value["rustExtensions"] = json!({"version":1,"approvals":approvals,"entityVersions":inner.persisted.entity_versions});
        }
        serde_json::to_string_pretty(&value)
            .map_err(|e| CoreError::new("storage", format!("导出失败：{e}")))
    }
}

fn offer_key(event: &ReminderEvent) -> String {
    format!(
        "{}:{}",
        event.id,
        event.snoozed_until.as_ref().unwrap_or(&event.due_at)
    )
}

fn authorize(operation: &Operation, caller: Caller) -> Result<(), CoreError> {
    if caller == Caller::Agent
        && !matches!(
            operation,
            Operation::TaskCreate { .. }
                | Operation::QuickAdd { .. }
                | Operation::TaskUpdate { .. }
                | Operation::TaskTrash { .. }
        )
    {
        return Err(CoreError::new("forbidden", "该操作只能由本地用户界面执行"));
    }
    Ok(())
}

fn command_fingerprint(command: &CoreCommand, caller: Caller) -> Result<String, CoreError> {
    validation::id(&command.request_id)?;
    let normalized = normalize_operation(&command.operation)?;
    let bytes = serde_json::to_vec(&json!({"caller": if caller == Caller::Agent {"agent"} else {"local"}, "operation":normalized}))
        .map_err(|e| validation::invalid(e.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn existing_receipt(
    state: &Persisted,
    request_id: &str,
    fingerprint: &str,
) -> Result<Option<CommandReceipt>, CoreError> {
    let Some(original) = state.requests.get(request_id) else {
        return Ok(None);
    };
    if original.fingerprint != fingerprint {
        return Err(CoreError::new(
            "conflict",
            "该业务请求号已用于不同操作或参数，请保留原操作或使用新请求号",
        ));
    }
    Ok(Some(original.receipt.clone()))
}

fn record_receipt(
    state: &mut Persisted,
    request_id: String,
    fingerprint: String,
    status: &str,
    result: Value,
    now: DateTime<Utc>,
) -> Result<CommandReceipt, CoreError> {
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| CoreError::new("storage", "数据修订号已到上限"))?;
    let receipt = CommandReceipt {
        request_id: request_id.clone(),
        status: status.into(),
        revision: state.revision,
        result,
        created_at: domain::stamp(now),
    };
    state.requests.insert(
        request_id,
        RecordedRequest {
            fingerprint,
            receipt: receipt.clone(),
        },
    );
    prune_history(state, now);
    Ok(receipt)
}

fn normalize_operation(operation: &Operation) -> Result<Value, CoreError> {
    let mut value =
        serde_json::to_value(operation).map_err(|e| validation::invalid(e.to_string()))?;
    if serde_json::to_vec(&value)
        .map_err(|e| validation::invalid(e.to_string()))?
        .len()
        > import::MAX_IMPORT_BYTES + 16_384
    {
        return Err(validation::invalid("操作内容过大"));
    }
    // serde_json's ordered object keys make the fingerprint independent of input key order.
    if let Some(object) = value.as_object_mut() {
        for key in ["input", "patch"] {
            if let Some(fields) = object.get_mut(key).and_then(Value::as_object_mut) {
                for name in ["title", "name", "floatingShortcut"] {
                    if let Some(Value::String(text)) = fields.get_mut(name) {
                        *text = text.trim().into();
                    }
                }
                if let Some(Value::Array(tags)) = fields.get_mut("tags") {
                    for tag in tags {
                        if let Value::String(text) = tag {
                            *text = text.trim().into();
                        }
                    }
                }
            }
        }
    }
    Ok(canonical(value))
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted: std::collections::BTreeMap<_, _> = object.into_iter().collect();
            Value::Object(
                sorted
                    .into_iter()
                    .map(|(key, value)| (key, canonical(value)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        value => value,
    }
}

fn update_versions(previous: &Persisted, next: &mut Persisted) {
    let old: HashMap<_, _> = previous
        .data
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    for task in &next.data.tasks {
        if old
            .get(task.id.as_str())
            .is_none_or(|before| *before != task)
        {
            let version = next.entity_versions.entry(task.id.clone()).or_insert(0);
            *version += 1;
        }
    }
}

fn invalidate_approvals(state: &mut Persisted) {
    let available: HashSet<_> = state
        .data
        .tasks
        .iter()
        .filter(|task| task.deleted_at.is_none())
        .map(|task| task.id.as_str())
        .collect();
    for approval in &mut state.approvals {
        if approval.status == "pending" && !available.contains(approval.task_id.as_str()) {
            approval.status = "invalidated".into();
        }
    }
}

fn prune_history(state: &mut Persisted, now: DateTime<Utc>) {
    let cutoff = now - Duration::days(30);
    let pending_tasks: HashSet<_> = state
        .data
        .tasks
        .iter()
        .filter(|task| task.agent_status == "pending" && task.deleted_at.is_none())
        .map(|task| task.id.clone())
        .collect();
    let pending_approvals: HashSet<_> = state
        .approvals
        .iter()
        .filter(|approval| approval.status == "pending")
        .map(|approval| approval.id.clone())
        .collect();
    state.requests.retain(|_, entry| {
        DateTime::parse_from_rfc3339(&entry.receipt.created_at)
            .is_ok_and(|at| at.with_timezone(&Utc) >= cutoff)
            || entry
                .receipt
                .result
                .get("taskId")
                .and_then(Value::as_str)
                .is_some_and(|id| pending_tasks.contains(id))
            || entry
                .receipt
                .result
                .get("approvalId")
                .and_then(Value::as_str)
                .is_some_and(|id| pending_approvals.contains(id))
    });
    state.reminders.retain(|event| {
        !event.invalidated || reminders::due_at(event).is_some_and(|at| at >= cutoff)
    });
}

fn task_index(state: &Persisted, id: &str) -> Result<usize, CoreError> {
    state
        .data
        .tasks
        .iter()
        .position(|task| task.id == id)
        .ok_or_else(|| CoreError::new("not_found", "任务不存在"))
}

fn expected(state: &Persisted, id: &str, version: Option<u64>) -> Result<(), CoreError> {
    if version.is_some_and(|wanted| wanted != *state.entity_versions.get(id).unwrap_or(&0)) {
        return Err(CoreError::new(
            "conflict",
            "任务已被修改，请重新查看当前内容",
        ));
    }
    Ok(())
}

fn local_confirmation(state: &Persisted, confirmed: bool) -> Result<(), CoreError> {
    if state.preferences.confirm_purge && !confirmed {
        return Err(CoreError::new(
            "confirmation_required",
            "请在本地界面确认永久删除",
        ));
    }
    Ok(())
}

fn apply(
    state: &mut Persisted,
    focus: &mut focus::Runtime,
    operation: &Operation,
    caller: Caller,
    now: DateTime<Utc>,
) -> Result<(&'static str, Value), CoreError> {
    match operation {
        Operation::TaskCreate { input } => {
            if caller == Caller::Agent {
                validation::patch_known(&mut json!({}), input, domain::TASK_EDIT_FIELDS)?;
            }
            let mut task = domain::new_task(input.clone(), now)?;
            if state
                .data
                .tasks
                .iter()
                .any(|existing| existing.id == task.id)
            {
                return Err(CoreError::new("conflict", "任务 ID 已存在"));
            }
            task.created_by = if caller == Caller::Agent {
                "agent"
            } else {
                "user"
            }
            .into();
            task.agent_status = if caller == Caller::Agent {
                "pending"
            } else {
                "approved"
            }
            .into();
            task.completed_at = None;
            task.deleted_at = None;
            let result = json!({"taskId":task.id});
            state.data.tasks.push(task);
            Ok((
                if caller == Caller::Agent {
                    "pending"
                } else {
                    "saved"
                },
                result,
            ))
        }
        Operation::QuickAdd {
            text,
            list_id,
            date,
            overrides,
        } => {
            let list = list_id
                .as_deref()
                .unwrap_or(&state.data.settings.floating_default_list_id);
            if !state
                .data
                .lists
                .iter()
                .any(|entry| entry.id == list && !entry.archived)
            {
                return Err(validation::invalid("快速输入清单不存在或已归档"));
            }
            let mut input = domain::quick_input(text, list, domain::today(now))?;
            if input.get("dueDate").is_none() {
                let configured = date
                    .as_deref()
                    .unwrap_or(&state.data.settings.floating_default_date);
                input["dueDate"] = match configured {
                    "none" | "" => Value::Null,
                    "today" => json!(domain::date_text(domain::today(now))),
                    "tomorrow" => json!(domain::date_text(domain::today(now) + Duration::days(1))),
                    date => {
                        validation::date(date)?;
                        json!(date)
                    }
                };
            }
            if let Some(overrides) = overrides {
                let parsed_tags = input
                    .get("tags")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                validation::patch_known(&mut input, overrides, domain::TASK_EDIT_FIELDS)?;
                if let Some(override_tags) = overrides.get("tags").and_then(Value::as_array) {
                    let mut tags = vec![];
                    for tag in parsed_tags.iter().chain(override_tags) {
                        let tag = tag
                            .as_str()
                            .ok_or_else(|| validation::invalid("标签必须是文字"))?
                            .trim()
                            .to_owned();
                        if !tags.contains(&tag) {
                            tags.push(tag);
                        }
                    }
                    input["tags"] = json!(tags);
                }
            }
            apply(state, focus, &Operation::TaskCreate { input }, caller, now)
        }
        Operation::TaskUpdate {
            id,
            patch,
            expected_version,
        } => {
            let index = task_index(state, id)?;
            expected(state, id, *expected_version)?;
            if patch.as_object().is_some_and(|fields| fields.is_empty()) {
                return Err(validation::invalid("请提供要修改的字段"));
            }
            if state.data.tasks[index].deleted_at.is_some() {
                return Err(validation::invalid("请先从回收站恢复任务"));
            }
            let changed = domain::patch_task(&state.data.tasks[index], patch, now)?;
            if !state
                .data
                .lists
                .iter()
                .any(|list| list.id == changed.list_id)
            {
                return Err(validation::invalid("任务引用了不存在的清单"));
            }
            if caller == Caller::Agent {
                if state.data.tasks[index].agent_status == "pending" {
                    return Err(validation::invalid("新建任务尚待确认，请等待审核后再修改"));
                }
                let mut normalized = patch.clone();
                let normalized_task = serde_json::to_value(&changed).unwrap();
                for (key, value) in normalized
                    .as_object_mut()
                    .ok_or_else(|| validation::invalid("修改必须是对象"))?
                {
                    *value = normalized_task[key].clone();
                }
                let approval = Approval {
                    id: domain::uid(),
                    task_id: id.clone(),
                    patch: normalized,
                    base_version: *state.entity_versions.get(id).unwrap_or(&0),
                    status: "pending".into(),
                    created_at: domain::stamp(now),
                };
                let result = json!({"taskId":id,"approvalId":approval.id});
                state.approvals.push(approval);
                Ok(("pending", result))
            } else {
                state.data.tasks[index] = changed;
                Ok(("saved", json!({"taskId":id})))
            }
        }
        Operation::TaskComplete { id, completed } => {
            domain::complete_task(&mut state.data, id, *completed, now)?;
            Ok(("saved", json!({"taskId":id})))
        }
        Operation::TaskTrash { id } => {
            let index = task_index(state, id)?;
            if state.data.tasks[index].deleted_at.is_none() {
                state.data.tasks[index].deleted_at = Some(domain::stamp(now));
                state.data.tasks[index].updated_at = domain::stamp(now);
            }
            Ok(("saved", json!({"taskId":id})))
        }
        Operation::TaskRestore { id } => {
            let index = task_index(state, id)?;
            if state.data.tasks[index].deleted_at.take().is_some() {
                state.data.tasks[index].updated_at = domain::stamp(now);
            }
            Ok(("saved", json!({"taskId":id})))
        }
        Operation::TaskPurge { id, confirmed } => {
            local_confirmation(state, *confirmed)?;
            let index = task_index(state, id)?;
            if state.data.tasks[index].deleted_at.is_none() {
                return Err(validation::invalid("只能永久删除回收站中的任务"));
            }
            state.data.tasks.remove(index);
            Ok(("saved", json!({"taskId":id})))
        }
        Operation::TrashEmpty { confirmed } => {
            local_confirmation(state, *confirmed)?;
            let before = state.data.tasks.len();
            state.data.tasks.retain(|task| task.deleted_at.is_none());
            Ok(("saved", json!({"count":before-state.data.tasks.len()})))
        }
        Operation::TrashRestoreAll => {
            let mut count = 0;
            for task in &mut state.data.tasks {
                if task.deleted_at.take().is_some() {
                    count += 1;
                    task.updated_at = domain::stamp(now);
                }
            }
            Ok(("saved", json!({"count":count})))
        }
        Operation::TaskCopy { id } => {
            let mut copy = state.data.tasks[task_index(state, id)?].clone();
            copy.id = domain::uid();
            copy.completed_at = None;
            copy.deleted_at = None;
            copy.created_at = domain::stamp(now);
            copy.updated_at = domain::stamp(now);
            copy.created_by = "user".into();
            copy.agent_status = "approved".into();
            copy.recurrence_id = None;
            copy.recurrence_anchor = None;
            for sub in &mut copy.subtasks {
                sub.id = domain::uid();
            }
            let result = json!({"taskId":copy.id});
            state.data.tasks.push(copy);
            Ok(("saved", result))
        }
        Operation::TaskReorder { ids } => {
            let unique: HashSet<_> = ids.iter().collect();
            if unique.len() != ids.len() {
                return Err(validation::invalid("排序任务 ID 重复"));
            }
            for (position, id) in ids.iter().enumerate() {
                let index = task_index(state, id)?;
                state.data.tasks[index].sort_order = position as f64;
                state.data.tasks[index].updated_at = domain::stamp(now);
            }
            Ok(("saved", json!({"count":ids.len()})))
        }
        Operation::TaskMove { id, view } => move_task(state, id, view, now),
        Operation::ListMove { id, target } => {
            navigation::move_list(&mut state.data, id, target)?;
            Ok(("saved", json!({"listId":id})))
        }
        Operation::CollectionUpsert { collection, value } => {
            upsert_collection(state, collection, value)
        }
        Operation::CollectionDelete { collection, id } => {
            delete_collection(state, collection, id, now)
        }
        Operation::SettingsUpdate { patch } => {
            let mut value = serde_json::to_value(&state.data.settings).unwrap();
            validation::patch_known(
                &mut value,
                patch,
                &[
                    "theme",
                    "accent",
                    "weekStart",
                    "showCompleted",
                    "calendarMode",
                    "sidebarCollapsed",
                    "defaultView",
                    "pomodoroMinutes",
                    "breakMinutes",
                    "sound",
                    "notifications",
                    "floatingShortcut",
                    "floatingDefaultListId",
                    "floatingDefaultDate",
                    "customTags",
                ],
            )?;
            state.data.settings = serde_json::from_value(value)
                .map_err(|e| validation::invalid(format!("设置格式错误：{e}")))?;
            validation::settings(&mut state.data.settings)?;
            focus.settings_changed(&state.data);
            Ok(("saved", json!({})))
        }
        Operation::NavigationUpdate {
            preferences,
            renames,
        } => {
            navigation::apply(&mut state.data, preferences, renames, now)?;
            Ok(("saved", json!({})))
        }
        Operation::PreferencesUpdate { patch } => {
            let mut value = serde_json::to_value(&state.preferences).unwrap();
            validation::patch_known(
                &mut value,
                patch,
                &["floatingVisible", "mcpEnabled", "quiet", "confirmPurge"],
            )?;
            state.preferences = serde_json::from_value(value)
                .map_err(|e| validation::invalid(format!("偏好格式错误：{e}")))?;
            Ok(("saved", json!({})))
        }
        Operation::TagRename { from, to } => {
            let preferences = state.data.settings.navigation.clone();
            let renames = std::collections::BTreeMap::from([(format!("tag:{from}"), to.clone())]);
            navigation::apply(&mut state.data, &preferences, &renames, now)?;
            Ok((
                "saved",
                json!({"name":to.trim().trim_start_matches('#').trim()}),
            ))
        }
        Operation::TagDelete { name } => {
            state.data.settings.custom_tags.retain(|tag| tag != name);
            for task in &mut state.data.tasks {
                if task.tags.contains(name) {
                    task.tags.retain(|tag| tag != name);
                    task.updated_at = domain::stamp(now);
                }
            }
            Ok(("saved", json!({"name":name})))
        }
        Operation::HabitRecord { id, date, value } => {
            let day = validation::date(date)?;
            let habit = state
                .data
                .habits
                .iter_mut()
                .find(|habit| habit.id == *id)
                .ok_or_else(|| CoreError::new("not_found", "习惯不存在"))?;
            use chrono::Datelike;
            if !habit
                .days
                .contains(&(day.weekday().num_days_from_sunday() as u8))
            {
                return Err(validation::invalid("这一天未安排该习惯"));
            }
            if *value > habit.goal {
                return Err(validation::invalid("打卡值超过习惯目标"));
            }
            habit.records.insert(date.clone(), *value);
            Ok(("saved", json!({"habitId":id})))
        }
        Operation::Focus { action, task_id } => {
            focus.act(&mut state.data, action, task_id.as_deref(), now)?;
            Ok(("saved", json!({"focus":focus.snapshot(now)})))
        }
        Operation::Reminder { id, action } => {
            reminders::act(state, id, action, now)?;
            Ok(("saved", json!({"reminderId":id})))
        }
        Operation::AgentApprove { id } => review(state, id, true, now),
        Operation::AgentReject { id } => review(state, id, false, now),
        Operation::Import { text } => merge_import(state, text, now),
    }
}

fn move_task(
    state: &mut Persisted,
    id: &str,
    view: &str,
    now: DateTime<Utc>,
) -> Result<(&'static str, Value), CoreError> {
    if view == "completed" {
        domain::complete_task(&mut state.data, id, true, now)?;
        return Ok(("saved", json!({"taskId":id})));
    }
    let index = task_index(state, id)?;
    let task = &mut state.data.tasks[index];
    if view == "trash" {
        task.deleted_at = Some(domain::stamp(now));
    } else if view == "today" || view == "next7" {
        let today = domain::today(now);
        let current = task.due_date.as_deref().map(validation::date).transpose()?;
        let next = if view == "today" {
            today
        } else {
            current
                .filter(|date| *date > today && *date <= today + Duration::days(6))
                .unwrap_or(today + Duration::days(1))
        };
        if let (Some(start), Some(due)) = (&task.start_date, current) {
            task.start_date = Some(domain::date_text(next - (due - validation::date(start)?)));
        }
        task.due_date = Some(domain::date_text(next));
        task.deleted_at = None;
    } else if view == "inbox" {
        if task.list_id == "inbox" {
            task.start_date = None;
            task.due_date = None;
        }
        task.list_id = "inbox".into();
        task.deleted_at = None;
    } else if let Some(list) = view.strip_prefix("list:") {
        if !state
            .data
            .lists
            .iter()
            .any(|entry| entry.id == list && !entry.archived)
        {
            return Err(validation::invalid("目标清单不存在或已归档"));
        }
        task.list_id = list.into();
        task.deleted_at = None;
    } else if let Some(tag) = view.strip_prefix("tag:") {
        validation::text(tag, "标签", 1, 200)?;
        if !task.tags.iter().any(|existing| existing == tag) {
            task.tags.push(tag.into());
        }
        task.deleted_at = None;
    } else {
        return Err(validation::invalid("不支持的任务移动目标"));
    }
    task.updated_at = domain::stamp(now);
    Ok(("saved", json!({"taskId":id})))
}

fn upsert_collection(
    state: &mut Persisted,
    collection: &str,
    value: &Value,
) -> Result<(&'static str, Value), CoreError> {
    let allowed: &[&str] = match collection {
        "lists" => &["id", "name", "color", "folderId", "archived", "sortOrder"],
        "folders" => &["id", "name", "sortOrder"],
        "habits" => &[
            "id",
            "name",
            "icon",
            "color",
            "goal",
            "days",
            "records",
            "createdAt",
        ],
        "filters" => &["id", "name", "query", "color"],
        _ => {
            return Err(validation::invalid(
                "不支持的集合；不能提交整库或任意任务集合",
            ));
        }
    };
    validation::patch_known(&mut json!({}), value, allowed)?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| validation::invalid("实体缺少 ID"))?;
    validation::id(id)?;
    macro_rules! upsert {
        ($items:expr,$ty:ty) => {{
            let entity: $ty = serde_json::from_value(value.clone())
                .map_err(|e| validation::invalid(format!("实体格式错误：{e}")))?;
            if let Some(index) = $items.iter().position(|entry| entry.id == entity.id) {
                $items[index] = entity;
            } else {
                $items.push(entity);
            }
        }};
    }
    match collection {
        "lists" => {
            if id == "inbox"
                && (value.get("archived").and_then(Value::as_bool) != Some(false)
                    || !value.get("folderId").is_some_and(Value::is_null))
            {
                return Err(validation::invalid("收集箱不能归档或放入文件夹"));
            }
            let entity: TaskList = serde_json::from_value(value.clone())
                .map_err(|e| validation::invalid(format!("实体格式错误：{e}")))?;
            navigation::upsert_list(&mut state.data, entity);
        }
        "folders" => upsert!(state.data.folders, Folder),
        "habits" => upsert!(state.data.habits, Habit),
        "filters" => upsert!(state.data.filters, SavedFilter),
        _ => unreachable!(),
    }
    Ok(("saved", json!({"id":id})))
}

fn delete_collection(
    state: &mut Persisted,
    collection: &str,
    id: &str,
    now: DateTime<Utc>,
) -> Result<(&'static str, Value), CoreError> {
    match collection {
        "lists" => {
            if id == "inbox" {
                return Err(validation::invalid("不能删除收集箱"));
            }
            if !state.data.lists.iter().any(|entry| entry.id == id) {
                return Err(CoreError::new("not_found", "清单不存在"));
            }
            for task in &mut state.data.tasks {
                if task.list_id == id {
                    task.list_id = "inbox".into();
                    task.updated_at = domain::stamp(now);
                }
            }
            state.data.lists.retain(|entry| entry.id != id);
        }
        "folders" => {
            state.data.folders.retain(|entry| entry.id != id);
            for list in &mut state.data.lists {
                if list.folder_id.as_deref() == Some(id) {
                    list.folder_id = None;
                }
            }
        }
        "habits" => state.data.habits.retain(|entry| entry.id != id),
        "filters" => state.data.filters.retain(|entry| entry.id != id),
        _ => return Err(validation::invalid("不支持的集合删除")),
    }
    Ok(("saved", json!({"id":id})))
}

fn review(
    state: &mut Persisted,
    id: &str,
    approve: bool,
    now: DateTime<Utc>,
) -> Result<(&'static str, Value), CoreError> {
    if let Some(index) = state
        .approvals
        .iter()
        .position(|approval| approval.id == id)
    {
        let approval = state.approvals[index].clone();
        if approval.status == if approve { "approved" } else { "rejected" } {
            return Ok(("saved", json!({"taskId":approval.task_id,"approvalId":id})));
        }
        if approval.status != "pending" {
            return Err(CoreError::new("conflict", "该申请已经处理或失效"));
        }
        if approve {
            let index = task_index(state, &approval.task_id)?;
            if state.data.tasks[index].deleted_at.is_some() {
                return Err(CoreError::new(
                    "conflict",
                    "目标任务已删除，批准修改不会恢复任务",
                ));
            }
            expected(state, &approval.task_id, Some(approval.base_version))?;
            state.data.tasks[index] =
                domain::patch_task(&state.data.tasks[index], &approval.patch, now)?;
        }
        state.approvals[index].status = if approve { "approved" } else { "rejected" }.into();
        Ok(("saved", json!({"taskId":approval.task_id,"approvalId":id})))
    } else {
        let index = task_index(state, id)?;
        let task = &mut state.data.tasks[index];
        if task.created_by != "agent" {
            return Err(validation::invalid("该任务不是 Agent 申请"));
        }
        if task.deleted_at.is_some() {
            return Err(CoreError::new("conflict", "申请已在回收站中"));
        }
        if task.agent_status == "approved" {
            if approve {
                return Ok(("saved", json!({"taskId":id})));
            }
            return Err(CoreError::new("conflict", "任务已经获批"));
        }
        if approve {
            task.agent_status = "approved".into();
        } else {
            task.deleted_at = Some(domain::stamp(now));
        }
        task.updated_at = domain::stamp(now);
        Ok(("saved", json!({"taskId":id})))
    }
}

fn merge_import(
    state: &mut Persisted,
    text: &str,
    now: DateTime<Utc>,
) -> Result<(&'static str, Value), CoreError> {
    let incoming = import::parse(text, now)?;
    let mut warnings = incoming.warnings;
    let existing: HashSet<_> = state
        .data
        .tasks
        .iter()
        .map(|task| task.id.clone())
        .collect();
    let original_import_tasks: HashMap<_, _> = incoming
        .data
        .tasks
        .iter()
        .map(|task| (task.id.clone(), task.clone()))
        .collect();
    let count = incoming
        .data
        .tasks
        .iter()
        .filter(|task| !existing.contains(&task.id))
        .count();
    let duplicates = incoming.data.tasks.len() - count;
    if duplicates > 0 {
        warnings.push(format!(
            "{duplicates} 个已存在的任务保留本机版本，未重复导入"
        ));
    }
    macro_rules! merge {
        ($target:expr,$source:expr) => {{
            let ids: HashSet<_> = $target.iter().map(|entry| entry.id.clone()).collect();
            $target.extend($source.into_iter().filter(|entry| !ids.contains(&entry.id)));
        }};
    }
    merge!(state.data.tasks, incoming.data.tasks);
    merge!(state.data.lists, incoming.data.lists);
    merge!(state.data.folders, incoming.data.folders);
    merge!(state.data.habits, incoming.data.habits);
    merge!(state.data.filters, incoming.data.filters);
    merge!(state.data.focus_sessions, incoming.data.focus_sessions);
    for mut approval in incoming.approvals {
        if state.approvals.iter().any(|known| known.id == approval.id) {
            continue;
        }
        let Some(target) = state
            .data
            .tasks
            .iter()
            .find(|task| task.id == approval.task_id)
        else {
            warnings.push("某条审核申请缺少目标任务，已跳过".into());
            continue;
        };
        let same_content = original_import_tasks
            .get(&approval.task_id)
            .is_some_and(|original| original == target);
        let source_version = incoming.entity_versions.get(&approval.task_id);
        if same_content && source_version == Some(&approval.base_version) {
            approval.base_version = if existing.contains(&approval.task_id) {
                *state.entity_versions.get(&approval.task_id).unwrap_or(&0)
            } else {
                1
            };
        } else {
            // Imported version counters belong to another snapshot; they cannot grant approval locally.
            approval.base_version = u64::MAX;
            warnings.push(format!(
                "任务 {} 的导入修改申请需要重新提交：基准内容已变化或无法核对",
                approval.task_id
            ));
        }
        state.approvals.push(approval);
    }
    Ok(("saved", json!({"count":count,"warnings":warnings})))
}

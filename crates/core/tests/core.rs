use chrono::{DateTime, Local, TimeZone, Utc};
use ditalist_core::*;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use tempfile::TempDir;

struct Harness {
    core: CoreService,
    clock: Arc<AtomicI64>,
    dir: TempDir,
}
impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(local("2026-10-30 08:00").timestamp_millis()));
        let core = open(&dir, clock.clone());
        Self { dir, clock, core }
    }
    fn at(&self, when: &str) {
        self.clock
            .store(local(when).timestamp_millis(), Ordering::SeqCst);
    }
    fn add(&self, id: &str, input: Value) -> CommandReceipt {
        let mut input = input;
        input["id"] = json!(id);
        command(&self.core, Operation::TaskCreate { input })
    }
    fn task(&self, id: &str) -> Task {
        self.core
            .snapshot()
            .data
            .tasks
            .into_iter()
            .find(|task| task.id == id)
            .unwrap()
    }
}
fn local(value: &str) -> DateTime<Utc> {
    Local
        .from_local_datetime(
            &chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M").unwrap(),
        )
        .earliest()
        .unwrap()
        .with_timezone(&Utc)
}
fn open(dir: &TempDir, clock: Arc<AtomicI64>) -> CoreService {
    CoreService::open_with_clock(
        dir.path(),
        Arc::new(move || DateTime::from_timestamp_millis(clock.load(Ordering::SeqCst)).unwrap()),
    )
    .unwrap()
}
fn request(operation: Operation) -> CoreCommand {
    CoreCommand {
        request_id: uuid::Uuid::new_v4().to_string(),
        operation,
    }
}
fn command(core: &CoreService, operation: Operation) -> CommandReceipt {
    core.execute(request(operation), Caller::Local).unwrap()
}
fn due_ids(effects: Vec<CoreEffect>) -> Vec<String> {
    effects
        .into_iter()
        .flat_map(|effect| match effect {
            CoreEffect::ReminderDue(ids) => ids,
            _ => vec![],
        })
        .collect()
}

#[test]
fn empty_and_runtime_validation_preserve_original_state() {
    let h = Harness::new();
    assert!(h.core.snapshot().data.tasks.is_empty());
    assert_eq!(h.core.snapshot().data.lists[0].id, "inbox");
    for input in [
        json!({"title":"日期","dueDate":"2026-02-31"}),
        json!({"title":"孤立","listId":"missing"}),
        json!({"title":"重复子任务","subtasks":[{"id":"a","title":"1","completed":false},{"id":"a","title":"2","completed":false}]}),
    ] {
        assert!(
            h.core
                .execute(request(Operation::TaskCreate { input }), Caller::Local)
                .is_err()
        );
    }
    assert_eq!(h.core.snapshot().revision, 0);
    assert!(h.core.snapshot().data.tasks.is_empty());
    h.add("known", json!({"title":"正常"}));
    assert!(
        h.core
            .execute(
                request(Operation::TaskCreate {
                    input: json!({"id":"known","title":"重复"})
                }),
                Caller::Local
            )
            .is_err()
    );
    assert!(
        h.core
            .execute(
                request(Operation::TaskUpdate {
                    id: "known".into(),
                    patch: json!({"agentStatus":"approved"}),
                    expected_version: None
                }),
                Caller::Local
            )
            .is_err()
    );
    assert_eq!(h.task("known").title, "正常");
}

#[test]
fn recurring_calendar_anchors_and_subtasks_survive_completion() {
    let h = Harness::new();
    h.add("monthly",json!({"title":"月末","dueDate":"2026-01-31","startDate":"2026-01-29","repeat":"monthly","subtasks":[{"id":"old","title":"记录","completed":true}]}));
    command(
        &h.core,
        Operation::TaskComplete {
            id: "monthly".into(),
            completed: true,
        },
    );
    let next = h
        .core
        .snapshot()
        .data
        .tasks
        .into_iter()
        .find(|task| task.completed_at.is_none())
        .unwrap();
    assert_eq!(next.due_date.as_deref(), Some("2026-02-28"));
    assert_eq!(next.start_date.as_deref(), Some("2026-02-26"));
    assert_eq!(next.recurrence_anchor.as_deref(), Some("2026-01-31"));
    assert!(!next.subtasks[0].completed);
    assert_ne!(next.subtasks[0].id, "old");
    command(
        &h.core,
        Operation::TaskComplete {
            id: next.id,
            completed: true,
        },
    );
    let active = h
        .core
        .snapshot()
        .data
        .tasks
        .into_iter()
        .find(|task| task.completed_at.is_none())
        .unwrap();
    assert_eq!(active.due_date.as_deref(), Some("2026-03-31"));
    command(
        &h.core,
        Operation::TaskComplete {
            id: "monthly".into(),
            completed: true,
        },
    );
    assert_eq!(h.core.snapshot().data.tasks.len(), 3);
    h.add("leap",json!({"title":"闰年","dueDate":"2027-02-28","repeat":"yearly","recurrenceAnchor":"2024-02-29"}));
    command(
        &h.core,
        Operation::TaskComplete {
            id: "leap".into(),
            completed: true,
        },
    );
    assert!(
        h.core
            .snapshot()
            .data
            .tasks
            .iter()
            .any(|task| task.due_date.as_deref() == Some("2028-02-29"))
    );
    h.add(
        "weekday",
        json!({"title":"工作日","dueDate":"2026-10-30","repeat":"weekdays"}),
    );
    command(
        &h.core,
        Operation::TaskComplete {
            id: "weekday".into(),
            completed: true,
        },
    );
    assert!(
        h.core
            .snapshot()
            .data
            .tasks
            .iter()
            .any(|task| task.due_date.as_deref() == Some("2026-11-02"))
    );
}

#[test]
fn quick_input_is_authoritative_and_merges_explicit_tag_context() {
    let h = Harness::new();
    let receipt = command(
        &h.core,
        Operation::QuickAdd {
            text: "明天下午3点半 整理资料 #工作 !1".into(),
            list_id: None,
            date: None,
            overrides: Some(json!({"tags":["工作","团队"],"content":"表单内容"})),
        },
    );
    let task = h.task(receipt.result["taskId"].as_str().unwrap());
    assert_eq!(task.title, "整理资料");
    assert_eq!(task.due_date.as_deref(), Some("2026-10-31"));
    assert_eq!(task.time.as_deref(), Some("15:30"));
    assert_eq!(task.priority, 1);
    assert_eq!(task.tags, vec!["工作", "团队"]);
    assert_eq!(task.content, "表单内容");
    let receipt = command(
        &h.core,
        Operation::QuickAdd {
            text: "每个工作日 明天 09:20 阅读".into(),
            list_id: None,
            date: None,
            overrides: Some(json!({"dueDate":"2026-12-01","priority":2})),
        },
    );
    let task = h.task(receipt.result["taskId"].as_str().unwrap());
    assert_eq!(task.repeat, "weekdays");
    assert_eq!(task.due_date.as_deref(), Some("2026-12-01"));
    assert_eq!(task.title, "阅读");
    assert_eq!(task.priority, 2);
}

#[test]
fn json_and_csv_import_merge_without_overwriting_local_state() {
    let h = Harness::new();
    h.add("known", json!({"title":"本机修改"}));
    command(
        &h.core,
        Operation::SettingsUpdate {
            patch: json!({"theme":"dark"}),
        },
    );
    let mut backup: Value = serde_json::from_str(&h.core.export_backup().unwrap()).unwrap();
    backup["data"]["settings"]["theme"] = json!("light");
    backup["data"]["tasks"][0]["title"] = json!("旧内容");
    let mut new = backup["data"]["tasks"][0].clone();
    new["id"] = json!("new");
    backup["data"]["tasks"].as_array_mut().unwrap().push(new);
    let receipt = command(
        &h.core,
        Operation::Import {
            text: backup.to_string(),
        },
    );
    assert_eq!(receipt.result["count"], 1);
    assert_eq!(h.task("known").title, "本机修改");
    assert_eq!(h.core.snapshot().data.settings.theme, "dark");
    let csv = "Date: 2026-10-28\nList Name,Title,Content,Due Date,Priority,Status,Repeat\n工作,\"整理,资料\",\"第一行\n<script>alert(1)</script>\",2026-10-29,5,0,\n生活,已完成,说明,2026-10-27,1,2,FREQ=DAILY\n";
    assert_eq!(
        command(&h.core, Operation::Import { text: csv.into() }).result["count"],
        2
    );
    assert_eq!(
        command(&h.core, Operation::Import { text: csv.into() }).result["count"],
        0
    );
    let data = h.core.snapshot().data;
    let imported = data
        .tasks
        .iter()
        .find(|task| task.title == "整理,资料")
        .unwrap();
    assert_eq!(imported.priority, 1);
    assert_eq!(imported.content, "第一行\n<script>alert(1)</script>");
    let complex = "List Name,Title,Start Date,Due Date,Repeat\n日程,每两周开会,2026-10-29,,FREQ=WEEKLY;INTERVAL=2\n";
    let receipt = command(
        &h.core,
        Operation::Import {
            text: complex.into(),
        },
    );
    assert_eq!(receipt.result["warnings"].as_array().unwrap().len(), 1);
    let task = h
        .core
        .snapshot()
        .data
        .tasks
        .into_iter()
        .find(|task| task.title == "每两周开会")
        .unwrap();
    assert_eq!(task.repeat, "none");
    assert_eq!(task.due_date.as_deref(), Some("2026-10-29"));
    assert!(task.content.contains("FREQ=WEEKLY;INTERVAL=2"));
    let before = h.core.snapshot().revision;
    assert!(
        h.core
            .execute(
                request(Operation::Import {
                    text: "Title\n\"unterminated".into()
                }),
                Caller::Local
            )
            .is_err()
    );
    assert_eq!(h.core.snapshot().revision, before);
}

#[test]
fn same_business_request_is_atomic_across_threads_and_restart() {
    let h = Harness::new();
    let write = CoreCommand {
        request_id: "repeatable".into(),
        operation: Operation::TaskCreate {
            input: json!({"title":"只创建一次","dueDate":"2026-10-30"}),
        },
    };
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let core = h.core.clone();
            let request = write.clone();
            std::thread::spawn(move || core.execute(request, Caller::Local).unwrap())
        })
        .collect();
    let receipts: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt.result == receipts[0].result)
    );
    assert_eq!(h.core.snapshot().data.tasks.len(), 1);
    assert_eq!(h.core.snapshot().revision, 1);
    let conflict = CoreCommand {
        request_id: "repeatable".into(),
        operation: Operation::TaskCreate {
            input: json!({"title":"第二个意图"}),
        },
    };
    assert_eq!(
        h.core.execute(conflict, Caller::Local).unwrap_err().code,
        "conflict"
    );
    let Harness { dir, clock, core } = h;
    drop(core);
    let reopened = open(&dir, clock);
    assert_eq!(
        reopened.execute(write, Caller::Local).unwrap().result,
        receipts[0].result
    );
    assert_eq!(reopened.snapshot().data.tasks.len(), 1);
}

#[test]
fn normalized_request_keys_ignore_json_field_order_and_title_whitespace() {
    let h = Harness::new();
    let first: Value = serde_json::from_str("{\"title\":\" 工作 \",\"priority\":1}").unwrap();
    let second: Value = serde_json::from_str("{\"priority\":1,\"title\":\"工作\"}").unwrap();
    let a = h
        .core
        .execute(
            CoreCommand {
                request_id: "same".into(),
                operation: Operation::TaskCreate { input: first },
            },
            Caller::Local,
        )
        .unwrap();
    let b = h
        .core
        .execute(
            CoreCommand {
                request_id: "same".into(),
                operation: Operation::TaskCreate { input: second },
            },
            Caller::Local,
        )
        .unwrap();
    assert_eq!(a.result, b.result);
    assert_eq!(h.core.snapshot().data.tasks.len(), 1);
}

#[test]
fn agent_permissions_approvals_and_version_conflicts_are_enforced_in_core() {
    let h = Harness::new();
    let created=h.core.execute(request(Operation::TaskCreate{input:json!({"title":"Agent 新增","dueDate":"2026-10-30","time":"08:30","reminder":"at-time"})}),Caller::Agent).unwrap();
    let id = created.result["taskId"].as_str().unwrap().to_owned();
    assert_eq!(created.status, "pending");
    assert_eq!(h.core.snapshot().pending_count, 1);
    assert_eq!(h.core.snapshot().today_count, 0);
    assert!(h.core.snapshot().reminders.is_empty());
    command(&h.core, Operation::AgentApprove { id: id.clone() });
    assert_eq!(h.core.snapshot().today_count, 1);
    assert_eq!(h.core.snapshot().reminders.len(), 1);
    let proposed = h
        .core
        .execute(
            request(Operation::TaskUpdate {
                id: id.clone(),
                patch: json!({"title":"Agent 建议"}),
                expected_version: None,
            }),
            Caller::Agent,
        )
        .unwrap();
    let approval_id = proposed.result["approvalId"].as_str().unwrap().to_owned();
    assert_eq!(h.task(&id).title, "Agent 新增");
    command(
        &h.core,
        Operation::TaskUpdate {
            id: id.clone(),
            patch: json!({"title":"人工修改"}),
            expected_version: None,
        },
    );
    assert_eq!(
        h.core
            .execute(
                request(Operation::AgentApprove { id: approval_id }),
                Caller::Local
            )
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(h.task(&id).title, "人工修改");
    command(
        &h.core,
        Operation::PreferencesUpdate {
            patch: json!({"confirmPurge":false}),
        },
    );
    for operation in [
        Operation::TaskPurge {
            id: id.clone(),
            confirmed: true,
        },
        Operation::TrashEmpty { confirmed: true },
        Operation::AgentApprove { id: id.clone() },
        Operation::PreferencesUpdate {
            patch: json!({"mcpEnabled":true}),
        },
        Operation::TaskComplete {
            id: id.clone(),
            completed: true,
        },
    ] {
        assert_eq!(
            h.core
                .execute(request(operation), Caller::Agent)
                .unwrap_err()
                .code,
            "forbidden"
        );
    }
    h.core
        .execute(
            request(Operation::TaskTrash { id: id.clone() }),
            Caller::Agent,
        )
        .unwrap();
    assert!(h.task(&id).deleted_at.is_some());
    assert_eq!(h.core.snapshot().pending_count, 0);
    assert!(
        h.core
            .snapshot()
            .approvals
            .iter()
            .all(|approval| approval.status != "pending")
    );
    command(
        &h.core,
        Operation::TaskPurge {
            id,
            confirmed: false,
        },
    );
    assert!(h.core.snapshot().data.tasks.is_empty());
}

#[test]
fn failed_save_does_not_publish_business_or_receipt() {
    let h = Harness::new();
    std::fs::create_dir(h.dir.path().join("database.rust.json")).unwrap();
    let result = h.core.execute(
        CoreCommand {
            request_id: "failed".into(),
            operation: Operation::TaskCreate {
                input: json!({"title":"不能假保存"}),
            },
        },
        Caller::Local,
    );
    assert!(result.is_err());
    assert!(h.core.snapshot().data.tasks.is_empty());
    assert_eq!(h.core.snapshot().revision, 0);
    assert!(h.core.get_request("failed").is_none());
    std::fs::remove_dir(h.dir.path().join("database.rust.json")).unwrap();
    let success = h
        .core
        .execute(
            CoreCommand {
                request_id: "failed".into(),
                operation: Operation::TaskCreate {
                    input: json!({"title":"不能假保存"}),
                },
            },
            Caller::Local,
        )
        .unwrap();
    assert_eq!(success.status, "saved");
    assert_eq!(h.core.snapshot().data.tasks.len(), 1);
}

#[test]
fn corrupt_primary_recovers_previous_complete_snapshot_and_preserves_original() {
    let h = Harness::new();
    let receipt = h.add("a", json!({"title":"版本一"}));
    h.add("b", json!({"title":"版本二"}));
    let Harness { dir, clock, core } = h;
    drop(core);
    let main = dir.path().join("database.rust.json");
    let backup = dir.path().join("database.rust.backup.json");
    let backup_bytes = std::fs::read(&backup).unwrap();
    std::fs::write(&main, b"{broken").unwrap();
    let reopened = open(&dir, clock.clone());
    assert_eq!(reopened.snapshot().data.tasks.len(), 1);
    assert_eq!(reopened.snapshot().data.tasks[0].id, "a");
    assert_eq!(reopened.snapshot().revision, receipt.revision);
    assert_eq!(
        reopened.get_request(&receipt.request_id),
        Some(receipt.clone())
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&main).unwrap()).unwrap(),
        serde_json::from_slice::<Value>(&backup_bytes).unwrap()
    );
    drop(reopened);
    let reopened = open(&dir, clock);
    assert_eq!(reopened.snapshot().revision, receipt.revision);
    assert_eq!(reopened.get_request(&receipt.request_id), Some(receipt));
    assert_eq!(std::fs::read(&backup).unwrap(), backup_bytes);
    let corrupt: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("database.rust.corrupt-")
        })
        .collect();
    assert_eq!(corrupt.len(), 1);
    assert_eq!(std::fs::read(corrupt[0].path()).unwrap(), b"{broken");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("recovery.log"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn missing_primary_is_restored_from_backup_without_rotating_it() {
    let h = Harness::new();
    let receipt = h.add("a", json!({"title":"可恢复版本"}));
    h.add("b", json!({"title":"最新版本"}));
    let Harness { dir, clock, core } = h;
    drop(core);
    let main = dir.path().join("database.rust.json");
    let backup = dir.path().join("database.rust.backup.json");
    let bytes = std::fs::read(&backup).unwrap();
    std::fs::remove_file(&main).unwrap();
    let reopened = open(&dir, clock.clone());
    assert_eq!(reopened.snapshot().revision, receipt.revision);
    assert_eq!(
        reopened.get_request(&receipt.request_id),
        Some(receipt.clone())
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&main).unwrap()).unwrap(),
        serde_json::from_slice::<Value>(&bytes).unwrap()
    );
    drop(reopened);
    let reopened = open(&dir, clock);
    assert_eq!(reopened.get_request(&receipt.request_id), Some(receipt));
    assert_eq!(std::fs::read(&backup).unwrap(), bytes);
    assert!(
        !std::fs::read_dir(dir.path())
            .unwrap()
            .map(Result::unwrap)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("database.rust.corrupt-"))
    );
}

#[cfg(windows)]
#[test]
fn primary_recovery_refuses_open_if_atomic_replacement_is_blocked() {
    use std::os::windows::fs::OpenOptionsExt;
    let h = Harness::new();
    let receipt = h.add("a", json!({"title":"可恢复版本"}));
    h.add("b", json!({"title":"最新版本"}));
    let Harness { dir, clock, core } = h;
    drop(core);
    let main = dir.path().join("database.rust.json");
    let backup = dir.path().join("database.rust.backup.json");
    let backup_bytes = std::fs::read(&backup).unwrap();
    std::fs::write(&main, b"{broken").unwrap();
    // Permit reads/copying but deny delete-sharing, so only the final replacement fails.
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&main)
        .unwrap();
    let error = match CoreService::open(dir.path()) {
        Ok(_) => panic!("恢复写入失败时不能返回可用核心"),
        Err(error) => error,
    };
    assert_eq!(error.code, "storage");
    assert!(error.message.contains("替换任务文件失败"));
    assert_eq!(std::fs::read(&main).unwrap(), b"{broken");
    assert_eq!(std::fs::read(&backup).unwrap(), backup_bytes);
    assert!(!dir.path().join("recovery.log").exists());
    drop(held);
    let reopened = open(&dir, clock);
    assert_eq!(reopened.get_request(&receipt.request_id), Some(receipt));
    assert_eq!(std::fs::read(&backup).unwrap(), backup_bytes);
}

#[test]
fn shown_unhandled_reminder_survives_restart_without_another_popup() {
    let h = Harness::new();
    h.add(
        "task",
        json!({"title":"提醒","dueDate":"2026-10-30","time":"08:10","reminder":"5m"}),
    );
    assert_eq!(h.core.next_wake_ms(), Some(300_000));
    h.at("2026-10-30 08:05");
    let ids = due_ids(h.core.tick().unwrap());
    assert_eq!(ids.len(), 1);
    assert_eq!(h.core.snapshot().reminder_count, 1);
    command(
        &h.core,
        Operation::Reminder {
            id: ids[0].clone(),
            action: "notified".into(),
        },
    );
    let Harness { dir, clock, core } = h;
    drop(core);
    let reopened = open(&dir, clock);
    assert!(due_ids(reopened.tick().unwrap()).is_empty());
    assert_eq!(reopened.snapshot().reminder_count, 1);
    command(
        &reopened,
        Operation::Reminder {
            id: ids[0].clone(),
            action: "acknowledge".into(),
        },
    );
    assert_eq!(reopened.snapshot().reminder_count, 0);
    assert!(reopened.snapshot().data.tasks[0].completed_at.is_none());
}

#[test]
fn rescheduling_and_disabling_clear_previous_snooze_but_title_does_not() {
    let h = Harness::new();
    h.add(
        "task",
        json!({"title":"提醒","dueDate":"2026-10-30","time":"08:00","reminder":"at-time"}),
    );
    let first = h.core.snapshot().reminders[0].id.clone();
    command(
        &h.core,
        Operation::TaskUpdate {
            id: "task".into(),
            patch: json!({"title":"改标题","startDate":"2026-10-29","endTime":"09:00"}),
            expected_version: None,
        },
    );
    assert_eq!(h.core.snapshot().reminders[0].id, first);
    command(
        &h.core,
        Operation::Reminder {
            id: first.clone(),
            action: "snooze".into(),
        },
    );
    assert_eq!(h.core.snapshot().reminder_count, 0);
    command(
        &h.core,
        Operation::TaskUpdate {
            id: "task".into(),
            patch: json!({"dueDate":"2026-10-31"}),
            expected_version: None,
        },
    );
    h.at("2026-10-30 08:11");
    assert!(due_ids(h.core.tick().unwrap()).is_empty());
    assert!(
        h.core
            .snapshot()
            .reminders
            .iter()
            .find(|event| event.id == first)
            .unwrap()
            .invalidated
    );
    assert_eq!(h.core.snapshot().reminder_count, 0);
    command(
        &h.core,
        Operation::TaskUpdate {
            id: "task".into(),
            patch: json!({"reminder":"none"}),
            expected_version: None,
        },
    );
    h.at("2026-10-31 08:01");
    assert!(due_ids(h.core.tick().unwrap()).is_empty());
    assert_eq!(h.core.snapshot().reminder_count, 0);
}

#[test]
fn catchup_uses_effective_fire_day_including_advance_and_midnight_snooze() {
    let h = Harness::new();
    h.at("2026-10-30 23:55");
    h.add(
        "task",
        json!({"title":"跨午夜","dueDate":"2026-10-30","time":"23:55","reminder":"at-time"}),
    );
    let id = h.core.snapshot().reminders[0].id.clone();
    command(
        &h.core,
        Operation::Reminder {
            id: id.clone(),
            action: "snooze".into(),
        },
    );
    h.at("2026-10-31 00:06");
    let Harness { dir, clock, core } = h;
    drop(core);
    let reopened = open(&dir, clock);
    assert_eq!(due_ids(reopened.tick().unwrap()), vec![id]);
    let h = Harness::new();
    h.add(
        "tomorrow",
        json!({"title":"提前一天","dueDate":"2026-10-31","time":"08:00","reminder":"1d"}),
    );
    assert_eq!(due_ids(h.core.tick().unwrap()).len(), 1);
    h.add(
        "yesterday",
        json!({"title":"昨天漏发","dueDate":"2026-10-29","time":"08:00","reminder":"at-time"}),
    );
    assert!(due_ids(h.core.tick().unwrap()).is_empty());
}

#[test]
fn focus_continues_without_views_and_records_completion_once() {
    let h = Harness::new();
    assert!(h.core.snapshot().focus.deadline.is_none());
    assert_eq!(h.core.next_wake_ms(), None);
    command(
        &h.core,
        Operation::SettingsUpdate {
            patch: json!({"pomodoroMinutes":1}),
        },
    );
    command(
        &h.core,
        Operation::Focus {
            action: "start".into(),
            task_id: None,
        },
    );
    let initial_deadline = h.core.snapshot().focus.deadline.unwrap();
    assert_eq!(
        DateTime::parse_from_rfc3339(&initial_deadline)
            .unwrap()
            .with_timezone(&Utc),
        local("2026-10-30 08:01")
    );
    assert_eq!(h.core.next_wake_ms(), Some(60_000));
    h.clock.fetch_add(20_000, Ordering::SeqCst);
    assert_eq!(h.core.snapshot().focus.remaining_seconds, 40);
    assert_eq!(
        h.core.snapshot().focus.deadline.as_deref(),
        Some(initial_deadline.as_str())
    );
    assert_eq!(h.core.next_wake_ms(), Some(40_000));
    command(
        &h.core,
        Operation::Focus {
            action: "pause".into(),
            task_id: None,
        },
    );
    assert!(h.core.snapshot().focus.deadline.is_none());
    assert_eq!(h.core.next_wake_ms(), None);
    h.clock.fetch_add(100_000, Ordering::SeqCst);
    assert_eq!(h.core.snapshot().focus.remaining_seconds, 40);
    command(
        &h.core,
        Operation::Focus {
            action: "resume".into(),
            task_id: None,
        },
    );
    assert_eq!(
        DateTime::parse_from_rfc3339(h.core.snapshot().focus.deadline.as_deref().unwrap())
            .unwrap()
            .timestamp_millis(),
        h.clock.load(Ordering::SeqCst) + 40_000
    );
    assert_eq!(h.core.next_wake_ms(), Some(40_000));
    let running_revision = h.core.snapshot().revision;
    h.clock.fetch_add(39_999, Ordering::SeqCst);
    assert_eq!(h.core.next_wake_ms(), Some(1));
    assert!(h.core.tick().unwrap().is_empty());
    assert_eq!(h.core.snapshot().revision, running_revision);
    h.clock.fetch_add(1, Ordering::SeqCst);
    assert_eq!(h.core.next_wake_ms(), Some(0));
    assert!(
        h.core
            .tick()
            .unwrap()
            .iter()
            .any(|effect| matches!(effect, CoreEffect::FocusCompleted(_)))
    );
    assert_eq!(h.core.snapshot().data.focus_sessions.len(), 1);
    assert_eq!(
        h.core.snapshot().data.focus_sessions[0].duration_seconds,
        60
    );
    assert!(h.core.snapshot().data.focus_sessions[0].completed);
    assert!(!h.core.snapshot().focus.running);
    assert!(h.core.snapshot().focus.deadline.is_none());
    assert_eq!(h.core.next_wake_ms(), None);
    h.core.tick().unwrap();
    assert_eq!(h.core.snapshot().data.focus_sessions.len(), 1);
    command(
        &h.core,
        Operation::Focus {
            action: "start".into(),
            task_id: None,
        },
    );
    assert!(h.core.snapshot().focus.deadline.is_some());
    command(
        &h.core,
        Operation::Focus {
            action: "reset".into(),
            task_id: None,
        },
    );
    assert!(h.core.snapshot().focus.deadline.is_none());
    assert_eq!(h.core.next_wake_ms(), None);
}

#[test]
fn focus_and_reminders_schedule_only_the_next_real_deadline() {
    let h = Harness::new();
    h.add(
        "alarm",
        json!({"title":"中途提醒","dueDate":"2026-10-30","time":"08:05","reminder":"at-time"}),
    );
    command(
        &h.core,
        Operation::Focus {
            action: "start".into(),
            task_id: None,
        },
    );
    assert_eq!(h.core.next_wake_ms(), Some(300_000));
    h.clock.fetch_add(300_000, Ordering::SeqCst);
    assert_eq!(due_ids(h.core.tick().unwrap()).len(), 1);
    assert_eq!(h.core.next_wake_ms(), Some(1_200_000));
    // No views, snapshots or display ticks are needed between the two deadlines.
    h.clock.fetch_add(1_200_000, Ordering::SeqCst);
    assert!(
        h.core
            .tick()
            .unwrap()
            .iter()
            .any(|effect| matches!(effect, CoreEffect::FocusCompleted(_)))
    );
    let state = h.core.snapshot();
    assert_eq!(state.data.focus_sessions.len(), 1);
    assert_eq!(state.data.focus_sessions[0].duration_seconds, 1_500);
    assert!(state.focus.deadline.is_none());
}

#[test]
fn lists_habits_filters_and_trash_keep_business_integrity() {
    let h = Harness::new();
    command(
        &h.core,
        Operation::CollectionUpsert {
            collection: "folders".into(),
            value: json!({"id":"folder","name":"工作","sortOrder":0}),
        },
    );
    for id in ["a", "b"] {
        command(
            &h.core,
            Operation::CollectionUpsert {
                collection: "lists".into(),
                value: json!({"id":id,"name":id,"color":"#4772fa","folderId":null,"archived":false,"sortOrder":0}),
            },
        );
    }
    h.add("task", json!({"title":"任务","listId":"a"}));
    command(
        &h.core,
        Operation::ListMove {
            id: "a".into(),
            target: ListMoveTarget::Group {
                folder_id: Some("folder".into()),
            },
        },
    );
    assert_eq!(h.task("task").list_id, "a");
    assert_eq!(
        h.core
            .snapshot()
            .data
            .lists
            .iter()
            .find(|list| list.id == "a")
            .unwrap()
            .folder_id
            .as_deref(),
        Some("folder")
    );
    command(
        &h.core,
        Operation::CollectionDelete {
            collection: "folders".into(),
            id: "folder".into(),
        },
    );
    assert!(
        h.core
            .snapshot()
            .data
            .lists
            .iter()
            .find(|list| list.id == "a")
            .unwrap()
            .folder_id
            .is_none()
    );
    command(
        &h.core,
        Operation::CollectionUpsert {
            collection: "habits".into(),
            value: json!({"id":"habit","name":"喝水","icon":"💧","color":"#4772fa","goal":2,"days":[0,1,2,3,4,5,6],"records":{},"createdAt":"2026-10-30T00:00:00Z"}),
        },
    );
    command(
        &h.core,
        Operation::HabitRecord {
            id: "habit".into(),
            date: "2026-10-30".into(),
            value: 2,
        },
    );
    assert_eq!(h.core.snapshot().data.habits[0].records["2026-10-30"], 2);
    command(
        &h.core,
        Operation::CollectionUpsert {
            collection: "filters".into(),
            value: json!({"id":"filter","name":"高优先级","query":"!1 #工作","color":"#4772fa"}),
        },
    );
    assert_eq!(h.core.snapshot().data.filters.len(), 1);
    command(&h.core, Operation::TaskTrash { id: "task".into() });
    assert!(
        h.core
            .execute(
                request(Operation::TrashEmpty { confirmed: false }),
                Caller::Local
            )
            .is_err()
    );
    command(&h.core, Operation::TrashRestoreAll);
    assert!(h.task("task").deleted_at.is_none());
}

#[test]
fn ordinary_backup_contains_pending_edits_but_no_runtime_receipts_or_reminders() {
    let h = Harness::new();
    h.add("task", json!({"title":"旧标题"}));
    let receipt = h
        .core
        .execute(
            request(Operation::TaskUpdate {
                id: "task".into(),
                patch: json!({"title":"新标题"}),
                expected_version: None,
            }),
            Caller::Agent,
        )
        .unwrap();
    let backup = h.core.export_backup().unwrap();
    let value: Value = serde_json::from_str(&backup).unwrap();
    assert_eq!(value["data"]["schemaVersion"], 1);
    assert_eq!(
        value["rustExtensions"]["approvals"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(value.get("requests").is_none());
    assert!(value.get("reminders").is_none());
    let h2 = Harness::new();
    command(&h2.core, Operation::Import { text: backup });
    command(
        &h2.core,
        Operation::AgentApprove {
            id: receipt.result["approvalId"].as_str().unwrap().into(),
        },
    );
    assert_eq!(h2.task("task").title, "新标题");
}

#[test]
fn portable_approval_cannot_overwrite_a_different_local_task() {
    let source = Harness::new();
    source.add("same", json!({"title":"备份中的旧内容"}));
    let receipt = source
        .core
        .execute(
            request(Operation::TaskUpdate {
                id: "same".into(),
                patch: json!({"title":"建议"}),
                expected_version: None,
            }),
            Caller::Agent,
        )
        .unwrap();
    let target = Harness::new();
    target.add("same", json!({"title":"另一台设备的新内容"}));
    command(
        &target.core,
        Operation::Import {
            text: source.core.export_backup().unwrap(),
        },
    );
    assert_eq!(
        target
            .core
            .execute(
                request(Operation::AgentApprove {
                    id: receipt.result["approvalId"].as_str().unwrap().into()
                }),
                Caller::Local
            )
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(target.task("same").title, "另一台设备的新内容");
}

#[test]
fn receipts_keep_thirty_days_and_all_pending_dependencies() {
    let h = Harness::new();
    let local = request(Operation::TaskCreate {
        input: json!({"title":"普通任务"}),
    });
    command(
        &h.core,
        Operation::PreferencesUpdate {
            patch: json!({"quiet":true}),
        },
    );
    h.core.execute(local.clone(), Caller::Local).unwrap();
    let pending = request(Operation::TaskCreate {
        input: json!({"title":"仍待审批"}),
    });
    let receipt = h.core.execute(pending.clone(), Caller::Agent).unwrap();
    h.at("2026-11-29 08:00");
    command(
        &h.core,
        Operation::PreferencesUpdate {
            patch: json!({"quiet":false}),
        },
    );
    assert!(h.core.get_request(&local.request_id).is_some());
    h.at("2026-12-01 08:00");
    command(
        &h.core,
        Operation::PreferencesUpdate {
            patch: json!({"quiet":true}),
        },
    );
    assert!(h.core.get_request(&local.request_id).is_none());
    assert_eq!(
        h.core
            .execute(pending.clone(), Caller::Agent)
            .unwrap()
            .result,
        receipt.result
    );
    assert_eq!(h.core.snapshot().data.tasks.len(), 2);
    command(
        &h.core,
        Operation::AgentApprove {
            id: receipt.result["taskId"].as_str().unwrap().into(),
        },
    );
    assert!(h.core.get_request(&pending.request_id).is_none());
}

#[test]
fn due_focus_competing_with_a_command_is_saved_and_notified_once() {
    let h = Harness::new();
    command(
        &h.core,
        Operation::SettingsUpdate {
            patch: json!({"pomodoroMinutes":1}),
        },
    );
    command(
        &h.core,
        Operation::Focus {
            action: "start".into(),
            task_id: None,
        },
    );
    h.clock.fetch_add(70_000, Ordering::SeqCst);
    h.add("concurrent", json!({"title":"同时新增"}));
    assert_eq!(h.core.snapshot().data.focus_sessions.len(), 1);
    assert!(h.core.snapshot().data.focus_sessions[0].completed);
    assert_eq!(
        h.core
            .tick()
            .unwrap()
            .iter()
            .filter(|effect| matches!(effect, CoreEffect::FocusCompleted(_)))
            .count(),
        1
    );
    assert!(
        !h.core
            .tick()
            .unwrap()
            .iter()
            .any(|effect| matches!(effect, CoreEffect::FocusCompleted(_)))
    );
}

#[test]
fn date_boundary_updates_count_revision_and_quiet_preserves_reminders() {
    let h = Harness::new();
    h.at("2026-10-30 23:59");
    h.add(
        "tomorrow",
        json!({"title":"明天","dueDate":"2026-10-31","time":"00:00","reminder":"at-time"}),
    );
    command(
        &h.core,
        Operation::PreferencesUpdate {
            patch: json!({"quiet":true}),
        },
    );
    let revision = h.core.snapshot().revision;
    assert_eq!(h.core.next_wake_ms(), Some(60_000));
    h.at("2026-10-31 00:00");
    assert!(due_ids(h.core.tick().unwrap()).is_empty());
    let snapshot = h.core.snapshot();
    assert_eq!(snapshot.today_count, 1);
    assert_eq!(snapshot.reminder_count, 1);
    assert!(snapshot.revision > revision);
    assert!(!snapshot.reminders[0].notified);
    command(
        &h.core,
        Operation::PreferencesUpdate {
            patch: json!({"quiet":false}),
        },
    );
    assert_eq!(due_ids(h.core.tick().unwrap()).len(), 1);
}

#[test]
fn unknown_store_version_is_not_replaced_by_an_older_backup() {
    let h = Harness::new();
    h.add("a", json!({"title":"已有任务"}));
    let Harness {
        dir,
        clock: _,
        core,
    } = h;
    drop(core);
    let path = dir.path().join("database.rust.json");
    let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["schemaVersion"] = json!(3);
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(matches!(CoreService::open(dir.path()),Err(error) if error.code=="unsupported_format"));
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap()["schemaVersion"],
        3
    );
}

#[cfg(windows)]
#[test]
fn windows_data_lease_prevents_two_writers() {
    let h = Harness::new();
    assert!(matches!(CoreService::open(h.dir.path()),Err(error) if error.code=="storage"));
}

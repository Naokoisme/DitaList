//! Explicit, isolated desktop acceptance data. Never runs as part of application startup.
use chrono::{Duration, Local, Utc};
use ditalist_core::{Caller, CoreCommand, CoreService, Operation};
use serde_json::{Value, json};
use std::{env, fs, path::PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("创建验收数据失败：{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let directory = arguments.next().map(PathBuf::from).ok_or_else(|| {
        "请显式提供新的空目录：cargo run -p ditalist-core --example desktop_fixture -- <绝对目录>".to_owned()
    })?;
    if arguments.next().is_some() || !directory.is_absolute() {
        return Err("只接受一个新的空目录绝对路径，没有默认数据路径".into());
    }
    if directory.join("database.rust.json").exists() {
        return Err("目标目录已有数据库，拒绝覆盖或写入".into());
    }
    if directory.exists() {
        let metadata = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("目标必须是普通空目录".into());
        }
        if fs::read_dir(&directory)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Err("目标目录非空，拒绝写入".into());
        }
    } else {
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    }

    let core = CoreService::open(&directory).map_err(|e| e.message)?;
    let execute = |operation| -> Result<(), String> {
        core.execute(
            CoreCommand {
                request_id: uuid::Uuid::new_v4().to_string(),
                operation,
            },
            Caller::Local,
        )
        .map(|_| ())
        .map_err(|e| format!("{}：{}", e.code, e.message))
    };
    let collection = |collection: &str, value: Value| {
        execute(Operation::CollectionUpsert {
            collection: collection.into(),
            value,
        })
    };
    collection(
        "folders",
        json!({"id":"acceptance-folder","name":"验收 · 工作分组","sortOrder":0}),
    )?;
    collection(
        "lists",
        json!({"id":"acceptance-work","name":"验收 · 工作清单","color":"#4772FA","folderId":"acceptance-folder","archived":false,"sortOrder":0}),
    )?;
    collection(
        "lists",
        json!({"id":"acceptance-personal","name":"验收 · 生活清单","color":"#10B981","folderId":null,"archived":false,"sortOrder":1}),
    )?;

    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let tomorrow = (now.date_naive() + Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    execute(Operation::TaskCreate {
        input: json!({
            "id":"acceptance-today", "title":"验收 · 今天的工作任务", "content":"用于真实生产界面验收；请检查标签、子任务和清单归属。",
            "listId":"acceptance-work", "dueDate":today, "priority":1, "tags":["验收","工作"],
            "subtasks":[{"id":"acceptance-subtask-1","title":"验收 · 打开任务详情","completed":false},{"id":"acceptance-subtask-2","title":"验收 · 检查已完成子任务","completed":true}]
        }),
    })?;
    execute(Operation::TaskCreate {
        input: json!({"id":"acceptance-tomorrow","title":"验收 · 明天的生活任务","listId":"acceptance-personal","dueDate":tomorrow,"tags":["验收","生活"]}),
    })?;

    let previous_minute = now - Duration::minutes(1);
    // At 00:00, midnight is the earliest already-due time that still belongs to today.
    let reminder_time = if previous_minute.date_naive() == now.date_naive() {
        previous_minute.format("%H:%M").to_string()
    } else {
        "00:00".into()
    };
    execute(Operation::TaskCreate {
        input: json!({"id":"acceptance-reminder","title":"验收 · 已到期提醒","content":"由真实桌面展示成功后记录 notified，fixture 不代替展示回执。","listId":"acceptance-work","dueDate":today,"time":reminder_time,"reminder":"at-time","tags":["验收"]}),
    })?;
    collection(
        "habits",
        json!({"id":"acceptance-habit","name":"验收 · 每天喝水","icon":"💧","color":"#4772FA","goal":2,"days":[0,1,2,3,4,5,6],"records":{},"createdAt":Utc::now().to_rfc3339()}),
    )?;
    collection(
        "filters",
        json!({"id":"acceptance-filter","name":"验收 · 工作筛选","query":"#验收 #工作","color":"#4772FA"}),
    )?;
    execute(Operation::SettingsUpdate {
        patch: json!({"pomodoroMinutes":1,"breakMinutes":1,"notifications":true,"customTags":["验收","工作","生活"]}),
    })?;
    execute(Operation::PreferencesUpdate {
        patch: json!({"mcpEnabled":true,"quiet":false,"floatingVisible":true}),
    })?;

    let snapshot = core.snapshot();
    if snapshot
        .reminders
        .iter()
        .any(|event| event.notified || event.handled)
    {
        return Err("验收提醒意外被处理".into());
    }
    println!("{}", serde_json::to_string_pretty(&json!({
        "dataPath":directory.canonicalize().map_err(|e| e.to_string())?,
        "taskCount":snapshot.data.tasks.len(),
        "reminderEvents":snapshot.reminders.iter().map(|event| json!({"id":event.id,"dueAt":event.due_at,"notified":event.notified,"handled":event.handled})).collect::<Vec<_>>(),
        "note":"验收数据已保存；尚未启动桌面程序，提醒展示回执待真实桌面验证。"
    })).map_err(|e| e.to_string())?);
    Ok(())
}

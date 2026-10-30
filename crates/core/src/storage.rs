use crate::{domain, validation};
use ditalist_contracts::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) const DATABASE: &str = "database.rust.json";
pub(crate) const BACKUP: &str = "database.rust.backup.json";
const MAX_STORE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordedRequest {
    pub fingerprint: String,
    pub receipt: CommandReceipt,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Persisted {
    pub format: String,
    pub schema_version: u8,
    pub revision: u64,
    pub data: AppData,
    pub entity_versions: BTreeMap<String, u64>,
    pub approvals: Vec<Approval>,
    pub reminders: Vec<ReminderEvent>,
    pub preferences: Preferences,
    pub requests: BTreeMap<String, RecordedRequest>,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            format: "ditalist-rust-store".into(),
            schema_version: 2,
            revision: 0,
            data: domain::empty_data(),
            entity_versions: BTreeMap::new(),
            approvals: vec![],
            reminders: vec![],
            preferences: Preferences::default(),
            requests: BTreeMap::new(),
        }
    }
}

pub(crate) struct Store {
    pub directory: PathBuf,
    // Windows sharing restrictions release automatically when the process exits.
    _lease: File,
}

fn io_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new("storage", format!("{context}：{error}"))
}

impl Store {
    pub fn open(directory: &Path) -> Result<(Self, Persisted), CoreError> {
        fs::create_dir_all(directory).map_err(|e| io_error("无法创建隔离数据目录", e))?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let lease = options
            .open(directory.join("database.rust.lock"))
            .map_err(|e| io_error("数据目录正在使用或无法锁定", e))?;
        let store = Self {
            directory: directory.to_path_buf(),
            _lease: lease,
        };
        let main = store.directory.join(DATABASE);
        let backup = store.directory.join(BACKUP);
        let loaded = match read_document(&main) {
            Ok(state) => state,
            Err(error) if error.code == "missing" => match read_document(&backup) {
                Ok(state) => restore_primary(&main, state)?,
                Err(error) if error.code == "missing" => Persisted::default(),
                Err(error) => {
                    return Err(io_error("主数据不存在且备份无法恢复，已停止写入", error));
                }
            },
            Err(error) if error.code == "unsupported_format" => return Err(error),
            Err(original_error) => {
                let state = read_document(&backup).map_err(|error| {
                    io_error(
                        "主数据与备份均无法读取，已停止写入以保护原数据",
                        format!("{original_error}; {error}"),
                    )
                })?;
                let saved = store
                    .directory
                    .join(format!("database.rust.corrupt-{}.json", domain::uid()));
                fs::copy(&main, &saved).map_err(|e| io_error("无法保全损坏原件，已停止恢复", e))?;
                OpenOptions::new()
                    .write(true)
                    .open(&saved)
                    .and_then(|file| file.sync_all())
                    .map_err(|e| io_error("无法同步损坏原件，已停止恢复", e))?;
                let state = restore_primary(&main, state)?;
                let mut log = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(store.directory.join("recovery.log"))
                    .map_err(|e| io_error("无法记录恢复信息", e))?;
                writeln!(
                    log,
                    "{} 从有效备份恢复；损坏原件 {}",
                    domain::stamp(chrono::Utc::now()),
                    saved.display()
                )
                .map_err(|e| io_error("无法记录恢复信息", e))?;
                state
            }
        };
        Ok((store, loaded))
    }

    pub fn commit(&self, previous: &Persisted, next: &Persisted) -> Result<(), CoreError> {
        let bytes = serde_json::to_vec(next).map_err(|e| io_error("无法序列化任务库", e))?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(io_error(
                "任务库过大",
                "完整快照超过 128 MB，请导出并整理历史数据",
            ));
        }
        let backup = serde_json::to_vec(previous).map_err(|e| io_error("无法序列化备份", e))?;
        atomic_write(&self.directory.join(BACKUP), &backup)?;
        atomic_write(&self.directory.join(DATABASE), &bytes)
    }
}

fn restore_primary(path: &Path, state: Persisted) -> Result<Persisted, CoreError> {
    let bytes = serde_json::to_vec(&state).map_err(|e| io_error("无法序列化恢复数据", e))?;
    if bytes.len() as u64 > MAX_STORE_BYTES {
        return Err(io_error("恢复数据过大", "完整快照超过 128 MB"));
    }
    // Recovery keeps the verified backup and its revision/receipts intact.
    // Return a usable service only after the primary has been replaced durably.
    atomic_write(path, &bytes)?;
    Ok(state)
}

fn read_document(path: &Path) -> Result<Persisted, CoreError> {
    let metadata = fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CoreError::new("missing", "文件不存在")
        } else {
            io_error("无法读取任务库信息", e)
        }
    })?;
    if metadata.len() > MAX_STORE_BYTES {
        return Err(io_error("任务库过大", "文件超过 128 MB"));
    }
    let bytes = fs::read(path).map_err(|e| io_error("无法读取任务库", e))?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| io_error("任务库 JSON 无法解析", e))?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || value.get("format").and_then(Value::as_str) != Some("ditalist-rust-store")
    {
        return Err(CoreError::new(
            "unsupported_format",
            "不支持的 Rust 数据格式；旧版数据请通过导入入口迁移",
        ));
    }
    let mut state: Persisted =
        serde_json::from_value(value).map_err(|e| io_error("任务库格式无效", e))?;
    validation::app(&mut state.data)?;
    let mut ids = std::collections::HashSet::new();
    for approval in &state.approvals {
        validation::id(&approval.id)?;
        validation::id(&approval.task_id)?;
        validation::timestamp(&approval.created_at)?;
        if !ids.insert(&approval.id)
            || !["pending", "approved", "rejected", "invalidated"]
                .contains(&approval.status.as_str())
        {
            return Err(validation::invalid("审核记录无效"));
        }
        validation::patch_known(
            &mut serde_json::json!({}),
            &approval.patch,
            domain::TASK_EDIT_FIELDS,
        )?;
    }
    ids.clear();
    for reminder in &state.reminders {
        validation::id(&reminder.id)?;
        validation::id(&reminder.task_id)?;
        validation::timestamp(&reminder.due_at)?;
        if !ids.insert(&reminder.id) {
            return Err(validation::invalid("重复提醒 ID"));
        }
        if let Some(time) = &reminder.snoozed_until {
            validation::timestamp(time)?;
        }
    }
    for (key, request) in &state.requests {
        validation::id(key)?;
        validation::timestamp(&request.receipt.created_at)?;
        if *key != request.receipt.request_id || request.fingerprint.len() != 64 {
            return Err(validation::invalid("业务回执记录无效"));
        }
    }
    Ok(state)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    let temporary = path.with_extension(format!("{}.tmp", domain::uid()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| io_error("无法创建保存临时文件", e))?;
        file.write_all(bytes)
            .map_err(|e| io_error("写入任务数据失败", e))?;
        file.sync_all()
            .map_err(|e| io_error("同步任务数据失败", e))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|e| io_error("替换任务文件失败", e))?;
        #[cfg(unix)]
        {
            File::open(path.parent().unwrap())
                .and_then(|file| file.sync_all())
                .map_err(|e| io_error("同步数据目录失败", e))?;
        }
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

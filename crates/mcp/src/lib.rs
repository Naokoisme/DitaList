//! Private local transport. Only the stdio binary speaks public MCP.
use ditalist_contracts::{Caller, CoreCommand, CoreError, McpInfo, Operation};
use ditalist_core::CoreService;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};

pub const APPLICATION: &str = "ditalist-rust-preview";
const MAX_FRAME: usize = 32 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contact {
    pub format_version: u32,
    pub application: String,
    pub instance: String,
    pub address: String,
    pub token: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalRequest {
    pub instance: String,
    pub token: String,
    pub method: String,
    pub params: Value,
}
#[derive(Serialize, Deserialize)]
pub struct LocalResponse {
    pub application: String,
    pub instance: String,
    pub result: Option<Value>,
    pub error: Option<CoreError>,
}

pub fn default_data_dir() -> PathBuf {
    std::env::var_os("DITALIST_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("APPDATA").unwrap_or_else(|| ".".into()))
                .join("DitaListRustPreview/data")
        })
}
pub fn contact_path(data_dir: &Path) -> PathBuf {
    data_dir.join("mcp/contact.json")
}
fn failure(code: &str, message: impl Into<String>) -> CoreError {
    CoreError::new(code, message)
}

pub async fn read_frame<T: serde::de::DeserializeOwned>(
    stream: &mut TcpStream,
) -> Result<T, CoreError> {
    let size = stream
        .read_u32()
        .await
        .map_err(|e| failure("connection", e.to_string()))? as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(failure("invalid_input", "本地消息大小超出限制"));
    }
    let mut bytes = vec![0; size];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|e| failure("connection", e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|e| failure("invalid_input", e.to_string()))
}
pub async fn write_frame<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<(), CoreError> {
    let bytes = serde_json::to_vec(value).map_err(|e| failure("invalid_input", e.to_string()))?;
    if bytes.len() > MAX_FRAME {
        return Err(failure("invalid_input", "本地消息大小超出限制"));
    }
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|e| failure("connection", e.to_string()))?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|e| failure("connection", e.to_string()))
}

fn protect_directory(path: &Path) -> Result<(), CoreError> {
    std::fs::create_dir_all(path).map_err(|e| failure("storage", e.to_string()))?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let account = format!(
            "{}\\{}",
            std::env::var("USERDOMAIN").unwrap_or_else(|_| ".".into()),
            std::env::var("USERNAME").map_err(|_| failure("storage", "缺少当前用户身份"))?
        );
        let status = std::process::Command::new("icacls.exe")
            .arg(path)
            .args([
                "/inheritance:r",
                "/grant:r",
                &format!("{account}:(OI)(CI)F"),
            ])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| failure("storage", e.to_string()))?;
        if !status.status.success() {
            return Err(failure("storage", "无法限制 MCP 联系文件的用户权限"));
        }
    }
    Ok(())
}

struct Shared {
    core: CoreService,
    path: PathBuf,
    contact: Mutex<Option<Contact>>,
    state: Mutex<String>,
    accepted: AtomicUsize,
    drained: Notify,
    listener: Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            tokio::task::JoinHandle<()>,
        )>,
    >,
    failed: Mutex<BTreeMap<String, (String, Value)>>,
    changed: Arc<dyn Fn() + Send + Sync>,
    status: Arc<dyn Fn(McpInfo) + Send + Sync>,
}
#[derive(Clone)]
pub struct Gateway {
    shared: Arc<Shared>,
    transition: Arc<tokio::sync::Mutex<()>>,
}
impl Gateway {
    pub fn new(
        core: CoreService,
        data_dir: &Path,
        changed: Arc<dyn Fn() + Send + Sync>,
        status: Arc<dyn Fn(McpInfo) + Send + Sync>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                core,
                path: contact_path(data_dir),
                contact: Mutex::new(None),
                state: Mutex::new("closed".into()),
                accepted: AtomicUsize::new(0),
                drained: Notify::new(),
                listener: Mutex::new(None),
                failed: Mutex::new(BTreeMap::new()),
                changed,
                status,
            }),
            transition: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
    pub fn info(&self) -> McpInfo {
        info(&self.shared)
    }
    pub fn mark_error(&self) {
        let mut state = self.shared.state.lock().unwrap();
        if *state != "closing" {
            *state = "error".into();
        }
        drop(state);
        (self.shared.status)(self.info());
    }
    pub async fn set_enabled(&self, enabled: bool) -> Result<McpInfo, CoreError> {
        let _transition = self.transition.lock().await;
        if enabled {
            if *self.shared.state.lock().unwrap() == "open" {
                return Ok(self.info());
            }
            if *self.shared.state.lock().unwrap() == "closing" {
                return Err(failure("closing", "MCP 正在关闭，请先处理保存错误"));
            }
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| failure("connection", e.to_string()))?;
            let address = listener
                .local_addr()
                .map_err(|e| failure("connection", e.to_string()))?
                .to_string();
            let contact = Contact {
                format_version: 1,
                application: APPLICATION.into(),
                instance: uuid::Uuid::new_v4().to_string(),
                address,
                token: format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
            };
            protect_directory(self.shared.path.parent().unwrap())?;
            let tmp = self.shared.path.with_extension("tmp");
            std::fs::write(&tmp, serde_json::to_vec(&contact).unwrap())
                .map_err(|e| failure("storage", e.to_string()))?;
            std::fs::rename(&tmp, &self.shared.path)
                .map_err(|e| failure("storage", e.to_string()))?;
            *self.shared.contact.lock().unwrap() = Some(contact);
            *self.shared.state.lock().unwrap() = "open".into();
            let shared = self.shared.clone();
            let (stop, mut stopped) = tokio::sync::oneshot::channel();
            let listener_task = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        _=&mut stopped=>break,
                        _=connections.join_next(),if !connections.is_empty()=>{},
                        accepted=listener.accept()=>match accepted {
                            Ok((stream,peer)) if peer.ip().is_loopback()=> { let state=shared.clone(); connections.spawn(async move { serve_connection(stream,state).await; }); },
                            Ok(_)=>{}, Err(_)=>break,
                        }
                    }
                }
                // The close gate has already drained admitted business operations.
                connections.shutdown().await;
            });
            *self.shared.listener.lock().unwrap() = Some((stop, listener_task));
        } else {
            if *self.shared.state.lock().unwrap() == "closed" {
                return Ok(self.info());
            }
            // This mutex is also the admission gate. No new operation crosses it after closing.
            *self.shared.state.lock().unwrap() = "closing".into();
            (self.shared.status)(self.info());
            loop {
                let notified = self.shared.drained.notified();
                if self.shared.accepted.load(Ordering::SeqCst) == 0 {
                    break;
                }
                notified.await;
            }
            let pending = self.shared.failed.lock().unwrap().clone();
            for (request_id, (method, params)) in pending {
                let core = self.shared.core.clone();
                let result = tokio::task::spawn_blocking(move || {
                    match dispatch(&core, &method, params.clone()) {
                        Err(error)
                            if matches!(
                                error.code.as_str(),
                                "conflict"
                                    | "invalid_input"
                                    | "not_found"
                                    | "forbidden"
                                    | "confirmation_required"
                                    | "unsupported_format"
                            ) =>
                        {
                            serde_json::to_value(core.settle_rejected(
                                write_command(&method, &params)?,
                                Caller::Agent,
                                error,
                            )?)
                            .map_err(|e| failure("internal", e.to_string()))
                        }
                        result => result,
                    }
                })
                .await
                .map_err(|e| failure("internal", e.to_string()))?;
                if let Err(error) = result {
                    (self.shared.status)(self.info());
                    return Err(failure(
                        "storage",
                        format!(
                            "MCP 请求 {request_id} 尚未保存：{}。修复后重试关闭。",
                            error.message
                        ),
                    ));
                }
                self.shared.failed.lock().unwrap().remove(&request_id);
                (self.shared.changed)();
            }
            let listener = self.shared.listener.lock().unwrap().take();
            if let Some((stop, task)) = listener {
                let _ = stop.send(());
                let _ = task.await;
            }
            let owned = self.shared.contact.lock().unwrap().take();
            if let Some(contact) = owned
                && let Ok(bytes) = std::fs::read(&self.shared.path)
                && let Ok(current) = serde_json::from_slice::<Contact>(&bytes)
                && current.instance == contact.instance
            {
                let _ = std::fs::remove_file(&self.shared.path);
            }
            *self.shared.state.lock().unwrap() = "closed".into();
        }
        let info = self.info();
        (self.shared.status)(info.clone());
        Ok(info)
    }
}
fn info(shared: &Shared) -> McpInfo {
    let exe = std::env::current_exe().unwrap_or_default();
    let command = exe
        .parent()
        .unwrap_or(Path::new("."))
        .join("ditalist-mcp.exe")
        .to_string_lossy()
        .into_owned();
    let mut state = shared.state.lock().unwrap().clone();
    if state == "closing"
        && shared.accepted.load(Ordering::SeqCst) == 0
        && !shared.failed.lock().unwrap().is_empty()
    {
        state = "closing_failed".into();
    }
    McpInfo {
        state,
        command,
        args: vec![
            "--contact".into(),
            shared.path.to_string_lossy().into_owned(),
        ],
        contact_path: shared.path.to_string_lossy().into_owned(),
        address: shared
            .contact
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.address.clone()),
    }
}
async fn serve_connection(mut stream: TcpStream, shared: Arc<Shared>) {
    let request = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        read_frame::<LocalRequest>(&mut stream),
    )
    .await
    {
        Ok(Ok(request)) => request,
        _ => return,
    };
    let write_request = matches!(
        request.method.as_str(),
        "tasks.create" | "tasks.update" | "tasks.delete"
    );
    let write_id = write_request
        .then(|| {
            request
                .params
                .get("requestId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .flatten();
    // Identity validation and admission share the same gate as closing/reopening.
    let (contact, admission) = {
        let state = shared.state.lock().unwrap();
        let contact = match shared.contact.lock().unwrap().clone() {
            Some(c) => c,
            None => return,
        };
        let admission = if request.instance != contact.instance || request.token != contact.token {
            Err(failure(
                "identity",
                "连接身份已过期或凭据不正确，请重新读取联系地址",
            ))
        } else if *state != "open" {
            Err(failure("closing", "MCP 通道正在关闭或已关闭"))
        } else {
            let mut pending = shared.failed.lock().unwrap();
            let conflict = write_id
                .as_ref()
                .and_then(|id| pending.get(id))
                .is_some_and(|(method, params)| {
                    method != &request.method || params != &request.params
                });
            if conflict {
                Err(failure(
                    "conflict",
                    "同一业务请求号正在处理或尚未保存，不能更改参数",
                ))
            } else {
                if let Some(id) = &write_id {
                    pending
                        .entry(id.clone())
                        .or_insert((request.method.clone(), request.params.clone()));
                }
                shared.accepted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        };
        (contact, admission)
    };
    let result = match admission {
        Err(error) => Err(error),
        Ok(()) => {
            let core = shared.core.clone();
            let result = tokio::task::spawn_blocking(move || {
                dispatch(&core, &request.method, request.params)
            })
            .await
            .unwrap_or_else(|_| Err(failure("internal", "操作线程意外结束，请查询原请求号")));
            if let Some(id) = write_id {
                match &result {
                    Err(error) if error.code == "storage" || error.code == "internal" => {}
                    _ => {
                        shared.failed.lock().unwrap().remove(&id);
                    }
                }
            }
            (shared.changed)();
            shared.accepted.fetch_sub(1, Ordering::SeqCst);
            shared.drained.notify_one();
            result
        }
    };
    let response = match result {
        Ok(value) => LocalResponse {
            application: APPLICATION.into(),
            instance: contact.instance,
            result: Some(value),
            error: None,
        },
        Err(error) => LocalResponse {
            application: APPLICATION.into(),
            instance: contact.instance,
            result: None,
            error: Some(error),
        },
    };
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        write_frame(&mut stream, &response),
    )
    .await;
}
fn string_arg<'a>(params: &'a Value, key: &str) -> Result<&'a str, CoreError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| failure("invalid_input", format!("缺少 {key}")))
}
fn write_command(method: &str, params: &Value) -> Result<CoreCommand, CoreError> {
    let request_id = string_arg(params, "requestId")?.to_owned();
    let operation = match method {
        "tasks.create" => {
            let mut input = params.clone();
            input
                .as_object_mut()
                .ok_or_else(|| failure("invalid_input", "参数必须是对象"))?
                .remove("requestId");
            Operation::TaskCreate { input }
        }
        "tasks.update" => Operation::TaskUpdate {
            id: string_arg(params, "id")?.into(),
            patch: params
                .get("patch")
                .cloned()
                .ok_or_else(|| failure("invalid_input", "缺少 patch"))?,
            expected_version: params.get("expectedVersion").and_then(Value::as_u64),
        },
        "tasks.delete" => Operation::TaskTrash {
            id: string_arg(params, "id")?.into(),
        },
        _ => return Err(failure("forbidden", "MCP 不支持该写操作")),
    };
    Ok(CoreCommand {
        request_id,
        operation,
    })
}
pub fn dispatch(core: &CoreService, method: &str, params: Value) -> Result<Value, CoreError> {
    match method {
        "tasks.list" => {
            let snapshot = core.snapshot();
            let query = params
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let deleted = params
                .get("includeDeleted")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let tasks: Vec<_> = snapshot
                .data
                .tasks
                .into_iter()
                .filter(|t| {
                    (deleted || t.deleted_at.is_none())
                        && (query.is_empty()
                            || format!("{} {} {}", t.title, t.content, t.tags.join(" "))
                                .to_lowercase()
                                .contains(&query))
                })
                .collect();
            Ok(json!({"tasks":tasks,"lists":snapshot.data.lists}))
        }
        "tasks.get" => {
            let id = string_arg(&params, "id")?;
            let snapshot = core.snapshot();
            let task = snapshot
                .data
                .tasks
                .iter()
                .find(|t| t.id == id)
                .ok_or_else(|| failure("not_found", "任务不存在"))?;
            Ok(
                json!({"task":task,"version":snapshot.entity_versions.get(id).copied().unwrap_or(0)}),
            )
        }
        "requests.get" => {
            let id = string_arg(&params, "requestId")?;
            Ok(match core.get_request(id) {
                Some(receipt) => {
                    let snapshot = core.snapshot();
                    let approval_status = receipt
                        .result
                        .get("approvalId")
                        .and_then(Value::as_str)
                        .and_then(|id| snapshot.approvals.iter().find(|a| a.id == id))
                        .map(|a| a.status.clone())
                        .or_else(|| {
                            receipt
                                .result
                                .get("taskId")
                                .and_then(Value::as_str)
                                .and_then(|id| snapshot.data.tasks.iter().find(|t| t.id == id))
                                .map(|t| {
                                    if t.deleted_at.is_some() {
                                        "trashed".into()
                                    } else {
                                        t.agent_status.clone()
                                    }
                                })
                        });
                    json!({"status":"known","receipt":receipt,"approvalStatus":approval_status})
                }
                None => {
                    json!({"status":"unknown","message":"请求结果不可核对；不要更换编号自动重试。"})
                }
            })
        }
        "tasks.create" | "tasks.update" | "tasks.delete" => {
            serde_json::to_value(core.execute(write_command(method, &params)?, Caller::Agent)?)
                .map_err(|e| failure("internal", e.to_string()))
        }
        _ => Err(failure("forbidden", "MCP 不支持该操作")),
    }
}

/// Each call re-reads discovery. Transport failure never invents another business ID.
pub async fn call(contact_file: &Path, method: &str, params: Value) -> Result<Value, CoreError> {
    let bytes = std::fs::read(contact_file)
        .map_err(|_| failure("disabled", "请启动 DitaList，并由用户在设置中开启 MCP 通道"))?;
    let contact: Contact =
        serde_json::from_slice(&bytes).map_err(|_| failure("identity", "联系文件格式无效"))?;
    if contact.application != APPLICATION || contact.format_version != 1 {
        return Err(failure("identity", "联系文件属于不同应用或协议"));
    }
    let address: std::net::SocketAddr = contact
        .address
        .parse()
        .map_err(|_| failure("identity", "本地联系地址无效"))?;
    if !address.ip().is_loopback() {
        return Err(failure("identity", "只允许连接本机回环地址"));
    }
    let operation = async {
        let mut stream = TcpStream::connect(address).await.map_err(|e| {
            failure(
                "connection",
                format!("连接失败：{e}；请查询原请求结果，不要更换业务号"),
            )
        })?;
        write_frame(
            &mut stream,
            &LocalRequest {
                instance: contact.instance.clone(),
                token: contact.token,
                method: method.into(),
                params,
            },
        )
        .await?;
        let response: LocalResponse = read_frame(&mut stream).await?;
        if response.application != APPLICATION || response.instance != contact.instance {
            return Err(failure("identity", "返回实例身份不匹配"));
        }
        if let Some(error) = response.error {
            return Err(error);
        }
        response
            .result
            .ok_or_else(|| failure("connection", "缺少操作结果，请查询原请求号"))
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), operation)
        .await
        .map_err(|_| {
            failure(
                "timeout",
                "操作结果不明确，请使用原请求号查询；不要重新创建",
            )
        })?
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod desktop;
use desktop::{Desktop, DesktopAction};
use ditalist_contracts::*;
use ditalist_core::CoreService;
use ditalist_mcp::{Gateway, default_data_dir};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct Host {
    core: CoreService,
    desktop: Arc<Desktop>,
    gateway: Gateway,
    draft: Mutex<QuickDraft>,
    wake: Arc<tokio::sync::Notify>,
    exiting: AtomicBool,
    data_dir: PathBuf,
    local: Arc<LocalBarrier>,
    quitting: AtomicBool,
    handoff: ExitHandoff,
}

#[derive(Default)]
struct LocalProgress {
    closing: bool,
    active: usize,
    closing_error: Option<String>,
}
#[derive(Default)]
struct LocalBarrier {
    progress: Mutex<LocalProgress>,
    changed: tokio::sync::Notify,
}
struct LocalSubmission {
    barrier: Arc<LocalBarrier>,
    request_id: String,
    finished: bool,
}
#[derive(Default)]
struct ExitHandoff {
    responses: Mutex<BTreeMap<String, Option<bool>>>,
    changed: tokio::sync::Notify,
}
impl LocalBarrier {
    fn admit(self: &Arc<Self>, request_id: String) -> Result<LocalSubmission, CoreError> {
        let mut progress = self.progress.lock().unwrap();
        if progress.closing {
            return Err(CoreError::new("closing", "应用正在退出，请等待保存收尾"));
        }
        progress.active += 1;
        Ok(LocalSubmission {
            barrier: self.clone(),
            request_id,
            finished: false,
        })
    }
    fn reopen(&self) {
        let mut progress = self.progress.lock().unwrap();
        progress.closing = false;
        progress.closing_error = None;
    }
    async fn close_and_drain(&self) -> Result<(), CoreError> {
        self.progress.lock().unwrap().closing = true;
        loop {
            let changed = self.changed.notified();
            {
                let progress = self.progress.lock().unwrap();
                if progress.active == 0 {
                    if let Some(error) = &progress.closing_error {
                        return Err(CoreError::new(
                            "storage",
                            format!("退出期间保存失败，请先重试：{error}"),
                        ));
                    }
                    return Ok(());
                }
            }
            changed.await;
        }
    }
}
impl LocalSubmission {
    fn finish(mut self, result: &Result<CommandReceipt, CoreError>) {
        let mut progress = self.barrier.progress.lock().unwrap();
        if progress.closing
            && let Err(error) = result
            && error.code == "storage"
        {
            progress.closing_error = Some(format!("{}: {}", self.request_id, error.message));
        }
        self.finished = true;
    }
}
impl Drop for LocalSubmission {
    fn drop(&mut self) {
        let mut progress = self.barrier.progress.lock().unwrap();
        if !self.finished && progress.closing {
            progress.closing_error = Some("操作中断，结果尚未核对".into());
        }
        progress.active -= 1;
        drop(progress);
        self.barrier.changed.notify_one();
    }
}

fn log_event(data_dir: &std::path::Path, event: &str, details: Value) {
    // A JSON line is emitted through multiple writes by formatting. Serialize
    // native/UI workers so startup and first-frame timing remains readable.
    static LOG_WRITE: Mutex<()> = Mutex::new(());
    let _guard = LOG_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("runtime.jsonl"))
    {
        let _ = writeln!(
            file,
            "{}",
            json!({"at":chrono::Utc::now().to_rfc3339(),"event":event,"details":details})
        );
    }
}
fn publish(
    app: &tauri::AppHandle,
    core: &CoreService,
    desktop: &Desktop,
    wake: &tokio::sync::Notify,
) {
    let snapshot = core.snapshot();
    desktop.update(snapshot.clone());
    let _ = app.emit("core://changed", &snapshot);
    wake.notify_one();
}
fn report_error(app: &tauri::AppHandle, error: &CoreError) {
    let _ = app.emit("desktop://error", error);
    if let Some(host) = app.try_state::<Host>() {
        log_event(
            &host.data_dir,
            "error",
            json!({"code":error.code,"message":error.message}),
        );
    }
}
fn present(app: &tauri::AppHandle, action: &str, payload: Value) -> Result<(), String> {
    let host = app.state::<Host>();
    log_event(
        &host.data_dir,
        "window_requested",
        json!({"action":action,"window":if action=="openQuick" {"quick"} else {"main"}}),
    );
    host.desktop.action(action, payload)
}
async fn execute(app: tauri::AppHandle, command: CoreCommand) -> Result<CommandReceipt, CoreError> {
    let host = app.state::<Host>();
    let core = host.core.clone();
    let submission = host.local.admit(command.request_id.clone())?;
    let operation = serde_json::to_value(&command.operation)
        .ok()
        .and_then(|v| v.get("type").cloned());
    let receipt = tauri::async_runtime::spawn_blocking(move || {
        let result = core.execute(command, Caller::Local);
        submission.finish(&result);
        result
    })
    .await
    .map_err(|e| CoreError::new("internal", e.to_string()))??;
    log_event(
        &host.data_dir,
        "command",
        json!({"type":operation,"requestId":receipt.request_id,"revision":receipt.revision,"status":receipt.status}),
    );
    publish(&app, &host.core, &host.desktop, &host.wake);
    let enabled = host.core.snapshot().preferences.mcp_enabled;
    if !host.quitting.load(Ordering::SeqCst)
        && let Err(error) = host.gateway.set_enabled(enabled).await
    {
        host.gateway.mark_error();
        report_error(&app, &error);
        return Err(error);
    }
    Ok(receipt)
}
#[tauri::command]
fn core_snapshot(host: State<'_, Host>) -> CoreSnapshot {
    host.core.snapshot()
}
#[tauri::command]
async fn core_execute(
    app: tauri::AppHandle,
    command: CoreCommand,
) -> Result<CommandReceipt, CoreError> {
    execute(app, command).await
}
#[tauri::command]
fn core_get_request(host: State<'_, Host>, request_id: String) -> Option<CommandReceipt> {
    host.core.get_request(&request_id)
}
#[tauri::command]
fn draft_get(host: State<'_, Host>) -> QuickDraft {
    host.draft.lock().unwrap().clone()
}
#[tauri::command]
fn draft_set(host: State<'_, Host>, draft: QuickDraft) {
    *host.draft.lock().unwrap() = draft;
}
#[tauri::command]
fn mcp_info(host: State<'_, Host>) -> McpInfo {
    host.gateway.info()
}

fn shortcut_path() -> PathBuf {
    PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default())
        .join("Desktop/DitaList Rust Preview.lnk")
}
#[tauri::command]
fn desktop_status(host: State<'_, Host>) -> Value {
    json!({"floatingVisible":host.desktop.floating_visible(),"shortcutExists":shortcut_path().exists(),"dataPath":host.data_dir.join("database.rust.json"),"backupPath":host.data_dir.join("database.rust.backup.json")})
}
fn create_shortcut() -> Result<(), CoreError> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| CoreError::new("io", e.to_string()))?;
    let quote = |p: &std::path::Path| p.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut('{}'); $s.TargetPath = '{}'; $s.WorkingDirectory = '{}'; $s.IconLocation = '{},0'; $s.Save()",
        quote(&shortcut_path()),
        quote(&exe),
        quote(exe.parent().unwrap()),
        quote(&exe)
    );
    let result = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| CoreError::new("io", e.to_string()))?;
    if !result.status.success() {
        return Err(CoreError::new("io", "无法创建预览版桌面快捷方式"));
    }
    Ok(())
}
async fn handoff_web(app: &tauri::AppHandle) -> Result<(), CoreError> {
    let host = app.state::<Host>();
    let windows: Vec<_> = app.webview_windows().into_iter().collect();
    *host.handoff.responses.lock().unwrap() = windows
        .iter()
        .map(|(label, _)| (label.clone(), None))
        .collect();
    for (label, window) in &windows {
        window
            .emit("desktop://prepare-exit", json!({"window":label}))
            .map_err(|e| CoreError::new("desktop", e.to_string()))?;
    }
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let changed = host.handoff.changed.notified();
            let (blocked, done) = {
                let responses = host.handoff.responses.lock().unwrap();
                (
                    responses
                        .iter()
                        .find(|(_, value)| **value == Some(false))
                        .map(|(label, _)| label.clone()),
                    responses.values().all(|value| *value == Some(true)),
                )
            };
            if let Some(label) = blocked {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return Err(CoreError::new(
                    "unsaved",
                    "还有未提交或保存失败的编辑，请在窗口中保存或取消后再退出。",
                ));
            }
            if done {
                return Ok(());
            }
            changed.await;
        }
    })
    .await
    .map_err(|_| {
        CoreError::new(
            "timeout",
            "窗口未完成退出交接，已保留程序和编辑内容。请处理输入后重试。",
        )
    })?
}
fn request_quit(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let host = app.state::<Host>();
        if host.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        let outcome = async {
            handoff_web(&app).await?;
            host.local.progress.lock().unwrap().closing = true;
            host.gateway.set_enabled(false).await?;
            host.local.close_and_drain().await
        }
        .await;
        if let Err(error) = outcome {
            host.local.reopen();
            host.quitting.store(false, Ordering::SeqCst);
            host.handoff.responses.lock().unwrap().clear();
            let _ = app.emit("desktop://exit-cancelled", ());
            report_error(&app, &error);
            let _ = host.desktop.notify("DitaList 无法退出", &error.message);
            return;
        }
        host.exiting.store(true, Ordering::SeqCst);
        log_event(&host.data_dir, "exit", Value::Null);
        host.desktop.shutdown();
        app.exit(0);
    });
}
#[tauri::command]
async fn desktop_action(
    app: tauri::AppHandle,
    host: State<'_, Host>,
    action: String,
    payload: Option<Value>,
) -> Result<(), CoreError> {
    if [
        "trace:dragstart",
        "trace:dragover",
        "trace:drop",
        "trace:dragend",
    ]
    .contains(&action.as_str())
    {
        let fields = [
            "type",
            "clientX",
            "clientY",
            "screenX",
            "screenY",
            "calendarTask",
            "date",
            "types",
        ];
        let details: serde_json::Map<String, Value> = fields
            .into_iter()
            .filter_map(|key| {
                payload
                    .as_ref()
                    .and_then(|v| v.get(key))
                    .map(|value| (key.to_owned(), value.clone()))
            })
            .collect();
        log_event(&host.data_dir, &action, Value::Object(details));
        return Ok(());
    }
    log_event(
        &host.data_dir,
        "desktop",
        json!({"action":action,"window":payload.as_ref().and_then(|v|v.get("window"))}),
    );
    match action.as_str() {
        "quit" => {
            request_quit(app);
            Ok(())
        }
        "exitReady" => {
            let payload = payload.unwrap_or(Value::Null);
            let label = payload
                .get("window")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::new("invalid_input", "缺少交接窗口"))?;
            if let Some(response) = host.handoff.responses.lock().unwrap().get_mut(label) {
                *response = Some(
                    payload
                        .get("ready")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                );
            }
            host.handoff.changed.notify_one();
            Ok(())
        }
        "revealData" => {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer.exe")
                .arg(&host.data_dir)
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| CoreError::new("io", e.to_string()))?;
            Ok(())
        }
        "createShortcut" => create_shortcut(),
        "removeShortcut" => {
            let path = shortcut_path();
            if path.exists() {
                std::fs::remove_file(path).map_err(|e| CoreError::new("io", e.to_string()))?;
            }
            Ok(())
        }
        _ => host
            .desktop
            .action(&action, payload.unwrap_or(Value::Null))
            .map_err(|e| CoreError::new("desktop", e)),
    }
}
#[tauri::command]
async fn backup_export(app: tauri::AppHandle) -> Result<bool, CoreError> {
    let text = app.state::<Host>().core.export_backup()?;
    let path = app
        .dialog()
        .file()
        .add_filter("JSON 备份", &["json"])
        .set_file_name(format!(
            "DitaList-备份-{}.json",
            chrono::Local::now().format("%Y-%m-%d")
        ))
        .blocking_save_file();
    let Some(path) = path else { return Ok(false) };
    let path = path
        .into_path()
        .map_err(|e| CoreError::new("io", e.to_string()))?;
    std::fs::write(path, text).map_err(|e| CoreError::new("storage", e.to_string()))?;
    Ok(true)
}
#[tauri::command]
async fn backup_import(app: tauri::AppHandle) -> Result<Option<String>, CoreError> {
    let path = app
        .dialog()
        .file()
        .add_filter("JSON 或 CSV", &["json", "csv"])
        .blocking_pick_file();
    let Some(path) = path else { return Ok(None) };
    let path = path
        .into_path()
        .map_err(|e| CoreError::new("io", e.to_string()))?;
    if std::fs::metadata(&path)
        .map_err(|e| CoreError::new("io", e.to_string()))?
        .len()
        > 128 * 1024 * 1024
    {
        return Err(CoreError::new("invalid_input", "导入文件超过128 MiB"));
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|e| CoreError::new("io", e.to_string()))
}

// Debug/explicit diagnostic builds can exercise the real bar-to-window path
// without synthesizing input; normal candidate builds omit this probe.
fn main_launch_intent(args: &[String]) -> Value {
    if cfg!(any(debug_assertions, feature = "motion-diagnostics"))
        && args.iter().any(|arg| arg == "--motion-probe")
    {
        json!({"view":"today","fromBar":true})
    } else {
        Value::Null
    }
}

fn queue_main_launch(app: &tauri::AppHandle, payload: Value) {
    // Single-instance/setup callbacks run on the UI thread. It must stay free
    // while the presentation worker queries or changes window geometry.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = present(&app, "openMain", payload) {
            report_error(&app, &CoreError::new("desktop", error));
        }
    });
}

fn main() {
    let quit_requested = std::env::args().any(|arg| arg == "--quit");
    let data_dir = default_data_dir();
    let builder=tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,args,_| { if args.iter().any(|arg|arg=="--quit") {request_quit(app.clone());} else if app.try_state::<Host>().is_some() {queue_main_launch(app,main_launch_intent(&args));} }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![core_snapshot,core_execute,core_get_request,draft_get,draft_set,mcp_info,desktop_status,desktop_action,backup_export,backup_import])
        .setup(move|app| {
            if quit_requested {app.handle().exit(0);return Ok(())}
            let core=CoreService::open(&data_dir)?;
            let (tx,rx)=std::sync::mpsc::channel();
            let desktop=Arc::new(Desktop::start(app.handle().clone(),tx).map_err(std::io::Error::other)?);
            let wake=Arc::new(tokio::sync::Notify::new());
            let a=app.handle().clone(); let c=core.clone();let d=desktop.clone();let n=wake.clone();
            let changed=Arc::new(move ||publish(&a,&c,&d,&n));
            let a=app.handle().clone();let status=Arc::new(move|info:McpInfo|{let _=a.emit("mcp://state",info);});
            let gateway=Gateway::new(core.clone(),&data_dir,changed,status);
            app.manage(Host {core:core.clone(),desktop:desktop.clone(),gateway:gateway.clone(),draft:Mutex::new(QuickDraft{text:String::new(),request_id:None}),wake:wake.clone(),exiting:AtomicBool::new(false),data_dir:data_dir.clone(),local:Arc::new(LocalBarrier::default()),quitting:AtomicBool::new(false),handoff:ExitHandoff::default()});
            desktop.update(core.snapshot());
            log_event(&data_dir,"started",json!({"profile":"preview","baseline":"1d51ac981db7ea1db0266a58ea72908dba698b7e"}));
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error)=gateway.set_enabled(core.snapshot().preferences.mcp_enabled).await {gateway.mark_error();report_error(&handle,&error);}
                loop {
                    let delay=core.next_wake_ms();
                    match delay {Some(ms)=>{tokio::select!{_=wake.notified()=>{},_=tokio::time::sleep(std::time::Duration::from_millis(ms.max(10)))=>{}}},None=>wake.notified().await}
                    if handle.state::<Host>().exiting.load(Ordering::SeqCst) {break}
                    match core.tick() {
                        Ok(effects) if !effects.is_empty()=> {
                            for effect in effects {if let CoreEffect::FocusCompleted(title)=effect {let _=desktop.notify("专注完成",&title);}}
                            let snapshot=core.snapshot();desktop.update(snapshot.clone());let _=handle.emit("core://changed",snapshot);
                        },
                        Ok(_)=>{},Err(error)=>report_error(&handle,&error),
                    }
                }
            });
            let handle=app.handle().clone();
            std::thread::Builder::new().name("desktop-actions".into()).spawn(move|| {
                while let Ok(action)=rx.recv() {
                    match action {
                        DesktopAction::Command(operation)=>{let a=handle.clone();tauri::async_runtime::spawn(async move{if let Err(e)=execute(a.clone(),CoreCommand{request_id:uuid::Uuid::new_v4().to_string(),operation}).await{report_error(&a,&e);}});},
                        DesktopAction::Navigate{view,task_id,from_bar}=>{let _=present(&handle,"openMain",json!({"view":view,"taskId":task_id,"fromBar":from_bar}));},
                        DesktopAction::OpenQuick=>{let _=present(&handle,"openQuick",Value::Null);},
                        DesktopAction::Quit=>request_quit(handle.clone()),
                        DesktopAction::Wake=>handle.state::<Host>().wake.notify_one(),
                        DesktopAction::ReminderPresented(ids)=>{let a=handle.clone();tauri::async_runtime::spawn(async move{for id in ids{if let Err(e)=execute(a.clone(),CoreCommand{request_id:uuid::Uuid::new_v4().to_string(),operation:Operation::Reminder{id,action:"notified".into()}}).await{report_error(&a,&e);}}});},
                        DesktopAction::Error(message)=>report_error(&handle,&CoreError::new("desktop",message)),
                        DesktopAction::BarPresentation{state,bounds}=>log_event(&handle.state::<Host>().data_dir,"native_bar",json!({"state":state,"bounds":bounds})),
                        DesktopAction::MainMotionObservation{phase,details}=>log_event(&handle.state::<Host>().data_dir,"main_motion",json!({"phase":phase,"details":details})),
                    }
                }
            })?;
            let args = std::env::args().collect::<Vec<_>>();
            if args.iter().any(|arg|arg=="--main" || (cfg!(any(debug_assertions, feature = "motion-diagnostics")) && arg=="--motion-probe")) {queue_main_launch(app.handle(),main_launch_intent(&args));}
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("DitaList Rust Preview initialization failed");
    app.run(|handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
            && let Some(host) = handle.try_state::<Host>()
        {
            log_event(&host.data_dir, "window_destroyed", json!({"window":label}));
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event
            && handle
                .try_state::<Host>()
                .is_some_and(|host| !host.exiting.load(Ordering::SeqCst))
        {
            api.prevent_exit();
        }
    });
}

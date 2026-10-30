//! Desktop presentation and window lifetime. Business mutations go back to the core.
mod native;

use ditalist_contracts::{CoreSnapshot, Operation};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Debug, Clone)]
pub enum DesktopAction {
    Command(Operation),
    Navigate {
        view: String,
        task_id: Option<String>,
    },
    OpenQuick,
    Wake,
    Quit,
    ReminderPresented(Vec<String>),
    Error(String),
}

struct State {
    snapshot: Option<CoreSnapshot>,
    quick_open: bool,
    main_ready: bool,
    after_quick: Option<AfterQuick>,
    quick_generation: u64,
    main_generation: u64,
    navigation: Value,
    registered_shortcut: Option<Shortcut>,
    presented: HashSet<(String, String)>,
    stopped: bool,
}

enum AfterQuick {
    OpenMain(Value),
    ShowReminders,
}

struct Inner {
    app: AppHandle,
    actions: mpsc::Sender<DesktopAction>,
    native: native::NativeHandle,
    state: Mutex<State>,
    tray: Mutex<Option<TrayItems>>,
}

struct TrayItems {
    floating: tauri::menu::CheckMenuItem<tauri::Wry>,
    quiet: tauri::menu::CheckMenuItem<tauri::Wry>,
    mcp: tauri::menu::CheckMenuItem<tauri::Wry>,
    review: tauri::menu::MenuItem<tauri::Wry>,
    reminders: tauri::menu::MenuItem<tauri::Wry>,
}

#[derive(Clone)]
pub struct Desktop {
    inner: Arc<Inner>,
}

impl Desktop {
    pub fn start(app: AppHandle, actions: mpsc::Sender<DesktopAction>) -> Result<Self, String> {
        let native = native::start(actions.clone())?;
        let desktop = Self {
            inner: Arc::new(Inner {
                app: app.clone(),
                actions: actions.clone(),
                native,
                tray: Mutex::new(None),
                state: Mutex::new(State {
                    snapshot: None,
                    quick_open: false,
                    main_ready: false,
                    after_quick: None,
                    quick_generation: 0,
                    main_generation: 0,
                    navigation: json!({"view":"today"}),
                    registered_shortcut: None,
                    presented: HashSet::new(),
                    stopped: false,
                }),
            }),
        };
        desktop.install_tray()?;
        Ok(desktop)
    }

    pub fn update(&self, snapshot: CoreSnapshot) {
        let (shortcut, tray_changed, hidden_notifications) = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.stopped {
                return;
            }
            let shortcut = state
                .snapshot
                .as_ref()
                .map(|s| &s.data.settings.floating_shortcut)
                != Some(&snapshot.data.settings.floating_shortcut);
            let tray_changed = state.snapshot.as_ref().is_none_or(|old| {
                old.preferences.floating_visible != snapshot.preferences.floating_visible
                    || old.preferences.quiet != snapshot.preferences.quiet
                    || old.preferences.mcp_enabled != snapshot.preferences.mcp_enabled
                    || old.pending_count != snapshot.pending_count
                    || old.reminder_count != snapshot.reminder_count
            });
            let mut notifications = Vec::new();
            if !snapshot.preferences.floating_visible
                && !snapshot.preferences.quiet
                && snapshot.data.settings.notifications
                && !state.quick_open
            {
                for reminder in native::unpresented_reminders(&snapshot) {
                    let key = native::presentation_key(reminder);
                    if state.presented.insert(key.clone()) {
                        notifications.push((
                            key,
                            snapshot
                                .data
                                .tasks
                                .iter()
                                .find(|t| t.id == reminder.task_id)
                                .map(|t| t.title.clone())
                                .unwrap_or_else(|| "待办提醒".into()),
                        ));
                    }
                }
            }
            state.snapshot = Some(snapshot.clone());
            (shortcut, tray_changed, notifications)
        };
        if shortcut {
            self.set_shortcut(&snapshot.data.settings.floating_shortcut);
        }
        if tray_changed
            && let Some(items) = self
                .inner
                .tray
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
        {
            let _ = items
                .floating
                .set_checked(snapshot.preferences.floating_visible);
            let _ = items.quiet.set_checked(snapshot.preferences.quiet);
            let _ = items.mcp.set_checked(snapshot.preferences.mcp_enabled);
            let _ = items
                .review
                .set_text(format!("Agent 待确认（{}）", snapshot.pending_count));
            let _ = items
                .reminders
                .set_text(format!("到时提醒（{}）", snapshot.reminder_count));
        }
        self.inner
            .native
            .send(native::NativeCommand::Snapshot(Box::new(snapshot)));
        if !hidden_notifications.is_empty() {
            let body = if hidden_notifications.len() == 1 {
                hidden_notifications[0].1.clone()
            } else {
                format!(
                    "{} · 另有 {} 条提醒",
                    hidden_notifications[0].1,
                    hidden_notifications.len() - 1
                )
            };
            let sound = {
                let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                let sound = Self::notification_sound(&state);
                if sound.is_none() {
                    // Clear skipped attempts under the same lock as the preference check so an
                    // unmute update cannot miss its opportunity to present these reminders.
                    for (key, _) in &hidden_notifications {
                        state.presented.remove(key);
                    }
                }
                sound
            };
            let Some(sound) = sound else {
                return;
            };
            match self.show_notification("DitaList · 到时提醒", &body, sound) {
                Ok(()) => {
                    let _ = self.inner.actions.send(DesktopAction::ReminderPresented(
                        hidden_notifications
                            .into_iter()
                            .map(|((id, _), _)| id)
                            .collect(),
                    ));
                }
                Err(error) => {
                    // Keep the attempt in this process to avoid a failure loop on every focus tick.
                    // The core remains unnotified, so the native reminder list and restart can retry.
                    let _ = self.inner.actions.send(DesktopAction::Error(error));
                }
            }
        }
    }

    pub fn floating_visible(&self) -> bool {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .as_ref()
            .map(|s| s.preferences.floating_visible)
            .unwrap_or(true)
    }

    pub fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        let sound = {
            let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            Self::notification_sound(&state)
        };
        match sound {
            Some(sound) => self.show_notification(title, body, sound),
            None => Ok(()),
        }
    }

    fn notification_sound(state: &State) -> Option<bool> {
        if state
            .snapshot
            .as_ref()
            .is_some_and(|s| s.preferences.quiet || !s.data.settings.notifications)
        {
            None
        } else {
            Some(
                state
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| s.data.settings.sound),
            )
        }
    }

    fn show_notification(&self, title: &str, body: &str, sound: bool) -> Result<(), String> {
        tauri_winrt_notification::Toast::new(&self.inner.app.config().identifier)
            .title(title)
            .text1(body)
            .sound(sound.then_some(tauri_winrt_notification::Sound::Default))
            .show()
            .map_err(|e| e.to_string())
    }

    pub fn action(&self, action: &str, payload: Value) -> Result<(), String> {
        match action {
            "openMain" => self.open_main(payload),
            "openQuick" => self.open_quick(),
            "closeQuick" => self.close_quick(),
            "closeMain" => self.close_main(),
            "ready" => self.ready(
                payload
                    .get("window")
                    .and_then(Value::as_str)
                    .unwrap_or("main"),
            ),
            "quickResize" => self.resize_quick(payload),
            "quickDrag" => {
                let position = self
                    .window("quick")?
                    .outer_position()
                    .map_err(|e| e.to_string())?;
                self.close_quick()?;
                self.inner.native.send(native::NativeCommand::BeginDrag {
                    x: position.x,
                    y: position.y,
                });
                Ok(())
            }
            "minimize" => self.window("main")?.minimize().map_err(|e| e.to_string()),
            "maximize" => {
                let window = self.window("main")?;
                if window.is_maximized().map_err(|e| e.to_string())? {
                    window.unmaximize().map_err(|e| e.to_string())
                } else {
                    window.maximize().map_err(|e| e.to_string())
                }
            }
            "showReminders" => {
                if self.handoff_quick(AfterQuick::ShowReminders)? {
                    return Ok(());
                }
                self.inner.native.send(native::NativeCommand::ShowReminders);
                Ok(())
            }
            "quit" => {
                let _ = self.inner.actions.send(DesktopAction::Quit);
                Ok(())
            }
            _ => Err(format!("未知桌面操作：{action}")),
        }
    }

    fn window(&self, label: &str) -> Result<WebviewWindow, String> {
        self.inner
            .app
            .get_webview_window(label)
            .ok_or_else(|| format!("窗口不存在：{label}"))
    }

    fn open_main(&self, payload: Value) -> Result<(), String> {
        if self.handoff_quick(AfterQuick::OpenMain(payload.clone()))? {
            return Ok(());
        }
        let existing = self.inner.app.get_webview_window("main");
        let navigation = if payload.get("view").and_then(Value::as_str).is_some() {
            Some(payload)
        } else if existing.is_none() {
            let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            Some(
                json!({"view":state.snapshot.as_ref().map(|s|s.data.settings.default_view.as_str()).unwrap_or("today")}),
            )
        } else {
            None
        };
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if existing.is_none() || state.main_ready {
                state.main_generation += 1;
            }
            if let Some(navigation) = &navigation {
                state.navigation = navigation.clone();
            }
        }
        if let Some(window) = existing {
            if !self
                .inner
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .main_ready
            {
                return Ok(());
            }
            window.unminimize().map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            if let Some(navigation) = navigation {
                window
                    .emit("desktop://navigate", navigation)
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .main_ready = false;
        let window = WebviewWindowBuilder::new(
            &self.inner.app,
            "main",
            WebviewUrl::App("index.html".into()),
        )
        .title("DitaList Rust Preview")
        .inner_size(1140., 780.)
        .min_inner_size(480., 500.)
        .decorations(false)
        // Windows needs the WebView2 HTML5 handler for calendar drag-and-drop.
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        Self::attach_close_handoff(&window, "main");
        self.creation_timeout("main");
        Ok(())
    }

    fn open_quick(&self) -> Result<(), String> {
        if let Some(window) = self.inner.app.get_webview_window("quick") {
            if !self
                .inner
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .quick_open
            {
                return Ok(());
            }
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        let anchor = self.inner.native.anchor();
        let scale = anchor.scale.max(1.0);
        let width = (420.0_f64 * scale).min(anchor.work_width);
        let x = (anchor.right - width).max(anchor.work_x);
        let y = anchor.top.min(anchor.work_bottom - 40.0 * scale);
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.quick_generation += 1;
        }
        let window = WebviewWindowBuilder::new(
            &self.inner.app,
            "quick",
            WebviewUrl::App("floating.html".into()),
        )
        .title("DitaList · 快速输入")
        .inner_size(width / scale, 40.)
        .min_inner_size(240., 40.)
        .max_inner_size(560., 480.)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        // Preserve the same standard DOM drag behavior as the main WebView.
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
            .map_err(|e| e.to_string())?;
        Self::attach_close_handoff(&window, "quick");
        self.creation_timeout("quick");
        Ok(())
    }

    fn attach_close_handoff(window: &WebviewWindow, label: &'static str) {
        let window = window.clone();
        let emit_window = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = emit_window.emit("desktop://prepare-close", json!({"window":label}));
            }
        });
    }

    fn ready(&self, label: &str) -> Result<(), String> {
        let window = self.window(label)?;
        match label {
            "quick" => {
                self.inner
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .quick_open = true;
                self.inner
                    .native
                    .send(native::NativeCommand::InputActive(true));
            }
            "main" => {
                let navigation = {
                    let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.main_ready = true;
                    state.navigation.clone()
                };
                window
                    .emit("desktop://navigate", navigation)
                    .map_err(|e| e.to_string())?;
            }
            _ => return Err("未知窗口".into()),
        }
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    }

    fn close_quick(&self) -> Result<(), String> {
        if let Some(window) = self.inner.app.get_webview_window("quick") {
            // This command is sent after the renderer hands off its draft and in-flight request.
            window.destroy().map_err(|e| e.to_string())?;
        }
        let next = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.quick_open = false;
            state.quick_generation += 1;
            state.after_quick.take()
        };
        self.inner
            .native
            .send(native::NativeCommand::InputActive(false));
        match next {
            Some(AfterQuick::OpenMain(payload)) => self.open_main(payload)?,
            Some(AfterQuick::ShowReminders) => {
                self.inner.native.send(native::NativeCommand::ShowReminders)
            }
            None => {}
        }
        Ok(())
    }

    fn handoff_quick(&self, next: AfterQuick) -> Result<bool, String> {
        let Some(window) = self.inner.app.get_webview_window("quick") else {
            return Ok(false);
        };
        let ready = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .quick_open;
        if !ready {
            self.close_quick()?;
            return Ok(false);
        }
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .after_quick = Some(next);
        window
            .emit("desktop://prepare-close", json!({"window":"quick"}))
            .map_err(|e| e.to_string())?;
        Ok(true)
    }

    fn close_main(&self) -> Result<(), String> {
        let Some(window) = self.inner.app.get_webview_window("main") else {
            return Ok(());
        };
        window.hide().map_err(|e| e.to_string())?;
        let generation = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.main_generation += 1;
            state.main_generation
        };
        let weak = Arc::downgrade(&self.inner);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if let Some(inner) = weak.upgrade() {
                let release = {
                    let state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
                    !state.stopped && state.main_generation == generation
                };
                if release && let Some(window) = inner.app.get_webview_window("main") {
                    let _ = window.destroy();
                }
            }
        });
        Ok(())
    }

    fn creation_timeout(&self, label: &'static str) {
        let generation = {
            let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if label == "quick" {
                state.quick_generation
            } else {
                state.main_generation
            }
        };
        let weak = Arc::downgrade(&self.inner);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(20)).await;
            if let Some(inner) = weak.upgrade()
                && let Some(window) = inner.app.get_webview_window(label)
            {
                if window.is_visible().unwrap_or(true) {
                    return;
                }
                let state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
                let expected = !state.stopped
                    && if label == "quick" {
                        !state.quick_open && state.quick_generation == generation
                    } else {
                        !state.main_ready && state.main_generation == generation
                    };
                drop(state);
                if expected {
                    let _ = window.destroy();
                    if label == "quick" {
                        inner.native.send(native::NativeCommand::InputActive(false));
                    }
                    let _ = inner.actions.send(DesktopAction::Error(format!(
                        "{label} 界面加载失败，原生入口仍可使用"
                    )));
                }
            }
        });
    }

    fn resize_quick(&self, payload: Value) -> Result<(), String> {
        let window = self.window("quick")?;
        let anchor = self.inner.native.anchor();
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let width = payload
            .get("width")
            .and_then(Value::as_f64)
            .unwrap_or(420.)
            .clamp(240., 560.)
            .min(anchor.work_width / scale);
        let height = payload
            .get("height")
            .and_then(Value::as_f64)
            .unwrap_or(40.)
            .clamp(40., 480.);
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(
                pos.x.max(anchor.work_x as i32),
                pos.y.min((anchor.work_bottom - height * scale) as i32),
            ))
            .map_err(|e| e.to_string())
    }

    fn set_shortcut(&self, value: &str) {
        let next = if value.trim().is_empty() {
            None
        } else {
            match value.parse::<Shortcut>() {
                Ok(value) => Some(value),
                Err(error) => {
                    let _ = self
                        .inner
                        .actions
                        .send(DesktopAction::Error(format!("快捷键无效：{error}")));
                    return;
                }
            }
        };
        let previous = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .registered_shortcut;
        if previous == next {
            return;
        }
        if let Some(old) = previous {
            let _ = self.inner.app.global_shortcut().unregister(old);
        }
        if let Some(shortcut) = next {
            let actions = self.inner.actions.clone();
            if let Err(error) =
                self.inner
                    .app
                    .global_shortcut()
                    .on_shortcut(shortcut, move |_, _, event| {
                        if event.state == ShortcutState::Pressed {
                            let _ = actions.send(DesktopAction::OpenQuick);
                        }
                    })
            {
                if let Some(old) = previous {
                    let actions = self.inner.actions.clone();
                    let _ =
                        self.inner
                            .app
                            .global_shortcut()
                            .on_shortcut(old, move |_, _, event| {
                                if event.state == ShortcutState::Pressed {
                                    let _ = actions.send(DesktopAction::OpenQuick);
                                }
                            });
                }
                let _ = self.inner.actions.send(DesktopAction::Error(format!(
                    "快捷键已被占用或注册失败：{error}"
                )));
                return;
            }
        }
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .registered_shortcut = next;
    }

    fn install_tray(&self) -> Result<(), String> {
        use tauri::{
            menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
            tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        };
        let app = &self.inner.app;
        let open = MenuItem::with_id(app, "open", "打开 DitaList", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let quick = MenuItem::with_id(app, "quick", "快速添加任务", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let review = MenuItem::with_id(app, "review", "Agent 待确认", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let reminders = MenuItem::with_id(app, "reminders", "到时提醒", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let floating =
            CheckMenuItem::with_id(app, "floating", "显示悬浮栏", true, true, None::<&str>)
                .map_err(|e| e.to_string())?;
        let quiet = CheckMenuItem::with_id(app, "quiet", "安静模式", true, false, None::<&str>)
            .map_err(|e| e.to_string())?;
        let mcp = CheckMenuItem::with_id(app, "mcp", "MCP 通道", true, false, None::<&str>)
            .map_err(|e| e.to_string())?;
        let separator = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
        let quit = MenuItem::with_id(app, "quit", "退出 DitaList", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let menu = Menu::with_items(
            app,
            &[
                &open, &quick, &review, &reminders, &floating, &quiet, &mcp, &separator, &quit,
            ],
        )
        .map_err(|e| e.to_string())?;
        let actions = self.inner.actions.clone();
        let clicks = self.inner.actions.clone();
        let weak = Arc::downgrade(&self.inner);
        let mut builder=TrayIconBuilder::with_id("ditalist-tray").tooltip("DitaList Rust Preview")
            .menu(&menu).show_menu_on_left_click(false)
            .on_menu_event(move |_,event| {
                if let Some(inner)=weak.upgrade(){
                    let id=event.id.as_ref();
                    if id=="reminders"{let desktop=Desktop{inner};let _=desktop.action("showReminders",Value::Null);return;}
                    if ["floating","quiet","mcp"].contains(&id){
                        let state=inner.state.lock().unwrap_or_else(|e|e.into_inner());
                        if let Some(snapshot)=&state.snapshot{let patch=match id{
                            "floating"=>json!({"floatingVisible":!snapshot.preferences.floating_visible}),
                            "quiet"=>json!({"quiet":!snapshot.preferences.quiet}),
                            _=>json!({"mcpEnabled":!snapshot.preferences.mcp_enabled})};
                            let _=actions.send(DesktopAction::Command(Operation::PreferencesUpdate{patch}));}
                        return;
                    }
                }
                let action=match event.id.as_ref() {
                "open"=>DesktopAction::Navigate{view:"today".into(),task_id:None},
                "quick"=>DesktopAction::OpenQuick,
                "review"=>DesktopAction::Navigate{view:"agent-review".into(),task_id:None},
                "quit"=>DesktopAction::Quit,_=>return};let _=actions.send(action);})
            .on_tray_icon_event(move |_,event| {if matches!(event,TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}) {
                let _=clicks.send(DesktopAction::OpenQuick);
            }});
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app).map_err(|e| e.to_string())?;
        *self.inner.tray.lock().unwrap_or_else(|e| e.into_inner()) = Some(TrayItems {
            floating,
            quiet,
            mcp,
            review,
            reminders,
        });
        Ok(())
    }

    pub fn shutdown(&self) {
        let shortcut = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.stopped = true;
            state.main_generation += 1;
            state.quick_generation += 1;
            state.registered_shortcut.take()
        };
        if let Some(shortcut) = shortcut {
            let _ = self.inner.app.global_shortcut().unregister(shortcut);
        }
        self.inner.app.remove_tray_by_id("ditalist-tray");
        self.inner.native.send(native::NativeCommand::Shutdown);
    }
}

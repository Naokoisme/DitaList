//! Desktop presentation and window lifetime. Business mutations go back to the core.
mod native;
mod position;

use ditalist_contracts::{CoreSnapshot, Operation};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Debug, Clone)]
pub enum DesktopAction {
    Command(Operation),
    Navigate {
        view: String,
        task_id: Option<String>,
        from_bar: bool,
    },
    OpenQuick,
    Wake,
    Quit,
    ReminderPresented(Vec<String>),
    BarPresentation {
        state: &'static str,
        bounds: [i32; 4],
    },
    MainMotionObservation {
        phase: &'static str,
        details: Value,
    },
    Error(String),
}

struct State {
    snapshot: Option<CoreSnapshot>,
    quick_open: bool,
    main_ready: bool,
    main_from_bar: bool,
    main_motion: Option<MainMotion>,
    main_opening: Option<MainOpening>,
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

#[derive(Clone, Copy)]
struct MainFrame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

struct MainMotion {
    id: u64,
    restore: MainFrame,
    prepared: bool,
    source_painted: bool,
    opening: MainOpening,
}

#[derive(Clone, Copy)]
struct MainOpening {
    requested: Instant,
    source: &'static str,
}

struct Inner {
    app: AppHandle,
    actions: mpsc::Sender<DesktopAction>,
    native: native::NativeHandle,
    state: Mutex<State>,
    presentation: Mutex<()>,
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
                presentation: Mutex::new(()),
                tray: Mutex::new(None),
                state: Mutex::new(State {
                    snapshot: None,
                    quick_open: false,
                    main_ready: false,
                    main_from_bar: false,
                    main_motion: None,
                    main_opening: None,
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
        // Renderer acknowledgements, native clicks and close requests arrive on
        // different threads. Keep their window handoffs in one order.
        let _presentation = self
            .inner
            .presentation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match action {
            "openMain" => self.open_main(payload),
            "openQuick" => self.open_quick(),
            "closeQuick" => self.close_quick(),
            "closeMain" => self.close_main(),
            "mainMotionPrepared" => self.main_motion_prepared(&payload),
            "mainShellReady" => self.main_shell_ready(),
            "mainMotionSourceFrame" => self.main_motion_source_frame(&payload),
            "mainMotionFrame" => self.main_motion_frame(&payload),
            "mainMotionFinished" => self.finish_main_motion(&payload, true),
            "mainMotionCancelled" => self.finish_main_motion(&payload, false),
            "ready" => self.ready(
                payload
                    .get("window")
                    .and_then(Value::as_str)
                    .unwrap_or("main"),
            ),
            "quickResize" => self.resize_quick(payload),
            "quickDrag" => {
                // Draft handoff may outlast a short gesture. A released pointer
                // must leave the current input and its draft in place.
                if !native::primary_button_down() {
                    return Ok(());
                }
                let window = self.window("quick")?;
                let scale = window.scale_factor().map_err(|e| e.to_string())?;
                let position = window.outer_position().map_err(|e| e.to_string())?;
                self.close_quick()?;
                self.inner.native.send(native::NativeCommand::BeginDrag {
                    // The Web bar has a 10-DIP transparent shadow margin.
                    x: position.x + (10. * scale).round() as i32,
                    y: position.y + (10. * scale).round() as i32,
                });
                Ok(())
            }
            "minimize" => {
                self.finish_main_motion(&Value::Null, false)?;
                self.inner
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .main_opening = None;
                self.window("main")?.minimize().map_err(|e| e.to_string())
            }
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
        let from_bar = payload.get("fromBar").and_then(Value::as_bool) == Some(true);
        self.inner
            .native
            .send(native::NativeCommand::HoldForMain(from_bar));
        let result = self.open_main_inner(payload, from_bar);
        if result.is_err() {
            self.inner
                .native
                .send(native::NativeCommand::HoldForMain(false));
        }
        result
    }

    fn open_main_inner(&self, payload: Value, from_bar: bool) -> Result<(), String> {
        if self.handoff_quick(AfterQuick::OpenMain(payload.clone()))? {
            return Ok(());
        }
        let existing = self.inner.app.get_webview_window("main");
        let visible = existing
            .as_ref()
            .is_some_and(|window| window.is_visible().unwrap_or(false));
        let minimized = existing
            .as_ref()
            .is_some_and(|window| window.is_minimized().unwrap_or(false));
        let source = if existing.is_none() {
            "cold"
        } else if minimized {
            "minimized"
        } else if visible {
            "visible"
        } else {
            "retained"
        };
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
            if existing.is_none()
                || state.main_opening.is_none()
                || (state.main_ready && state.main_motion.is_none())
            {
                state.main_generation += 1;
                state.main_opening = Some(MainOpening {
                    requested: Instant::now(),
                    source,
                });
            }
            if state.main_motion.is_none() {
                state.main_from_bar = from_bar;
            }
            if let Some(navigation) = &navigation {
                state.navigation = navigation.clone();
            }
        }
        self.observe_main_opening(
            "requested",
            json!({"fromBar":from_bar,"visible":visible,"minimized":minimized}),
        );
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
            if let Some(navigation) = navigation {
                window
                    .emit("desktop://navigate", navigation)
                    .map_err(|e| e.to_string())?;
            }
            return self.present_main(&window);
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
        .transparent(true)
        .no_redirection_bitmap(true)
        .shadow(false)
        // Windows needs the WebView2 HTML5 handler for calendar drag-and-drop.
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        Self::with_main_hwnd(&window, |hwnd| unsafe {
            use windows::Win32::Graphics::Dwm::*;
            let disabled = 1i32;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &disabled as *const _ as _,
                std::mem::size_of_val(&disabled) as u32,
            )
            .map_err(|e| e.to_string())
        })?;
        Self::attach_close_handoff(&window, "main");
        self.creation_timeout("main");
        Ok(())
    }

    fn present_main(&self, window: &WebviewWindow) -> Result<(), String> {
        let from_bar = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.main_motion.is_some() {
                return Ok(());
            }
            if state.main_opening.is_none() {
                return Ok(());
            }
            std::mem::take(&mut state.main_from_bar)
        };
        let minimized = window.is_minimized().map_err(|e| e.to_string())?;
        let visible = window.is_visible().map_err(|e| e.to_string())?;
        if from_bar
            && self.floating_visible()
            && native::client_animations_enabled()
            && (minimized || !visible)
        {
            let motion = (|| {
                if minimized {
                    // Restoring an iconic HWND uses SW_RESTORE internally. Cloak
                    // it until the new bar-sized source frame is ready to show.
                    Self::set_main_cloaked(window, true)?;
                    window.hide().map_err(|e| e.to_string())?;
                    window.unminimize().map_err(|e| e.to_string())?;
                }
                self.begin_main_motion(window)
            })();
            match motion {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => {
                    let _ = self.finish_main_motion(&Value::Null, false);
                    let _ = self.inner.actions.send(DesktopAction::Error(format!(
                        "主窗口转场未能启动，已恢复普通显示：{error}"
                    )));
                }
            }
        }
        Self::set_main_cloaked(window, false)?;
        self.inner
            .native
            .send(native::NativeCommand::HoldForMain(false));
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    }

    fn observe_main_opening(&self, phase: &'static str, extra: Value) {
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(opening) = state.main_opening {
            let _ = self
                .inner
                .actions
                .send(DesktopAction::MainMotionObservation {
                    phase,
                    details: json!({"id":state.main_generation,"source":opening.source,
                    "requestElapsedMs":opening.requested.elapsed().as_millis(),"frame":extra}),
                });
        }
    }

    fn main_shell_ready(&self) -> Result<(), String> {
        self.observe_main_opening("shell_ready", Value::Null);
        let should_present = {
            let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            !state.main_ready
                && state.main_from_bar
                && state.main_motion.is_none()
                && state.main_opening.is_some()
        };
        if should_present {
            self.present_main(&self.window("main")?)?;
        }
        Ok(())
    }

    fn begin_main_motion(&self, window: &WebviewWindow) -> Result<bool, String> {
        let anchor = self.inner.native.anchor();
        let maximized = window.is_maximized().map_err(|e| e.to_string())?;
        let monitor = window.current_monitor().map_err(|e| e.to_string())?;
        let same_monitor = monitor.as_ref().is_some_and(|monitor| {
            let p = monitor.position();
            let s = monitor.size();
            let x = (anchor.left + anchor.right) / 2.;
            let y = (anchor.top + anchor.bottom) / 2.;
            x >= p.x as f64
                && x < p.x as f64 + s.width as f64
                && y >= p.y as f64
                && y < p.y as f64 + s.height as f64
        });
        // A hidden restored window follows the bar to its monitor. Keeping the
        // whole transition on one DPI avoids a font-size jump during handoff.
        if !same_monitor {
            if maximized {
                return Ok(false);
            }
            let size = window.inner_size().map_err(|e| e.to_string())?;
            let old_scale = window.scale_factor().map_err(|e| e.to_string())?;
            let width = (size.width as f64 / old_scale * anchor.scale)
                .min(anchor.work_width)
                .max(1.);
            let height = (size.height as f64 / old_scale * anchor.scale)
                .min(anchor.work_bottom - anchor.work_y)
                .max(1.);
            window
                .set_position(tauri::PhysicalPosition::new(
                    (anchor.work_x + (anchor.work_width - width) / 2.).round() as i32,
                    (anchor.work_y + (anchor.work_bottom - anchor.work_y - height) / 2.).round()
                        as i32,
                ))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(
                    width.round() as u32,
                    height.round() as u32,
                ))
                .map_err(|e| e.to_string())?;
        }
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let restore = MainFrame {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        };
        let target_position = window.inner_position().map_err(|e| e.to_string())?;
        let target_size = window.inner_size().map_err(|e| e.to_string())?;
        let target_right = target_position.x as f64 + target_size.width as f64;
        let target_bottom = target_position.y as f64 + target_size.height as f64;
        let left = (target_position.x as f64).min(anchor.left);
        let top = (target_position.y as f64).min(anchor.top);
        let right = target_right.max(anchor.right);
        let bottom = target_bottom.max(anchor.bottom);
        if maximized
            && (left < target_position.x as f64
                || top < target_position.y as f64
                || right > target_right
                || bottom > target_bottom)
        {
            return Ok(false);
        }
        let id = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            let id = state.main_generation;
            state.main_motion = Some(MainMotion {
                id,
                restore,
                prepared: false,
                source_painted: false,
                opening: state.main_opening.unwrap_or(MainOpening {
                    requested: Instant::now(),
                    source: "unknown",
                }),
            });
            id
        };
        if !maximized {
            // Resize the HWND only at the two ends. During motion its WebView is
            // one transparent canvas, while the actual App keeps its final layout.
            Self::set_main_frame(
                window,
                MainFrame {
                    x: left.round() as i32 - (target_position.x - position.x),
                    y: top.round() as i32 - (target_position.y - position.y),
                    width: (right - left).round() as u32 + (size.width - target_size.width),
                    height: (bottom - top).round() as u32 + (size.height - target_size.height),
                },
            )?;
        }
        let canvas = window.inner_position().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        Self::clip_main_to_bar(window, anchor)?;
        let bar = {
            let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            let snapshot = state.snapshot.as_ref();
            json!({
                "today":snapshot.map(|s|s.today_count).unwrap_or(0),
                "pending":snapshot.map(|s|s.pending_count).unwrap_or(0),
                "reminders":snapshot.map(|s|s.reminder_count).unwrap_or(0),
                "theme":snapshot.map(|s|s.data.settings.theme.as_str()).unwrap_or("system"),
                "accent":snapshot.map(|s|s.data.settings.accent.as_str()).unwrap_or("#4772fa")
            })
        };
        window.emit("desktop://main-motion", json!({
            "phase":"prepare", "id":id, "maximized":maximized, "bar":bar,
            "from":{"x":(anchor.left-canvas.x as f64)/scale,"y":(anchor.top-canvas.y as f64)/scale,
                "width":(anchor.right-anchor.left)/scale,"height":(anchor.bottom-anchor.top)/scale},
            "to":{"x":(target_position.x-canvas.x) as f64/scale,"y":(target_position.y-canvas.y) as f64/scale,
                "width":target_size.width as f64/scale,"height":target_size.height as f64/scale}
        })).map_err(|e| e.to_string())?;
        self.observe_main_opening("prepare_sent", Value::Null);
        let weak = Arc::downgrade(&self.inner);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if let Some(inner) = weak.upgrade() {
                let desktop = Desktop { inner };
                let _presentation = desktop
                    .inner
                    .presentation
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let pending = desktop
                    .inner
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .main_motion
                    .as_ref()
                    .is_some_and(|motion| motion.id == id);
                if pending {
                    let _ = desktop.finish_main_motion(&json!({"id":id}), true);
                    let _ = desktop.inner.actions.send(DesktopAction::Error(
                        "主窗口转场超时，已恢复普通显示".into(),
                    ));
                }
            }
        });
        Ok(true)
    }

    fn with_main_hwnd(
        window: &WebviewWindow,
        action: impl FnOnce(windows::Win32::Foundation::HWND) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let handle = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let _ = sender.send(action(windows::Win32::Foundation::HWND(
                    handle as *mut std::ffi::c_void,
                )));
            })
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|e| e.to_string())?
    }

    fn set_main_frame(window: &WebviewWindow, frame: MainFrame) -> Result<(), String> {
        Self::with_main_hwnd(window, move |hwnd| unsafe {
            use windows::Win32::UI::WindowsAndMessaging::*;
            SetWindowPos(
                hwnd,
                None,
                frame.x,
                frame.y,
                frame.width as i32,
                frame.height as i32,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
            .map_err(|e| e.to_string())
        })
    }

    fn set_main_cloaked(window: &WebviewWindow, cloaked: bool) -> Result<(), String> {
        Self::with_main_hwnd(window, move |hwnd| unsafe {
            use windows::Win32::Graphics::Dwm::*;
            let value = i32::from(cloaked);
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_CLOAK,
                &value as *const _ as _,
                std::mem::size_of_val(&value) as u32,
            )
            .map_err(|e| e.to_string())
        })
    }

    fn clip_main_to_bar(window: &WebviewWindow, anchor: native::Anchor) -> Result<(), String> {
        Self::with_main_hwnd(window, move |hwnd| unsafe {
            use windows::Win32::{Foundation::RECT, Graphics::Gdi::*, UI::WindowsAndMessaging::*};
            let mut bounds = RECT::default();
            GetWindowRect(hwnd, &mut bounds).map_err(|e| e.to_string())?;
            let radius = (16. * anchor.scale).round() as i32;
            let region = CreateRoundRectRgn(
                anchor.left.round() as i32 - bounds.left,
                anchor.top.round() as i32 - bounds.top,
                anchor.right.round() as i32 - bounds.left + 1,
                anchor.bottom.round() as i32 - bounds.top + 1,
                radius,
                radius,
            );
            if SetWindowRgn(hwnd, Some(region), true) == 0 {
                let _ = DeleteObject(region.into());
                return Err(windows::core::Error::from_thread().to_string());
            }
            Ok(())
        })
    }

    fn clear_main_clip(window: &WebviewWindow) -> Result<(), String> {
        Self::with_main_hwnd(window, |hwnd| unsafe {
            use windows::Win32::Graphics::Gdi::SetWindowRgn;
            if SetWindowRgn(hwnd, None, true) == 0 {
                return Err(windows::core::Error::from_thread().to_string());
            }
            Ok(())
        })
    }

    fn main_motion_prepared(&self, payload: &Value) -> Result<(), String> {
        let id = payload
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("缺少转场编号")?;
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(motion) = &mut state.main_motion else {
                return Ok(());
            };
            if motion.id != id || motion.prepared {
                return Ok(());
            }
            motion.prepared = true;
        }
        let result = (|| {
            let window = self.window("main")?;
            // A retained WebView may still have its last full-size DWM surface.
            // Show only the source region, covered by the native bar, until the
            // renderer confirms a freshly painted source frame.
            window.show().map_err(|e| e.to_string())?;
            Self::set_main_cloaked(&window, false)?;
            window.set_focus().map_err(|e| e.to_string())?;
            self.observe_main_opening("prepared", Value::Null);
            window
                .emit("desktop://main-motion", json!({"phase":"paint","id":id}))
                .map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = self.finish_main_motion(payload, true);
        }
        result
    }

    fn main_motion_source_frame(&self, payload: &Value) -> Result<(), String> {
        let id = payload
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("缺少转场编号")?;
        let frame = Self::motion_frame_details(payload)?;
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(motion) = &mut state.main_motion else {
                return Ok(());
            };
            if motion.id != id || !motion.prepared || motion.source_painted {
                return Ok(());
            }
            motion.source_painted = true;
        }
        self.observe_main_opening("source_frame", frame);
        let window = self.window("main")?;
        let result = (|| {
            Self::clear_main_clip(&window)?;
            self.inner
                .native
                .send(native::NativeCommand::MainTransition(true));
            self.inner
                .native
                .send(native::NativeCommand::HoldForMain(false));
            window
                .emit("desktop://main-motion", json!({"phase":"start","id":id}))
                .map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = self.finish_main_motion(payload, true);
        }
        result
    }

    fn main_motion_frame(&self, payload: &Value) -> Result<(), String> {
        let id = payload
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("缺少转场编号")?;
        let valid = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .main_motion
            .as_ref()
            .is_some_and(|motion| motion.id == id && motion.source_painted);
        if valid {
            self.observe_main_opening("first_frame", Self::motion_frame_details(payload)?);
        }
        Ok(())
    }

    fn motion_frame_details(payload: &Value) -> Result<Value, String> {
        let mut timing = serde_json::Map::new();
        for key in [
            "preparedAtMs",
            "sourceFrameAtMs",
            "startedAtMs",
            "firstFrameAtMs",
            "finishedAtMs",
        ] {
            if let Some(value) = payload.get(key) {
                let number = value
                    .as_f64()
                    .filter(|v| v.is_finite() && *v >= 0.)
                    .ok_or("转场时间字段无效")?;
                timing.insert(key.to_owned(), json!(number));
            }
        }
        Ok(Value::Object(timing))
    }

    fn finish_main_motion(&self, payload: &Value, show: bool) -> Result<(), String> {
        let frame = Self::motion_frame_details(payload)?;
        let motion = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.main_motion.as_ref().is_none_or(|motion| {
                payload
                    .get("id")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| id != motion.id)
            }) {
                return Ok(());
            }
            if !show {
                state.main_opening = None;
            }
            state.main_motion.take().unwrap()
        };
        let received_elapsed_ms = motion.opening.requested.elapsed().as_millis();
        let result = (|| {
            let window = self.window("main")?;
            Self::clear_main_clip(&window)?;
            Self::set_main_cloaked(&window, false)?;
            if !window.is_maximized().unwrap_or(false) {
                Self::set_main_frame(&window, motion.restore)?;
            }
            window
                .emit(
                    "desktop://main-motion",
                    json!({"phase":"settled","id":motion.id}),
                )
                .map_err(|e| e.to_string())?;
            if show {
                window.show().map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        self.inner
            .native
            .send(native::NativeCommand::MainTransition(false));
        self.inner
            .native
            .send(native::NativeCommand::HoldForMain(false));
        let _ = self
            .inner
            .actions
            .send(DesktopAction::MainMotionObservation {
                phase: if result.is_ok() { "finished" } else { "failed" },
                details: json!({"id":motion.id,"source":motion.opening.source,
                "requestElapsedMs":motion.opening.requested.elapsed().as_millis(),
                "receivedElapsedMs":received_elapsed_ms,"frame":frame,"shown":show}),
            });
        result
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
        let y = anchor.top.clamp(
            anchor.work_y,
            (anchor.work_bottom - 40.0 * scale).max(anchor.work_y),
        );
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
            } else if label == "main" && matches!(event, tauri::WindowEvent::Resized(_)) {
                let _ = emit_window.emit(
                    "desktop://main-window-state",
                    json!({
                        "maximized":emit_window.is_maximized().unwrap_or(false)
                    }),
                );
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
                self.observe_main_opening("ready", Value::Null);
                let (navigation, should_present) = {
                    let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.main_ready = true;
                    (state.navigation.clone(), state.main_opening.is_some())
                };
                let result = window
                    .emit("desktop://navigate", navigation)
                    .map_err(|e| e.to_string());
                if let Err(error) = result {
                    self.inner
                        .native
                        .send(native::NativeCommand::HoldForMain(false));
                    return Err(error);
                }
                return if should_present {
                    self.present_main(&window)
                } else {
                    Ok(())
                };
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
        self.inner
            .native
            .send(native::NativeCommand::HoldForMain(false));
        let Some(window) = self.inner.app.get_webview_window("main") else {
            return Ok(());
        };
        window.hide().map_err(|e| e.to_string())?;
        if let Err(error) = self.finish_main_motion(&Value::Null, false) {
            let _ = self.inner.actions.send(DesktopAction::Error(error));
        }
        let generation = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.main_generation += 1;
            state.main_opening = None;
            state.main_generation
        };
        let weak = Arc::downgrade(&self.inner);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if let Some(inner) = weak.upgrade() {
                let _presentation = inner.presentation.lock().unwrap_or_else(|e| e.into_inner());
                let release = {
                    let state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
                    !state.stopped && state.main_generation == generation
                };
                if release && let Some(window) = inner.app.get_webview_window("main") {
                    let _ = window.destroy();
                    let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.main_ready = false;
                    state.main_opening = None;
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
                    } else {
                        inner.native.send(native::NativeCommand::HoldForMain(false));
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
            .clamp(40., 480.)
            .min((anchor.work_bottom - anchor.work_y) / scale);
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(
                (anchor.right - width * scale).clamp(
                    anchor.work_x,
                    (anchor.work_x + anchor.work_width - width * scale).max(anchor.work_x),
                ) as i32,
                anchor.top.clamp(
                    anchor.work_y,
                    (anchor.work_bottom - height * scale).max(anchor.work_y),
                ) as i32,
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
                    if id=="reminders"{
                        let desktop=Desktop{inner};
                        // The UI thread must not wait for the presentation gate:
                        // its owner may be waiting for this thread to move a window.
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error)=desktop.action("showReminders",Value::Null) {
                                let _=desktop.inner.actions.send(DesktopAction::Error(error));
                            }
                        });
                        return;
                    }
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
                "open"=>DesktopAction::Navigate{view:"today".into(),task_id:None,from_bar:false},
                "quick"=>DesktopAction::OpenQuick,
                "review"=>DesktopAction::Navigate{view:"agent-review".into(),task_id:None,from_bar:false},
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
        let _presentation = self
            .inner
            .presentation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let shortcut = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.stopped = true;
            state.main_generation += 1;
            state.quick_generation += 1;
            state.main_motion = None;
            state.main_opening = None;
            state.registered_shortcut.take()
        };
        if let Some(shortcut) = shortcut {
            let _ = self.inner.app.global_shortcut().unregister(shortcut);
        }
        self.inner.app.remove_tray_by_id("ditalist-tray");
        self.inner
            .native
            .send(native::NativeCommand::MainTransition(false));
        self.inner
            .native
            .send(native::NativeCommand::HoldForMain(false));
        self.inner.native.send(native::NativeCommand::Shutdown);
    }
}

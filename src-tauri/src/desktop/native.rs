//! One Win32 UI thread owns all HWNDs and Direct2D resources.
//! Owner-drawn standard buttons preserve the OS keyboard/accessibility providers.
use super::DesktopAction;
use super::position::{BarTransition, Dock, corner_diameter};
use chrono::{DateTime, Local, Utc};
use ditalist_contracts::{CoreSnapshot, Operation, ReminderEvent};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    ffi::c_void,
    sync::{
        Arc, Mutex,
        atomic::{AtomicIsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::*,
        Graphics::{
            Direct2D::{Common::*, *},
            DirectWrite::*,
            Dxgi::Common::*,
            Gdi::*,
        },
        System::{Com::*, Diagnostics::Debug::MessageBeep, LibraryLoader::*, Registry::*},
        UI::{
            Controls::*,
            HiDpi::*,
            Input::KeyboardAndMouse::*,
            Shell::{DefSubclassProc, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    },
    core::{BOOL, PCWSTR, PWSTR, w},
};

const UPDATE: u32 = WM_APP + 41;
const DEFERRED: u32 = WM_APP + 42;
const POINTER_CHANGED: u32 = WM_APP + 43;
const FINISH_REVEAL: u32 = WM_APP + 44;
const REDRAW: u32 = 1;
const RELAYOUT: u32 = 2;
const DRAIN: u32 = 4;
const CHECK_POINTER: u32 = 8;
const COLLAPSE: u32 = 16;
const ANIMATE: u32 = 32;
const FINISH: u32 = 64;
const EDGE_HIDE_TIMER: usize = 2;
const EDGE_ANIMATION_TIMER: usize = 3;
const BAR_CLASS: PCWSTR = w!("DitaListRust.NativeBar");
const PANEL_CLASS: PCWSTR = w!("DitaListRust.ReminderPanel");
const DRAG: usize = 10;
const TODAY: usize = 11;
const PENDING: usize = 12;
const REMINDERS: usize = 13;
const ADD: usize = 14;
const ACK: usize = 21;
const SNOOZE: usize = 22;
const VIEW: usize = 23;
const DISMISS: usize = 24;

#[derive(Clone, Copy)]
pub struct Anchor {
    pub right: f64,
    pub top: f64,
    pub scale: f64,
    pub work_x: f64,
    pub work_y: f64,
    pub work_width: f64,
    pub work_bottom: f64,
}
impl Default for Anchor {
    fn default() -> Self {
        Self {
            right: 1000.,
            top: 700.,
            scale: 1.,
            work_x: 0.,
            work_y: 0.,
            work_width: 1920.,
            work_bottom: 1080.,
        }
    }
}

pub enum NativeCommand {
    Snapshot(Box<CoreSnapshot>),
    InputActive(bool),
    ShowReminders,
    BeginDrag { x: i32, y: i32 },
    Shutdown,
}

pub(super) fn primary_button_down() -> bool {
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 }
}

#[derive(Clone)]
pub struct NativeHandle {
    sender: mpsc::Sender<NativeCommand>,
    hwnd: Arc<AtomicIsize>,
    anchor: Arc<Mutex<Anchor>>,
}
impl NativeHandle {
    pub fn send(&self, message: NativeCommand) {
        if self.sender.send(message).is_ok() {
            unsafe {
                let handle = self.hwnd.load(Ordering::Acquire);
                if handle != 0 {
                    let _ = PostMessageW(
                        Some(HWND(handle as *mut c_void)),
                        UPDATE,
                        WPARAM(0),
                        LPARAM(0),
                    );
                }
            }
        }
    }
    pub fn anchor(&self) -> Anchor {
        *self.anchor.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn start(actions: mpsc::Sender<DesktopAction>) -> Result<NativeHandle, String> {
    let (sender, receiver) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let hwnd = Arc::new(AtomicIsize::new(0));
    let anchor = Arc::new(Mutex::new(Anchor::default()));
    let thread_hwnd = hwnd.clone();
    let thread_anchor = anchor.clone();
    thread::Builder::new()
        .name("ditalist-native-ui".into())
        .spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let result = Runtime::create(receiver, actions.clone(), thread_anchor);
            match result {
                Ok(owner) => {
                    thread_hwnd.store(owner.runtime.borrow().bar.0 as isize, Ordering::Release);
                    let _ = ready_tx.send(Ok(()));
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                        if message.message == WM_KEYDOWN && message.wParam.0 == VK_ESCAPE.0 as usize
                        {
                            owner.runtime.borrow_mut().hide_panel();
                            owner.flush(owner.runtime.borrow().bar);
                            continue;
                        }
                        let dialog = {
                            let runtime = owner.runtime.borrow();
                            if IsWindowVisible(runtime.panel).as_bool() {
                                runtime.panel
                            } else {
                                runtime.bar
                            }
                        };
                        if !IsDialogMessageW(dialog, &message).as_bool() {
                            let _ = TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                    thread_hwnd.store(0, Ordering::Release);
                    let (panel, bar) = {
                        let runtime = owner.runtime.borrow();
                        (runtime.panel, runtime.bar)
                    };
                    let _ = DestroyWindow(panel);
                    let _ = DestroyWindow(bar);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            }
            CoUninitialize();
        })
        .map_err(|e| e.to_string())?;
    ready_rx.recv().map_err(|e| e.to_string())??;
    Ok(NativeHandle {
        sender,
        hwnd,
        anchor,
    })
}

pub fn unpresented_reminders(snapshot: &CoreSnapshot) -> Vec<&ReminderEvent> {
    snapshot
        .reminders
        .iter()
        .filter(|event| !event.notified && due(event) && trigger_today(event))
        .collect()
}
pub(super) fn presentation_key(event: &ReminderEvent) -> (String, String) {
    // Snoozing keeps the event id but creates a new presentation at a new trigger time.
    (
        event.id.clone(),
        event
            .snoozed_until
            .as_ref()
            .unwrap_or(&event.due_at)
            .clone(),
    )
}
fn due(event: &ReminderEvent) -> bool {
    !event.handled
        && !event.invalidated
        && DateTime::parse_from_rfc3339(event.snoozed_until.as_deref().unwrap_or(&event.due_at))
            .map(|time| time.with_timezone(&Utc) <= Utc::now())
            .unwrap_or(false)
}
fn trigger_today(event: &ReminderEvent) -> bool {
    DateTime::parse_from_rfc3339(event.snoozed_until.as_deref().unwrap_or(&event.due_at))
        .map(|time| time.with_timezone(&Local).date_naive() == Local::now().date_naive())
        .unwrap_or(false)
}

struct Button {
    hwnd: HWND,
    id: usize,
    label: String,
    width: f32,
    left: f32,
    shown: bool,
    tooltip: Vec<u16>,
}

fn clicked_button<'a>(
    wparam: WPARAM,
    lparam: LPARAM,
    mut buttons: impl Iterator<Item = &'a Button>,
) -> Option<usize> {
    if (wparam.0 >> 16) & 0xffff != BN_CLICKED as usize || lparam.0 == 0 {
        return None;
    }
    let id = wparam.0 & 0xffff;
    buttons
        .find(|button| button.id == id && button.hwnd.0 as isize == lparam.0)
        .map(|button| button.id)
}
enum Panel {
    None,
    Reminder { id: String, automatic: bool },
    Agent { automatic: bool },
}
struct Runtime {
    bar: HWND,
    panel: HWND,
    tooltip: HWND,
    buttons: Vec<Button>,
    panel_buttons: Vec<Button>,
    renderer: Renderer,
    commands: mpsc::Receiver<NativeCommand>,
    actions: mpsc::Sender<DesktopAction>,
    snapshot: Option<CoreSnapshot>,
    input_active: bool,
    dragging: bool,
    dock: Dock,
    collapsed: bool,
    expanded_rect: RECT,
    edge_hide_due: Option<Instant>,
    last_presentation: Option<(bool, bool)>,
    transition: Option<BarTransition>,
    ignore_reveal_at: Option<POINT>,
    panel_state: Panel,
    panel_painted: bool,
    presented: HashSet<(String, String)>,
    last_pending: Option<u32>,
    anchor: Arc<Mutex<Anchor>>,
    dpi: f32,
}

struct WindowData {
    runtime: RefCell<Runtime>,
    deferred: Cell<u32>,
    actions: mpsc::Sender<DesktopAction>,
}
impl WindowData {
    unsafe fn flush(&self, hwnd: HWND) {
        unsafe {
            let flags = self.deferred.replace(0);
            if flags != 0 {
                let _ = PostMessageW(Some(hwnd), DEFERRED, WPARAM(flags as usize), LPARAM(0));
            }
        }
    }
}

impl Runtime {
    unsafe fn create(
        commands: mpsc::Receiver<NativeCommand>,
        actions: mpsc::Sender<DesktopAction>,
        anchor: Arc<Mutex<Anchor>>,
    ) -> Result<Box<WindowData>, String> {
        unsafe {
            let instance = HINSTANCE(GetModuleHandleW(None).map_err(|e| e.to_string())?.0);
            InitCommonControlsEx(&INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_WIN95_CLASSES,
            })
            .ok()
            .map_err(|e| e.to_string())?;
            let cursor = LoadCursorW(None, IDC_ARROW).map_err(|e| e.to_string())?;
            for class in [BAR_CLASS, PANEL_CLASS] {
                let wc = WNDCLASSW {
                    style: CS_HREDRAW
                        | CS_VREDRAW
                        | if class == PANEL_CLASS {
                            CS_DROPSHADOW
                        } else {
                            WNDCLASS_STYLES(0)
                        },
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance,
                    hCursor: cursor,
                    lpszClassName: class,
                    ..Default::default()
                };
                if RegisterClassW(&wc) == 0 {
                    return Err(windows::core::Error::from_thread().to_string());
                }
            }
            let renderer = Renderer::new().map_err(|e| e.to_string())?;
            let owner = Box::new(WindowData {
                actions: actions.clone(),
                deferred: Cell::new(0),
                runtime: RefCell::new(Self {
                    bar: HWND::default(),
                    panel: HWND::default(),
                    tooltip: HWND::default(),
                    buttons: Vec::new(),
                    panel_buttons: Vec::new(),
                    renderer,
                    commands,
                    actions,
                    snapshot: None,
                    input_active: false,
                    dragging: false,
                    dock: Dock::default(),
                    collapsed: false,
                    expanded_rect: RECT::default(),
                    edge_hide_due: None,
                    last_presentation: None,
                    transition: None,
                    ignore_reveal_at: None,
                    panel_state: Panel::None,
                    panel_painted: false,
                    presented: HashSet::new(),
                    last_pending: None,
                    anchor,
                    dpi: 96.,
                }),
            });
            let data = (&*owner) as *const WindowData as *mut c_void;
            let mut runtime_guard = owner.runtime.borrow_mut();
            let this = &mut *runtime_guard;
            this.bar = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                BAR_CLASS,
                w!("DitaList · 悬浮栏"),
                WS_POPUP | WS_CLIPCHILDREN,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                180,
                40,
                None,
                None,
                Some(instance),
                Some(data),
            )
            .map_err(|e| e.to_string())?;
            this.panel = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                PANEL_CLASS,
                w!("DitaList · 提醒"),
                WS_POPUP | WS_CLIPCHILDREN,
                0,
                0,
                320,
                156,
                Some(this.bar),
                None,
                Some(instance),
                Some(data),
            )
            .map_err(|e| e.to_string())?;
            for (id, label, width) in [
                (DRAG, "⋮⋮", 40.),
                (TODAY, "今天 0", 100.),
                (PENDING, "待确认 0", 104.),
                (REMINDERS, "提醒 0", 80.),
                (ADD, "＋", 40.),
            ] {
                this.buttons
                    .push(Self::button(this.bar, instance, id, label, width)?);
            }
            for button in &this.buttons {
                SetWindowSubclass(button.hwnd, Some(button_proc), 1, button.id)
                    .ok()
                    .map_err(|e| e.to_string())?;
            }
            for (id, label, width) in [
                (ACK, "知道了", 86.),
                (SNOOZE, "稍后 10 分钟", 116.),
                (VIEW, "查看任务", 86.),
                (DISMISS, "×", 32.),
            ] {
                this.panel_buttons
                    .push(Self::button(this.panel, instance, id, label, width)?);
            }
            this.tooltip = CreateWindowExW(
                WS_EX_TOPMOST,
                TOOLTIPS_CLASSW,
                PCWSTR::null(),
                WS_POPUP | WINDOW_STYLE(TTS_ALWAYSTIP | TTS_NOPREFIX),
                0,
                0,
                0,
                0,
                Some(this.bar),
                None,
                Some(instance),
                None,
            )
            .map_err(|e| e.to_string())?;
            SendMessageW(this.tooltip, TTM_SETMAXTIPWIDTH, None, Some(LPARAM(360)));
            SendMessageW(
                this.tooltip,
                TTM_SETDELAYTIME,
                Some(WPARAM(TTDT_INITIAL as usize)),
                Some(LPARAM(500)),
            );
            for button in &mut this.buttons {
                let info = TTTOOLINFOW {
                    cbSize: std::mem::size_of::<TTTOOLINFOW>() as u32,
                    uFlags: TTF_IDISHWND | TTF_SUBCLASS,
                    hwnd: this.bar,
                    uId: button.hwnd.0 as usize,
                    lpszText: PWSTR(button.tooltip.as_mut_ptr()),
                    ..Default::default()
                };
                SendMessageW(
                    this.tooltip,
                    TTM_ADDTOOLW,
                    None,
                    Some(LPARAM((&info) as *const _ as isize)),
                );
            }
            this.dpi = GetDpiForWindow(this.bar).max(96) as f32;
            let mut work = RECT::default();
            let _ = SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                Some((&mut work) as *mut _ as *mut c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            );
            let scale = this.dpi / 96.;
            let _ = SetWindowPos(
                this.bar,
                Some(HWND_TOPMOST),
                work.right - (204. * scale) as i32,
                work.bottom - (76. * scale) as i32,
                (180. * scale) as i32,
                (40. * scale) as i32,
                SWP_NOACTIVATE,
            );
            let _ = GetWindowRect(this.bar, &mut this.expanded_rect);
            this.layout();
            this.update_anchor();
            let _ = ShowWindow(this.bar, SW_SHOWNOACTIVATE);
            let bar = this.bar;
            drop(runtime_guard);
            owner.flush(bar);
            Ok(owner)
        }
    }

    unsafe fn button(
        parent: HWND,
        instance: HINSTANCE,
        id: usize,
        label: &str,
        width: f32,
    ) -> Result<Button, String> {
        unsafe {
            let text = wide(label);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("BUTTON"),
                PCWSTR(text.as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(BS_OWNERDRAW as u32),
                0,
                0,
                width as i32,
                40,
                Some(parent),
                Some(HMENU(id as *mut c_void)),
                Some(instance),
                None,
            )
            .map_err(|e| e.to_string())?;
            Ok(Button {
                hwnd,
                id,
                label: label.into(),
                width,
                left: 0.,
                shown: true,
                tooltip: wide(label),
            })
        }
    }

    unsafe fn drain(&mut self) {
        unsafe {
            while let Ok(command) = self.commands.try_recv() {
                match command {
                    NativeCommand::Snapshot(snapshot) => {
                        let redraw = self.snapshot.as_ref().is_none_or(|old| {
                            old.today_count != snapshot.today_count
                                || old.pending_count != snapshot.pending_count
                                || old.reminder_count != snapshot.reminder_count
                                || old.preferences.floating_visible
                                    != snapshot.preferences.floating_visible
                                || old.data.settings.theme != snapshot.data.settings.theme
                                || old.data.settings.accent != snapshot.data.settings.accent
                        });
                        let previous_text = self.panel_text();
                        self.snapshot = Some(*snapshot);
                        self.refresh(redraw);
                        if previous_text != self.panel_text() {
                            let _ = InvalidateRect(Some(self.panel), None, false);
                        }
                    }
                    NativeCommand::InputActive(active) => {
                        self.stop_transition();
                        self.input_active = active;
                        if active {
                            self.hide_panel();
                            self.cancel_edge_hide();
                        } else if self.dock.is_docked() {
                            self.collapsed = true;
                        }
                        self.refresh(true);
                    }
                    NativeCommand::ShowReminders => self.show_reminders(false),
                    NativeCommand::BeginDrag { x, y } => {
                        if GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 {
                            self.stop_transition();
                            self.dock = Dock::default();
                            self.collapsed = false;
                            self.cancel_edge_hide();
                            self.layout();
                            let _ = SetWindowPos(
                                self.bar,
                                Some(HWND_TOPMOST),
                                x,
                                y,
                                0,
                                0,
                                SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                            );
                            // WM_MOVE can reenter while drain holds the Runtime
                            // borrow, so preserve this move before refresh lays out.
                            self.update_anchor();
                            let _ = ReleaseCapture();
                            let mut point = POINT::default();
                            let _ = GetCursorPos(&mut point);
                            let position =
                                ((point.y as u32 & 0xffff) << 16) | (point.x as u32 & 0xffff);
                            // Release the Runtime RefCell borrow before User32
                            // enters its modal move loop and reenters window_proc.
                            let _ = PostMessageW(
                                Some(self.bar),
                                WM_NCLBUTTONDOWN,
                                WPARAM(HTCAPTION as usize),
                                LPARAM(position as isize),
                            );
                            self.refresh(true);
                        }
                    }
                    NativeCommand::Shutdown => {
                        PostQuitMessage(0);
                        return;
                    }
                }
            }
        }
    }

    unsafe fn refresh(&mut self, redraw: bool) {
        unsafe {
            let Some(snapshot) = self.snapshot.as_ref() else {
                return;
            };
            let visible = snapshot.preferences.floating_visible && !self.input_active;
            let pending = snapshot.pending_count;
            let notify_agent = self.last_pending.is_some_and(|old| pending > old);
            self.last_pending = Some(pending);
            let quiet = snapshot.preferences.quiet || !snapshot.data.settings.notifications;
            let ids = unpresented_reminders(snapshot)
                .into_iter()
                .filter(|r| !self.presented.contains(&presentation_key(r)))
                .map(|r| r.id.clone())
                .collect::<Vec<_>>();
            if let Panel::Reminder { id, .. } = &self.panel_state
                && !snapshot.reminders.iter().any(|r| &r.id == id && due(r))
            {
                self.hide_panel();
            }
            if visible {
                if !IsWindowVisible(self.bar).as_bool() {
                    let _ = ShowWindow(self.bar, SW_SHOWNOACTIVATE);
                }
            } else {
                self.cancel_edge_hide();
                self.stop_transition();
                let _ = ShowWindow(self.bar, SW_HIDE);
                self.hide_panel();
            }
            if redraw && !self.dragging {
                self.layout();
            }
            if visible && !quiet && !self.dragging && matches!(self.panel_state, Panel::None) {
                if !ids.is_empty() {
                    self.show_reminders(true);
                } else if notify_agent {
                    self.panel_state = Panel::Agent { automatic: true };
                    self.show_panel(true);
                }
            }
        }
    }

    unsafe fn layout(&mut self) {
        unsafe {
            let scale = self.dpi / 96.;
            let (today, pending, reminders) = self
                .snapshot
                .as_ref()
                .map(|s| (s.today_count, s.pending_count, s.reminder_count))
                .unwrap_or((0, 0, 0));
            let mut x = 0.;
            for button in &mut self.buttons {
                let shown = match button.id {
                    PENDING => pending > 0,
                    REMINDERS => reminders > 0,
                    _ => true,
                };
                button.label = match button.id {
                    TODAY => format!("今天 {}", number(today)),
                    PENDING => format!("待确认 {}", number(pending)),
                    REMINDERS => format!("提醒 {}", number(reminders)),
                    _ => button.label.clone(),
                };
                let accessible = match button.id {
                    TODAY => format!("今天 {today} 项待办"),
                    PENDING => format!("Agent 待确认 {pending} 项"),
                    REMINDERS => format!("到时提醒 {reminders} 项"),
                    ADD => "快速添加任务".into(),
                    DRAG => "拖到屏幕边缘收成细线，移入展开；拖离边缘恢复悬浮".into(),
                    _ => button.label.clone(),
                };
                let label = wide(&accessible);
                let _ = SetWindowTextW(button.hwnd, PCWSTR(label.as_ptr()));
                button.tooltip = wide(&accessible);
                let info = TTTOOLINFOW {
                    cbSize: std::mem::size_of::<TTTOOLINFOW>() as u32,
                    uFlags: TTF_IDISHWND | TTF_SUBCLASS,
                    hwnd: self.bar,
                    uId: button.hwnd.0 as usize,
                    lpszText: PWSTR(button.tooltip.as_mut_ptr()),
                    ..Default::default()
                };
                SendMessageW(
                    self.tooltip,
                    TTM_UPDATETIPTEXTW,
                    None,
                    Some(LPARAM((&info) as *const _ as isize)),
                );
                button.shown = shown;
                button.left = x;
                if shown {
                    x += button.width;
                }
            }
            let width = (x * scale) as i32;
            let height = (40. * scale) as i32;
            let work = work_area(self.bar);
            let position = self.dock.position(self.expanded_rect, width, height, work);
            self.expanded_rect = RECT {
                left: position.x,
                top: position.y,
                right: position.x + width,
                bottom: position.y + height,
            };
            let target = if self.collapsed {
                self.dock.collapsed_rect(self.expanded_rect, work, self.dpi)
            } else {
                self.expanded_rect
            };
            if let Some(motion) = &mut self.transition {
                motion.target = target;
                self.step_transition();
            } else {
                self.apply_bar_frame(target);
            }
            self.position_panel();
            self.update_anchor();
            let _ = InvalidateRect(Some(self.panel), None, false);
        }
    }

    unsafe fn apply_bar_frame(&mut self, rect: RECT) {
        unsafe {
            let scale = self.dpi / 96.;
            let _ = SetWindowPos(
                self.bar,
                Some(HWND_TOPMOST),
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOACTIVATE,
            );
            self.round(
                self.bar,
                rect.right - rect.left,
                rect.bottom - rect.top,
                scale,
            );
            for button in &self.buttons {
                if button.shown && (!self.collapsed || self.transition.is_some()) {
                    let _ = SetWindowPos(
                        button.hwnd,
                        None,
                        (button.left * scale) as i32 + self.expanded_rect.left - rect.left,
                        self.expanded_rect.top - rect.top,
                        (button.width * scale) as i32,
                        (40. * scale) as i32,
                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                    let _ = InvalidateRect(Some(button.hwnd), None, false);
                } else {
                    let _ = ShowWindow(button.hwnd, SW_HIDE);
                }
            }
            let _ = SetWindowTextW(
                self.bar,
                if self.collapsed {
                    w!("DitaList · 贴边细线，移入展开")
                } else {
                    w!("DitaList · 悬浮栏")
                },
            );
            let _ = InvalidateRect(Some(self.bar), None, false);
            let presentation = (self.dock.is_docked(), self.collapsed);
            if self.transition.is_none() && self.last_presentation != Some(presentation) {
                self.last_presentation = Some(presentation);
                let _ = self.actions.send(DesktopAction::BarPresentation {
                    state: if self.collapsed {
                        "edge"
                    } else if self.dock.is_docked() {
                        "expanded"
                    } else {
                        "floating"
                    },
                    bounds: [rect.left, rect.top, rect.right, rect.bottom],
                });
            }
        }
    }

    unsafe fn round(&self, hwnd: HWND, width: i32, height: i32, scale: f32) {
        unsafe {
            let region = CreateRoundRectRgn(
                0,
                0,
                width + 1,
                height + 1,
                corner_diameter(width, height, scale * 96.),
                corner_diameter(width, height, scale * 96.),
            );
            // SetWindowRgn takes ownership on success.
            if SetWindowRgn(hwnd, Some(region), true) == 0 {
                let _ = DeleteObject(region.into());
            }
        }
    }

    unsafe fn update_anchor(&mut self) {
        unsafe {
            if !self.collapsed && self.transition.is_none() {
                let _ = GetWindowRect(self.bar, &mut self.expanded_rect);
            }
            let rect = self.expanded_rect;
            let work = work_area(self.bar);
            *self.anchor.lock().unwrap_or_else(|e| e.into_inner()) = Anchor {
                right: rect.right as f64,
                top: rect.top as f64,
                scale: (self.dpi / 96.) as f64,
                work_x: work.left as f64,
                work_y: work.top as f64,
                work_width: (work.right - work.left) as f64,
                work_bottom: work.bottom as f64,
            };
        }
    }

    unsafe fn cancel_edge_hide(&mut self) {
        self.edge_hide_due = None;
        unsafe {
            let _ = KillTimer(Some(self.bar), EDGE_HIDE_TIMER);
        }
    }

    unsafe fn stop_transition(&mut self) {
        self.transition = None;
        unsafe {
            let _ = KillTimer(Some(self.bar), EDGE_ANIMATION_TIMER);
        }
    }

    unsafe fn transition_to(&mut self, collapsed: bool) {
        unsafe {
            self.stop_transition();
            self.collapsed = collapsed;
            let mut cursor = POINT::default();
            self.ignore_reveal_at = if collapsed && GetCursorPos(&mut cursor).is_ok() {
                Some(cursor)
            } else {
                None
            };
            if self.dock.is_docked()
                && client_animations_enabled()
                && IsWindowVisible(self.bar).as_bool()
            {
                let mut current = RECT::default();
                let _ = GetWindowRect(self.bar, &mut current);
                self.transition = Some(BarTransition::new(current, Instant::now()));
                if SetTimer(Some(self.bar), EDGE_ANIMATION_TIMER, 16, None) == 0 {
                    self.transition = None;
                }
            }
            self.layout();
        }
    }

    unsafe fn step_transition(&mut self) {
        unsafe {
            let Some(motion) = &self.transition else {
                return;
            };
            let (rect, complete) = motion.frame(Instant::now());
            if complete {
                self.stop_transition();
            }
            self.apply_bar_frame(rect);
            if complete {
                self.update_anchor();
                if !self.collapsed && !cursor_inside(self.bar) {
                    self.schedule_edge_hide();
                }
            }
        }
    }

    unsafe fn finish_reveal(&mut self) {
        unsafe {
            self.cancel_edge_hide();
            if self.transition.is_some() || self.collapsed {
                self.stop_transition();
                self.collapsed = false;
                self.layout();
            }
        }
    }

    fn can_collapse(&self) -> bool {
        self.dock.is_docked()
            && !self.collapsed
            && !self.dragging
            && !self.input_active
            && matches!(self.panel_state, Panel::None)
    }

    unsafe fn schedule_edge_hide(&mut self) {
        unsafe {
            self.cancel_edge_hide();
            if self.can_collapse() && IsWindowVisible(self.bar).as_bool() {
                self.edge_hide_due = Some(Instant::now() + Duration::from_millis(500));
                SetTimer(Some(self.bar), EDGE_HIDE_TIMER, 500, None);
            }
        }
    }

    unsafe fn reveal(&mut self) {
        unsafe {
            self.cancel_edge_hide();
            if self.collapsed && !self.input_active {
                self.transition_to(false);
            }
        }
    }

    unsafe fn pointer_changed(&mut self) {
        unsafe {
            if cursor_inside(self.bar) {
                let mut cursor = POINT::default();
                let _ = GetCursorPos(&mut cursor);
                // Resizing a window can produce mouse-move messages without
                // physical movement. A drop must not undo its own hide animation.
                if !self.collapsed || self.ignore_reveal_at != Some(cursor) {
                    self.reveal();
                }
            } else {
                self.schedule_edge_hide();
            }
        }
    }

    unsafe fn collapse_if_idle(&mut self) {
        unsafe {
            if self.edge_hide_due.is_none_or(|due| Instant::now() < due) {
                return;
            }
            // A single delayed check, never an idle polling timer. A later
            // WM_MOUSELEAVE will arm a fresh check if the cursor returned.
            self.cancel_edge_hide();
            let capture = GetCapture();
            let interacting = capture == self.bar || IsChild(self.bar, capture).as_bool();
            if self.can_collapse() && !interacting && !cursor_inside(self.bar) {
                self.transition_to(true);
            }
        }
    }

    unsafe fn show_reminders(&mut self, automatic: bool) {
        unsafe {
            let Some(snapshot) = self.snapshot.as_ref() else {
                return;
            };
            let next = if automatic {
                unpresented_reminders(snapshot)
                    .into_iter()
                    .find(|r| !self.presented.contains(&presentation_key(r)))
            } else {
                snapshot.reminders.iter().find(|r| due(r))
            };
            if let Some(event) = next {
                self.panel_state = Panel::Reminder {
                    id: event.id.clone(),
                    automatic,
                };
                self.show_panel(automatic);
            }
        }
    }

    unsafe fn show_panel(&mut self, automatic: bool) {
        unsafe {
            self.reveal();
            self.panel_painted = false;
            self.position_panel();
            let title = wide(&self.panel_text().1);
            let _ = SetWindowTextW(self.panel, PCWSTR(title.as_ptr()));
            let _ = ShowWindow(
                self.panel,
                if automatic {
                    SW_SHOWNOACTIVATE
                } else {
                    SW_SHOW
                },
            );
            if !automatic {
                let _ = SetForegroundWindow(self.panel);
                if let Some(button) = self.panel_buttons.first() {
                    let _ = SetFocus(Some(button.hwnd));
                }
            }
            let _ = InvalidateRect(Some(self.panel), None, false);
            let _ = UpdateWindow(self.panel);
            if automatic {
                SetTimer(Some(self.panel), 1, 5000, None);
            } else {
                let _ = KillTimer(Some(self.panel), 1);
            }
        }
    }

    unsafe fn hide_panel(&mut self) {
        unsafe {
            let _ = KillTimer(Some(self.panel), 1);
            let _ = ShowWindow(self.panel, SW_HIDE);
            self.panel_state = Panel::None;
            self.schedule_edge_hide();
        }
    }

    unsafe fn position_panel(&mut self) {
        unsafe {
            let scale = self.dpi / 96.;
            let width = (320. * scale) as i32;
            let height = (156. * scale) as i32;
            let work = work_area(self.bar);
            let bar = self.expanded_rect;
            let left = (bar.right - width).max(work.left).min(work.right - width);
            let top = if bar.bottom + (8. * scale) as i32 + height <= work.bottom {
                bar.bottom + (8. * scale) as i32
            } else {
                bar.top - (8. * scale) as i32 - height
            };
            let _ = SetWindowPos(
                self.panel,
                Some(HWND_TOPMOST),
                left,
                top.max(work.top),
                width,
                height,
                SWP_NOACTIVATE,
            );
            self.round(self.panel, width, height, scale);
            let agent = matches!(self.panel_state, Panel::Agent { .. });
            let mut x = 10.;
            for button in &mut self.panel_buttons {
                let (bx, by, bw, bh) = if button.id == DISMISS {
                    (280., 4., 32., 32.)
                } else {
                    let result = (x, 112., button.width, 36.);
                    x += button.width + 4.;
                    result
                };
                let show = !agent || button.id == VIEW || button.id == DISMISS;
                button.label = if button.id == VIEW {
                    if agent {
                        "查看待确认"
                    } else {
                        "查看任务"
                    }
                    .into()
                } else {
                    button.label.clone()
                };
                let text = wide(&button.label);
                let _ = SetWindowTextW(button.hwnd, PCWSTR(text.as_ptr()));
                if show {
                    let _ = SetWindowPos(
                        button.hwnd,
                        None,
                        (bx * scale) as i32,
                        (by * scale) as i32,
                        (bw * scale) as i32,
                        (bh * scale) as i32,
                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                } else {
                    let _ = ShowWindow(button.hwnd, SW_HIDE);
                }
                let _ = InvalidateRect(Some(button.hwnd), None, false);
            }
        }
    }

    fn panel_text(&self) -> (String, String) {
        match &self.panel_state {
            Panel::Reminder { id, .. } => {
                let Some(snapshot) = &self.snapshot else {
                    return ("到时提醒".into(), String::new());
                };
                let task = snapshot
                    .reminders
                    .iter()
                    .find(|r| &r.id == id)
                    .and_then(|r| snapshot.data.tasks.iter().find(|t| t.id == r.task_id));
                let text = task
                    .map(|t| {
                        format!(
                            "{}{}",
                            t.time
                                .as_ref()
                                .map(|time| format!("{time}  "))
                                .unwrap_or_default(),
                            t.title
                        )
                    })
                    .unwrap_or_default();
                let count = snapshot.reminder_count;
                let title = if count > 1 {
                    format!("到时提醒 · 共 {count} 条")
                } else {
                    "到时提醒".into()
                };
                (title, text)
            }
            Panel::Agent { .. } => (
                "Agent 待确认".into(),
                format!(
                    "{} 条申请等待你确认",
                    self.snapshot.as_ref().map(|s| s.pending_count).unwrap_or(0)
                ),
            ),
            Panel::None => (String::new(), String::new()),
        }
    }

    unsafe fn command(&mut self, id: usize) {
        unsafe {
            let action = match id {
                TODAY => Some(DesktopAction::Navigate {
                    view: "today".into(),
                    task_id: None,
                }),
                PENDING => Some(DesktopAction::Navigate {
                    view: "agent-review".into(),
                    task_id: None,
                }),
                ADD => Some(DesktopAction::OpenQuick),
                REMINDERS => {
                    if matches!(self.panel_state, Panel::None) {
                        self.show_reminders(false);
                    } else {
                        self.hide_panel();
                    }
                    None
                }
                ACK | SNOOZE => {
                    if let Panel::Reminder { id: event_id, .. } = &self.panel_state {
                        let action = DesktopAction::Command(Operation::Reminder {
                            id: event_id.clone(),
                            action: if id == ACK { "acknowledge" } else { "snooze" }.into(),
                        });
                        self.hide_panel();
                        Some(action)
                    } else {
                        None
                    }
                }
                VIEW => match &self.panel_state {
                    Panel::Reminder { id, .. } => {
                        let task_id = self
                            .snapshot
                            .as_ref()
                            .and_then(|s| s.reminders.iter().find(|r| &r.id == id))
                            .map(|r| r.task_id.clone());
                        Some(DesktopAction::Navigate {
                            view: "today".into(),
                            task_id,
                        })
                    }
                    Panel::Agent { .. } => Some(DesktopAction::Navigate {
                        view: "agent-review".into(),
                        task_id: None,
                    }),
                    _ => None,
                },
                DISMISS => {
                    self.hide_panel();
                    None
                }
                _ => None,
            };
            if let Some(action) = action {
                let _ = self.actions.send(action);
            }
        }
    }

    unsafe fn context_menu(&mut self) {
        unsafe {
            self.finish_reveal();
            let Ok(menu) = CreatePopupMenu() else {
                return;
            };
            for (id, label) in [
                (101, "打开 DitaList"),
                (102, "快速添加"),
                (103, "Agent 待确认"),
                (104, "查看提醒"),
                (105, "隐藏悬浮栏"),
                (106, "安静模式"),
                (107, "MCP 通道"),
                (108, "退出 DitaList"),
            ] {
                let checked = self.snapshot.as_ref().is_some_and(|s| {
                    (id == 106 && s.preferences.quiet) || (id == 107 && s.preferences.mcp_enabled)
                });
                let text = wide(label);
                let _ = AppendMenuW(
                    menu,
                    if checked {
                        MF_STRING | MF_CHECKED
                    } else {
                        MF_STRING
                    },
                    id,
                    PCWSTR(text.as_ptr()),
                );
            }
            let mut point = POINT::default();
            let _ = GetCursorPos(&mut point);
            let _ = SetForegroundWindow(self.bar);
            let result = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_NONOTIFY,
                point.x,
                point.y,
                None,
                self.bar,
                None,
            )
            .0 as usize;
            let _ = DestroyMenu(menu);
            match result {
                101 => self.command(TODAY),
                102 => self.command(ADD),
                103 => self.command(PENDING),
                104 => self.show_reminders(false),
                105..=107 => {
                    let patch = match result {
                        105 => json!({"floatingVisible":false}),
                        106 => {
                            json!({"quiet":!self.snapshot.as_ref().is_some_and(|s|s.preferences.quiet)})
                        }
                        _ => {
                            json!({"mcpEnabled":!self.snapshot.as_ref().is_some_and(|s|s.preferences.mcp_enabled)})
                        }
                    };
                    let _ =
                        self.actions
                            .send(DesktopAction::Command(Operation::PreferencesUpdate {
                                patch,
                            }));
                }
                108 => {
                    let _ = self.actions.send(DesktopAction::Quit);
                }
                _ => {}
            }
            self.schedule_edge_hide();
        }
    }

    unsafe fn paint(&mut self, hwnd: HWND) {
        unsafe {
            let mut paint = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut paint);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            let theme = self.theme();
            let panel = hwnd == self.panel;
            let first_paint = panel && !self.panel_painted;
            let (title, body) = self.panel_text();
            let result = if !panel && self.collapsed && self.transition.is_none() {
                self.renderer.edge_line(hdc, rect)
            } else {
                self.renderer.surface(
                    hdc,
                    rect,
                    self.dpi / 96.,
                    &theme,
                    None,
                    panel.then_some((&title, &body)),
                    false,
                    false,
                )
            };
            if let Err(error) = result {
                let _ = self
                    .actions
                    .send(DesktopAction::Error(format!("原生绘制失败：{error}")));
                if let Ok(renderer) = Renderer::new() {
                    self.renderer = renderer;
                }
            } else if panel {
                self.panel_painted = true;
            }
            let _ = EndPaint(hwnd, &paint);
            if first_paint && self.panel_painted && IsWindowVisible(self.panel).as_bool() {
                self.record_presentation();
            }
        }
    }

    unsafe fn record_presentation(&mut self) {
        unsafe {
            if let Panel::Reminder { id, automatic } = &self.panel_state {
                // A summary contains one task plus the batch count; only a successfully painted batch is acknowledged.
                let events = self
                    .snapshot
                    .as_ref()
                    .map(|snapshot| {
                        if *automatic {
                            unpresented_reminders(snapshot)
                        } else {
                            snapshot.reminders.iter().filter(|r| &r.id == id).collect()
                        }
                    })
                    .unwrap_or_default();
                let ids = events.iter().map(|r| r.id.clone()).collect();
                self.presented
                    .extend(events.into_iter().map(presentation_key));
                let _ = self.actions.send(DesktopAction::ReminderPresented(ids));
                if *automatic
                    && self
                        .snapshot
                        .as_ref()
                        .is_some_and(|s| s.data.settings.sound && !s.preferences.quiet)
                {
                    let _ = MessageBeep(MB_ICONINFORMATION);
                }
            }
        }
    }

    unsafe fn draw_button(&mut self, item: &DRAWITEMSTRUCT) {
        unsafe {
            let id = item.CtlID as usize;
            let label = self
                .buttons
                .iter()
                .chain(&self.panel_buttons)
                .find(|b| b.id == id)
                .map(|b| b.label.clone())
                .unwrap_or_default();
            let theme = self.theme();
            let focus = (item.itemState.0 & ODS_FOCUS.0) != 0;
            let pressed = (item.itemState.0 & ODS_SELECTED.0) != 0;
            let accent = id == ADD || id == SNOOZE;
            let _ = self.renderer.surface(
                item.hDC,
                item.rcItem,
                self.dpi / 96.,
                &theme,
                Some((&label, accent)),
                None,
                focus,
                pressed,
            );
        }
    }
    fn theme(&self) -> Theme {
        Theme::from_snapshot(self.snapshot.as_ref())
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        if message == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowData;
        if pointer.is_null() {
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        let owner = &*pointer;
        if !matches!(
            message,
            UPDATE
                | DEFERRED
                | POINTER_CHANGED
                | FINISH_REVEAL
                | WM_MOUSEMOVE
                | WM_MOUSELEAVE
                | WM_PAINT
                | WM_ERASEBKGND
                | WM_DRAWITEM
                | WM_COMMAND
                | WM_CONTEXTMENU
                | WM_CLOSE
                | WM_TIMER
                | WM_ACTIVATE
                | WM_ENTERSIZEMOVE
                | WM_EXITSIZEMOVE
                | WM_MOVE
                | WM_DPICHANGED
                | WM_DISPLAYCHANGE
                | WM_SETTINGCHANGE
                | WM_TIMECHANGE
                | WM_POWERBROADCAST
                | WM_QUERYENDSESSION
        ) {
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        let Ok(mut runtime_guard) = owner.runtime.try_borrow_mut() else {
            // User32 can call us synchronously from layout/painting. Never alias a live Rust &mut.
            let flags = match message {
                UPDATE => DRAIN,
                DEFERRED => wparam.0 as u32,
                POINTER_CHANGED | WM_MOUSEMOVE | WM_MOUSELEAVE => CHECK_POINTER,
                FINISH_REVEAL => FINISH,
                WM_TIMER if wparam.0 == EDGE_HIDE_TIMER => COLLAPSE,
                WM_TIMER if wparam.0 == EDGE_ANIMATION_TIMER => ANIMATE,
                WM_PAINT => {
                    let mut paint = PAINTSTRUCT::default();
                    BeginPaint(hwnd, &mut paint);
                    let _ = EndPaint(hwnd, &paint);
                    REDRAW
                }
                WM_DRAWITEM => REDRAW,
                WM_DPICHANGED | WM_DISPLAYCHANGE | WM_SETTINGCHANGE => RELAYOUT | REDRAW,
                WM_TIMECHANGE | WM_POWERBROADCAST => {
                    let _ = owner.actions.send(DesktopAction::Wake);
                    0
                }
                WM_QUERYENDSESSION => {
                    let _ = owner.actions.send(DesktopAction::Quit);
                    0
                }
                _ => 0,
            };
            owner.deferred.set(owner.deferred.get() | flags);
            return match message {
                WM_PAINT | UPDATE | DEFERRED => LRESULT(0),
                WM_ERASEBKGND | WM_DRAWITEM | WM_QUERYENDSESSION | WM_POWERBROADCAST => LRESULT(1),
                _ => DefWindowProcW(hwnd, message, wparam, lparam),
            };
        };
        let runtime = &mut *runtime_guard;
        let result = match message {
            DEFERRED => {
                let flags = wparam.0 as u32;
                if flags & DRAIN != 0 {
                    runtime.drain();
                }
                if flags & RELAYOUT != 0 {
                    runtime.stop_transition();
                    runtime.dpi = GetDpiForWindow(runtime.bar).max(96) as f32;
                    runtime.layout();
                }
                if flags & CHECK_POINTER != 0 {
                    runtime.pointer_changed();
                }
                if flags & COLLAPSE != 0 {
                    runtime.collapse_if_idle();
                }
                if flags & FINISH != 0 {
                    runtime.finish_reveal();
                }
                if flags & ANIMATE != 0 {
                    runtime.step_transition();
                }
                if flags & REDRAW != 0 {
                    let _ = InvalidateRect(Some(runtime.bar), None, false);
                    let _ = InvalidateRect(Some(runtime.panel), None, false);
                    for button in runtime.buttons.iter().chain(&runtime.panel_buttons) {
                        let _ = InvalidateRect(Some(button.hwnd), None, false);
                    }
                }
                LRESULT(0)
            }
            UPDATE => {
                runtime.drain();
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                if hwnd == runtime.bar {
                    track_mouse_leave(hwnd);
                    runtime.pointer_changed();
                }
                DefWindowProcW(hwnd, message, wparam, lparam)
            }
            POINTER_CHANGED | WM_MOUSELEAVE => {
                runtime.pointer_changed();
                LRESULT(0)
            }
            FINISH_REVEAL => {
                runtime.finish_reveal();
                LRESULT(0)
            }
            WM_PAINT => {
                runtime.paint(hwnd);
                LRESULT(0)
            }
            WM_ERASEBKGND => LRESULT(1),
            WM_DRAWITEM => {
                runtime.draw_button(&*(lparam.0 as *const DRAWITEMSTRUCT));
                LRESULT(1)
            }
            WM_COMMAND => {
                // Owner-drawn buttons also send focus/highlight notifications.
                // Only a click from the matching control can invoke its action.
                if let Some(id) = clicked_button(
                    wparam,
                    lparam,
                    runtime.buttons.iter().chain(&runtime.panel_buttons),
                ) {
                    runtime.command(id);
                }
                LRESULT(0)
            }
            WM_CONTEXTMENU => {
                runtime.context_menu();
                LRESULT(0)
            }
            WM_CLOSE => {
                if hwnd == runtime.panel {
                    runtime.hide_panel();
                } else {
                    let _ = runtime.actions.send(DesktopAction::Command(
                        Operation::PreferencesUpdate {
                            patch: json!({"floatingVisible":false}),
                        },
                    ));
                }
                LRESULT(0)
            }
            WM_TIMER => {
                if hwnd == runtime.bar && wparam.0 == EDGE_ANIMATION_TIMER {
                    runtime.step_transition();
                    LRESULT(0)
                } else if hwnd == runtime.bar && wparam.0 == EDGE_HIDE_TIMER {
                    runtime.collapse_if_idle();
                    LRESULT(0)
                } else if hwnd == runtime.panel && wparam.0 == 1 {
                    let mut cursor = POINT::default();
                    let _ = GetCursorPos(&mut cursor);
                    let mut rect = RECT::default();
                    let _ = GetWindowRect(runtime.panel, &mut rect);
                    let hovered = cursor.x >= rect.left
                        && cursor.x < rect.right
                        && cursor.y >= rect.top
                        && cursor.y < rect.bottom;
                    let active = GetForegroundWindow() == runtime.panel;
                    if !hovered && !active {
                        runtime.hide_panel();
                    }
                    LRESULT(0)
                } else {
                    DefWindowProcW(hwnd, message, wparam, lparam)
                }
            }
            WM_ACTIVATE => {
                if hwnd == runtime.panel && (wparam.0 & 0xffff) == WA_INACTIVE as usize {
                    let automatic = matches!(
                        runtime.panel_state,
                        Panel::Reminder {
                            automatic: true,
                            ..
                        } | Panel::Agent { automatic: true }
                    );
                    if !automatic {
                        runtime.hide_panel();
                    }
                }
                DefWindowProcW(hwnd, message, wparam, lparam)
            }
            WM_ENTERSIZEMOVE => {
                runtime.stop_transition();
                runtime.dragging = true;
                runtime.cancel_edge_hide();
                runtime.collapsed = false;
                runtime.dock = Dock::default();
                runtime.hide_panel();
                LRESULT(0)
            }
            WM_EXITSIZEMOVE => {
                runtime.dragging = false;
                let mut rect = RECT::default();
                let _ = GetWindowRect(runtime.bar, &mut rect);
                runtime.dock = Dock::after_drag(rect, work_area(runtime.bar), runtime.dpi);
                runtime.expanded_rect = rect;
                runtime.transition_to(runtime.dock.is_docked());
                runtime.update_anchor();
                LRESULT(0)
            }
            WM_MOVE => {
                if hwnd == runtime.bar {
                    runtime.update_anchor();
                    runtime.position_panel();
                }
                DefWindowProcW(hwnd, message, wparam, lparam)
            }
            WM_DPICHANGED => {
                if hwnd == runtime.bar {
                    let transitioning = runtime.transition.is_some();
                    runtime.stop_transition();
                    runtime.dpi = (wparam.0 & 0xffff) as f32;
                    let rect = &*(lparam.0 as *const RECT);
                    if !runtime.collapsed && !transitioning {
                        runtime.expanded_rect = *rect;
                        let _ = SetWindowPos(
                            hwnd,
                            None,
                            rect.left,
                            rect.top,
                            rect.right - rect.left,
                            rect.bottom - rect.top,
                            SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                    runtime.layout();
                }
                LRESULT(0)
            }
            WM_DISPLAYCHANGE => {
                runtime.stop_transition();
                runtime.layout();
                LRESULT(0)
            }
            WM_SETTINGCHANGE => {
                runtime.stop_transition();
                runtime.layout();
                let _ = runtime.actions.send(DesktopAction::Wake);
                LRESULT(0)
            }
            WM_TIMECHANGE => {
                let _ = runtime.actions.send(DesktopAction::Wake);
                LRESULT(0)
            }
            WM_QUERYENDSESSION => {
                let _ = runtime.actions.send(DesktopAction::Quit);
                LRESULT(1)
            }
            WM_POWERBROADCAST => {
                if matches!(
                    wparam.0 as u32,
                    PBT_APMRESUMEAUTOMATIC
                        | PBT_APMRESUMECRITICAL
                        | PBT_APMRESUMESUSPEND
                        | PBT_APMRESUMESTANDBY
                ) {
                    let _ = runtime.actions.send(DesktopAction::Wake);
                }
                LRESULT(1)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        };
        drop(runtime_guard);
        owner.flush(hwnd);
        result
    }
}

unsafe extern "system" fn button_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    id: usize,
) -> LRESULT {
    unsafe {
        if message == WM_LBUTTONDOWN
            && let Ok(parent) = GetParent(hwnd)
        {
            // Complete the visual transition before a control starts capture
            // or Windows records the rectangle for its modal move loop.
            SendMessageW(parent, FINISH_REVEAL, None, None);
        }
        if matches!(
            message,
            WM_MOUSEMOVE | WM_MOUSELEAVE | WM_LBUTTONUP | WM_CAPTURECHANGED
        ) {
            if message == WM_MOUSEMOVE {
                track_mouse_leave(hwnd);
            }
            if let Ok(parent) = GetParent(hwnd) {
                let _ = PostMessageW(Some(parent), POINTER_CHANGED, WPARAM(0), LPARAM(0));
            }
        }
        if id == DRAG && message == WM_LBUTTONDOWN {
            let _ = SetFocus(Some(hwnd));
            let mut point = POINT::default();
            let _ = GetCursorPos(&mut point);
            // A click or small hand jitter is not a move gesture. DragDetect
            // uses the system threshold and consumes the matching release.
            let dragging = DragDetect(hwnd, point).as_bool();
            if let Ok(parent) = GetParent(hwnd) {
                // DragDetect consumes a short click's release; the toolbar
                // still needs a final pointer check after capture is released.
                let _ = PostMessageW(Some(parent), POINTER_CHANGED, WPARAM(0), LPARAM(0));
            }
            if !dragging {
                return LRESULT(0);
            }
            let _ = ReleaseCapture();
            if let Ok(parent) = GetParent(hwnd) {
                let _ = GetCursorPos(&mut point);
                let position = ((point.y as u32 & 0xffff) << 16) | (point.x as u32 & 0xffff);
                SendMessageW(
                    parent,
                    WM_NCLBUTTONDOWN,
                    Some(WPARAM(HTCAPTION as usize)),
                    Some(LPARAM(position as isize)),
                );
            }
            return LRESULT(0);
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}

unsafe fn track_mouse_leave(hwnd: HWND) {
    unsafe {
        let _ = TrackMouseEvent(&mut TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE,
            hwndTrack: hwnd,
            ..Default::default()
        });
    }
}

unsafe fn cursor_inside(hwnd: HWND) -> bool {
    unsafe {
        let mut cursor = POINT::default();
        let mut rect = RECT::default();
        GetCursorPos(&mut cursor).is_ok()
            && GetWindowRect(hwnd, &mut rect).is_ok()
            && cursor.x >= rect.left
            && cursor.x < rect.right
            && cursor.y >= rect.top
            && cursor.y < rect.bottom
    }
}

fn client_animations_enabled() -> bool {
    unsafe {
        let mut enabled = BOOL(1);
        let _ = SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some((&mut enabled) as *mut _ as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        enabled.as_bool()
    }
}

unsafe fn work_area(hwnd: HWND) -> RECT {
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(monitor, &mut info);
        info.rcWork
    }
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn number(value: u32) -> String {
    if value > 99 {
        "99+".into()
    } else {
        value.to_string()
    }
}

struct Theme {
    surface: D2D1_COLOR_F,
    text: D2D1_COLOR_F,
    border: D2D1_COLOR_F,
    accent: D2D1_COLOR_F,
    hover: D2D1_COLOR_F,
}
impl Theme {
    fn from_snapshot(snapshot: Option<&CoreSnapshot>) -> Self {
        let dark = snapshot.is_some_and(|s| {
            s.data.settings.theme == "dark"
                || (s.data.settings.theme == "system" && system_is_dark())
        });
        let accent = snapshot
            .map(|s| color(&s.data.settings.accent))
            .unwrap_or(color("#4772fa"));
        if dark {
            Self {
                surface: color("#292b30"),
                text: color("#e7e8ec"),
                border: color("#454850"),
                accent,
                hover: color("#363940"),
            }
        } else {
            Self {
                surface: color("#ffffff"),
                text: color("#333741"),
                border: color("#dfe1e7"),
                accent,
                hover: color("#f0f2f7"),
            }
        }
    }
}
fn system_is_dark() -> bool {
    unsafe {
        let mut light = 1u32;
        let mut bytes = std::mem::size_of::<u32>() as u32;
        let result = RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut light) as *mut _ as *mut c_void),
            Some(&mut bytes),
        );
        result == ERROR_SUCCESS && light == 0
    }
}
fn color(value: &str) -> D2D1_COLOR_F {
    let value = u32::from_str_radix(value.trim_start_matches('#'), 16).unwrap_or(0x4772fa);
    D2D1_COLOR_F {
        r: ((value >> 16) & 255) as f32 / 255.,
        g: ((value >> 8) & 255) as f32 / 255.,
        b: (value & 255) as f32 / 255.,
        a: 1.,
    }
}

struct Renderer {
    target: ID2D1DCRenderTarget,
    write: IDWriteFactory,
}
impl Renderer {
    unsafe fn edge_line(&self, hdc: HDC, rect: RECT) -> windows::core::Result<()> {
        unsafe {
            self.target.BindDC(hdc, &rect)?;
            self.target.BeginDraw();
            self.target.Clear(Some(&color("#ffffff")));
            self.target.EndDraw(None, None)
        }
    }

    unsafe fn new() -> windows::core::Result<Self> {
        unsafe {
            let factory: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let target = factory.CreateDCRenderTarget(&D2D1_RENDER_TARGET_PROPERTIES {
                r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_IGNORE,
                },
                dpiX: 96.,
                dpiY: 96.,
                usage: D2D1_RENDER_TARGET_USAGE_NONE,
                minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
            })?;
            let write: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
            Ok(Self { target, write })
        }
    }
    // Keep the Win32 paint context and owner-drawn control state together at this boundary.
    #[allow(clippy::too_many_arguments)]
    unsafe fn surface(
        &self,
        hdc: HDC,
        rect: RECT,
        scale: f32,
        theme: &Theme,
        label: Option<(&str, bool)>,
        panel: Option<(&str, &str)>,
        focus: bool,
        pressed: bool,
    ) -> windows::core::Result<()> {
        unsafe {
            self.target.BindDC(hdc, &rect)?;
            self.target.BeginDraw();
            self.target.Clear(Some(if pressed {
                &theme.hover
            } else {
                &theme.surface
            }));
            let width = (rect.right - rect.left) as f32;
            let height = (rect.bottom - rect.top) as f32;
            let border = self
                .target
                .CreateSolidColorBrush(if focus { &theme.accent } else { &theme.border }, None)?;
            if label.is_none() || focus {
                self.target.DrawRoundedRectangle(
                    &D2D1_ROUNDED_RECT {
                        rect: D2D_RECT_F {
                            left: 0.5,
                            top: 0.5,
                            right: width - 0.5,
                            bottom: height - 0.5,
                        },
                        radiusX: if focus { 4. } else { 8. } * scale,
                        radiusY: if focus { 4. } else { 8. } * scale,
                    },
                    &border,
                    1.,
                    None,
                );
            }
            if let Some((text, accent)) = label {
                self.text(
                    text,
                    D2D_RECT_F {
                        left: 3.,
                        top: 0.,
                        right: width - 3.,
                        bottom: height,
                    },
                    if accent { &theme.accent } else { &theme.text },
                    14. * scale,
                    true,
                )?;
            }
            if let Some((title, body)) = panel {
                self.text(
                    title,
                    D2D_RECT_F {
                        left: 14. * scale,
                        top: 8. * scale,
                        right: width - 46. * scale,
                        bottom: 32. * scale,
                    },
                    &theme.text,
                    13. * scale,
                    false,
                )?;
                self.text(
                    body,
                    D2D_RECT_F {
                        left: 14. * scale,
                        top: 42. * scale,
                        right: width - 14. * scale,
                        bottom: 104. * scale,
                    },
                    &theme.text,
                    14. * scale,
                    false,
                )?;
            }
            self.target.EndDraw(None, None)
        }
    }
    unsafe fn text(
        &self,
        text: &str,
        rect: D2D_RECT_F,
        color: &D2D1_COLOR_F,
        size: f32,
        center: bool,
    ) -> windows::core::Result<()> {
        unsafe {
            let format = self.write.CreateTextFormat(
                w!("Microsoft YaHei UI"),
                None,
                DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                w!("zh-cn"),
            )?;
            format.SetTextAlignment(if center {
                DWRITE_TEXT_ALIGNMENT_CENTER
            } else {
                DWRITE_TEXT_ALIGNMENT_LEADING
            })?;
            format.SetParagraphAlignment(if center {
                DWRITE_PARAGRAPH_ALIGNMENT_CENTER
            } else {
                DWRITE_PARAGRAPH_ALIGNMENT_NEAR
            })?;
            let brush = self.target.CreateSolidColorBrush(color, None)?;
            let text = text.encode_utf16().collect::<Vec<_>>();
            self.target.DrawText(
                &text,
                &format,
                &rect,
                &brush,
                D2D1_DRAW_TEXT_OPTIONS_CLIP,
                DWRITE_MEASURING_MODE_NATURAL,
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_actions_require_a_click_from_the_matching_control() {
        let button = Button {
            hwnd: HWND(0x1000 as *mut c_void),
            id: ADD,
            label: String::new(),
            width: 40.,
            left: 0.,
            shown: true,
            tooltip: vec![],
        };
        let control = LPARAM(button.hwnd.0 as isize);
        assert_eq!(
            clicked_button(WPARAM(ADD), control, [&button].into_iter()),
            Some(ADD)
        );
        for notification in [
            BN_SETFOCUS,
            BN_KILLFOCUS,
            BN_PUSHED,
            BN_UNPUSHED,
            BN_DOUBLECLICKED,
        ] {
            assert_eq!(
                clicked_button(
                    WPARAM(ADD | ((notification as usize) << 16)),
                    control,
                    [&button].into_iter()
                ),
                None
            );
        }
        assert_eq!(
            clicked_button(WPARAM(ADD), LPARAM(0), [&button].into_iter()),
            None
        );
        assert_eq!(
            clicked_button(WPARAM(ADD), LPARAM(0x2000), [&button].into_iter()),
            None
        );
        assert_eq!(
            clicked_button(WPARAM(DRAG), control, [&button].into_iter()),
            None
        );
    }
    #[test]
    fn effective_snooze_time_controls_due_state() {
        let event = ReminderEvent {
            id: "r".into(),
            task_id: "t".into(),
            version: 1,
            due_at: (Utc::now() - chrono::Duration::minutes(1)).to_rfc3339(),
            notified: false,
            handled: false,
            invalidated: false,
            snoozed_until: Some((Utc::now() + chrono::Duration::minutes(10)).to_rfc3339()),
        };
        assert!(!due(&event));
    }

    #[test]
    fn snoozing_the_same_event_allows_a_new_presentation() {
        let mut event = ReminderEvent {
            id: "same-reminder".into(),
            task_id: "task".into(),
            version: 1,
            due_at: "2026-10-30T09:00:00Z".into(),
            notified: false,
            handled: false,
            invalidated: false,
            snoozed_until: None,
        };
        let mut presented = HashSet::new();
        assert!(presented.insert(presentation_key(&event)));
        assert!(!presented.insert(presentation_key(&event)));

        event.snoozed_until = Some("2026-10-30T09:10:00Z".into());
        assert!(presented.insert(presentation_key(&event)));
        assert!(!presented.insert(presentation_key(&event)));
    }
}

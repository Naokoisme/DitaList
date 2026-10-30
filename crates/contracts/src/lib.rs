//! Shared wire types. Runtime validation and business policy belong to the core.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

macro_rules! wire {
    ($($item:item)*) => { $(#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)] #[serde(rename_all = "camelCase")] $item)* };
}

wire! {
pub struct Subtask { pub id: String, pub title: String, pub completed: bool }
pub struct Task {
    pub id: String, pub title: String, pub content: String, pub list_id: String,
    pub start_date: Option<String>, pub due_date: Option<String>, pub time: Option<String>, pub end_time: Option<String>,
    pub priority: u8, pub repeat: String, pub reminder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[ts(optional)] pub recurrence_anchor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[ts(optional)] pub recurrence_id: Option<String>,
    pub tags: Vec<String>, pub subtasks: Vec<Subtask>, pub completed_at: Option<String>, pub deleted_at: Option<String>,
    pub created_at: String, pub updated_at: String, pub sort_order: f64, pub pinned: bool,
    #[serde(default = "user_source")] pub created_by: String,
    #[serde(default = "approved")] pub agent_status: String,
}
pub struct TaskList { pub id: String, pub name: String, pub color: String, pub folder_id: Option<String>, pub archived: bool, pub sort_order: f64 }
pub struct Folder { pub id: String, pub name: String, pub sort_order: f64 }
pub struct Habit { pub id: String, pub name: String, pub icon: String, pub color: String, pub goal: u32, pub days: Vec<u8>, pub records: BTreeMap<String, u32>, pub created_at: String }
pub struct SavedFilter { pub id: String, pub name: String, pub query: String, pub color: String }
pub struct FocusSession { pub id: String, pub task_id: Option<String>, pub title: String, pub started_at: String, pub ended_at: String, pub duration_seconds: u32, pub completed: bool }
#[derive(Default)]
pub struct NavigationPreferences { #[serde(default)] pub orders: BTreeMap<String, Vec<String>>, #[serde(default)] pub hidden: Vec<String> }
pub struct Settings {
    pub theme: String, pub accent: String, pub week_start: u8, pub show_completed: bool, pub calendar_mode: String,
    pub sidebar_collapsed: bool, pub default_view: String, pub pomodoro_minutes: u32, pub break_minutes: u32,
    pub sound: bool, pub notifications: bool, pub floating_shortcut: String,
    pub floating_default_list_id: String, pub floating_default_date: String,
    #[serde(default)] pub custom_tags: Vec<String>,
    #[serde(default)] pub navigation: NavigationPreferences,
}
pub struct AppData { pub schema_version: u8, pub tasks: Vec<Task>, pub lists: Vec<TaskList>, pub folders: Vec<Folder>, pub habits: Vec<Habit>, pub filters: Vec<SavedFilter>, pub focus_sessions: Vec<FocusSession>, pub settings: Settings }
pub struct Preferences { pub floating_visible: bool, pub mcp_enabled: bool, pub quiet: bool, pub confirm_purge: bool }
pub struct Approval { pub id: String, pub task_id: String, pub patch: Value, #[ts(type = "number")] pub base_version: u64, pub status: String, pub created_at: String }
pub struct ReminderEvent { pub id: String, pub task_id: String, #[ts(type = "number")] pub version: u64, pub due_at: String, pub notified: bool, pub handled: bool, pub invalidated: bool, pub snoozed_until: Option<String> }
pub struct FocusState { pub mode: String, pub running: bool, pub task_id: Option<String>, pub title: String, pub started_at: Option<String>, pub deadline: Option<String>, pub remaining_seconds: u32, pub elapsed_seconds: u32, pub target_seconds: u32 }
pub struct CoreSnapshot {
    pub data: AppData, #[ts(type = "number")] pub revision: u64,
    #[ts(type = "Record<string, number>")] pub entity_versions: BTreeMap<String,u64>,
    pub approvals: Vec<Approval>, pub reminders: Vec<ReminderEvent>, pub focus: FocusState,
    pub preferences: Preferences, pub today_count: u32, pub pending_count: u32, pub reminder_count: u32,
}
pub struct CoreCommand { pub request_id: String, pub operation: Operation }
pub struct CommandReceipt { pub request_id: String, pub status: String, #[ts(type = "number")] pub revision: u64, pub result: Value, pub created_at: String }
pub struct CoreError { pub code: String, pub message: String }
pub struct QuickDraft { pub text: String, pub request_id: Option<String> }
pub struct McpInfo { pub state: String, pub command: String, pub args: Vec<String>, pub contact_path: String, pub address: Option<String> }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Operation {
    TaskCreate {
        input: Value,
    },
    QuickAdd {
        text: String,
        #[serde(default)]
        list_id: Option<String>,
        #[serde(default)]
        date: Option<String>,
        #[serde(default)]
        overrides: Option<Value>,
    },
    TaskUpdate {
        id: String,
        patch: Value,
        #[serde(default)]
        #[ts(type = "number | null")]
        expected_version: Option<u64>,
    },
    TaskComplete {
        id: String,
        completed: bool,
    },
    TaskTrash {
        id: String,
    },
    TaskRestore {
        id: String,
    },
    TaskPurge {
        id: String,
        confirmed: bool,
    },
    TrashEmpty {
        confirmed: bool,
    },
    TrashRestoreAll,
    TaskCopy {
        id: String,
    },
    TaskReorder {
        ids: Vec<String>,
    },
    TaskMove {
        id: String,
        view: String,
    },
    ListMove {
        id: String,
        target: ListMoveTarget,
    },
    CollectionUpsert {
        collection: String,
        value: Value,
    },
    CollectionDelete {
        collection: String,
        id: String,
    },
    SettingsUpdate {
        patch: Value,
    },
    NavigationUpdate {
        preferences: NavigationPreferences,
        renames: BTreeMap<String, String>,
    },
    PreferencesUpdate {
        patch: Value,
    },
    TagRename {
        from: String,
        to: String,
    },
    TagDelete {
        name: String,
    },
    HabitRecord {
        id: String,
        date: String,
        value: u32,
    },
    Focus {
        action: String,
        #[serde(default)]
        task_id: Option<String>,
    },
    Reminder {
        id: String,
        action: String,
    },
    AgentApprove {
        id: String,
    },
    AgentReject {
        id: String,
    },
    Import {
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ListMoveTarget {
    Group { folder_id: Option<String> },
    List { list_id: String, position: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    Local,
    Agent,
}

#[derive(Debug, Clone)]
pub enum CoreEffect {
    ReminderDue(Vec<String>),
    FocusCompleted(String),
    Changed,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CoreError {}
impl CoreError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            floating_visible: true,
            mcp_enabled: false,
            quiet: false,
            confirm_purge: true,
        }
    }
}
impl Default for FocusState {
    fn default() -> Self {
        Self {
            mode: "focus".into(),
            running: false,
            task_id: None,
            title: String::new(),
            started_at: None,
            deadline: None,
            remaining_seconds: 1500,
            elapsed_seconds: 0,
            target_seconds: 1500,
        }
    }
}
fn user_source() -> String {
    "user".into()
}
fn approved() -> String {
    "approved".into()
}

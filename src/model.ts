import type * as Wire from "./generated/contracts";

// UI vocabulary narrows the validated Rust wire values; persistence and validation policy remain in the core.
export type Priority = 0 | 1 | 2 | 3;
export type RepeatRule = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
export type Reminder = "none" | "at-time" | "5m" | "15m" | "30m" | "1h" | "1d";
export type CalendarMode = "month" | "week" | "day" | "agenda";
export type ViewId = "today" | "next7" | "inbox" | "all" | "agent-review" | "calendar" | "matrix" | "focus" | "habits" | "completed" | "trash" | `list:${string}` | `tag:${string}` | `filter:${string}`;
export type Subtask = Wire.Subtask;
export type Task = Omit<Wire.Task, "priority" | "repeat" | "reminder" | "createdBy" | "agentStatus"> & {
  priority: Priority;
  repeat: RepeatRule;
  reminder: Reminder;
  createdBy: "user" | "agent";
  agentStatus: "pending" | "approved";
};
export type TaskList = Wire.TaskList;
export type Folder = Wire.Folder;
export type Habit = Wire.Habit;
export type SavedFilter = Wire.SavedFilter;
export type FocusSession = Wire.FocusSession;
export type NavigationPreferences = Wire.NavigationPreferences;
export type Settings = Omit<Wire.Settings, "theme" | "weekStart" | "calendarMode" | "defaultView" | "floatingDefaultDate" | "customTags"> & {
  theme: "light" | "dark" | "system";
  weekStart: 0 | 1;
  calendarMode: CalendarMode;
  defaultView: ViewId;
  floatingDefaultDate: "none" | "today" | "tomorrow";
  customTags?: string[];
};
export type AppData = Omit<Wire.AppData, "schemaVersion" | "tasks" | "settings"> & {schemaVersion: 1; tasks: Task[]; settings: Settings};
export interface StorageInfo { kind: "desktop"; path: string; backupPath?: string }

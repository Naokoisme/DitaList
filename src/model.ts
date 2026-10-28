export type Priority = 0 | 1 | 2 | 3;
export type RepeatRule =
  "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
export type Reminder = "none" | "at-time" | "5m" | "15m" | "30m" | "1h" | "1d";
export type CalendarMode = "month" | "week" | "day" | "agenda";
export type ViewId =
  | "today"
  | "next7"
  | "inbox"
  | "all"
  | "calendar"
  | "matrix"
  | "focus"
  | "habits"
  | "completed"
  | "trash"
  | `list:${string}`
  | `tag:${string}`
  | `filter:${string}`;

export interface Subtask {
  id: string;
  title: string;
  completed: boolean;
}
export interface Task {
  id: string;
  title: string;
  content: string;
  listId: string;
  startDate: string | null;
  dueDate: string | null;
  time: string | null;
  endTime: string | null;
  priority: Priority;
  repeat: RepeatRule;
  recurrenceAnchor?: string;
  recurrenceId?: string;
  reminder: Reminder;
  tags: string[];
  subtasks: Subtask[];
  completedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sortOrder: number;
  pinned: boolean;
}
export interface TaskList {
  id: string;
  name: string;
  color: string;
  folderId: string | null;
  archived: boolean;
  sortOrder: number;
}
export interface Folder {
  id: string;
  name: string;
  sortOrder: number;
}
export interface Habit {
  id: string;
  name: string;
  icon: string;
  color: string;
  goal: number;
  days: number[];
  records: Record<string, number>;
  createdAt: string;
}
export interface SavedFilter {
  id: string;
  name: string;
  query: string;
  color: string;
}
export interface FocusSession {
  id: string;
  taskId: string | null;
  title: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  completed: boolean;
}
export interface Settings {
  theme: "light" | "dark" | "system";
  accent: string;
  weekStart: 0 | 1;
  showCompleted: boolean;
  calendarMode: CalendarMode;
  sidebarCollapsed: boolean;
  defaultView: ViewId;
  pomodoroMinutes: number;
  breakMinutes: number;
  sound: boolean;
  notifications: boolean;
}
export interface AppData {
  schemaVersion: 1;
  tasks: Task[];
  lists: TaskList[];
  folders: Folder[];
  habits: Habit[];
  filters: SavedFilter[];
  focusSessions: FocusSession[];
  settings: Settings;
}
export interface StorageInfo {
  kind: "desktop" | "browser" | "android";
  path: string;
  backupPath?: string;
}
export interface DesktopBridge {
  load(): Promise<{ data: AppData | null; info: StorageInfo }>;
  save(data: AppData): Promise<void>;
  exportBackup(data: AppData): Promise<boolean>;
  importBackup(): Promise<string | null>;
  revealData(): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  windowAction(action: "minimize" | "maximize" | "close"): void;
}
declare global {
  interface Window {
    didaLocal?: DesktopBridge;
  }
}

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
  createdBy: "user" | "agent";
  agentStatus: "pending" | "approved";
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
export interface NavigationPreferences {
  orders: Record<string, string[]>;
  hidden: string[];
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
  floatingShortcut: string;
  floatingDefaultListId: string;
  floatingDefaultDate: "none" | "today" | "tomorrow";
  customTags?: string[];
  navigation?: NavigationPreferences;
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
export interface AgentDocumentInfo {
  path: string;
  directory: string;
  mcpServerPath: string;
  pipePath: string;
  httpUrl?: string;
  content: string;
}
export interface FloatingState {
  theme: "light" | "dark" | "system";
  accent: string;
  hasReminder: boolean;
  todayCount: number;
  expanded: boolean;
  anchorX: "left" | "right";
  anchorY: "top" | "bottom";
}
export interface DesktopBridge {
  load(): Promise<{ data: AppData | null; info: StorageInfo }>;
  save(data: AppData): Promise<void>;
  exportBackup(data: AppData): Promise<boolean>;
  importBackup(): Promise<string | null>;
  revealData(): Promise<void>;
  generateAgentDocument(): Promise<AgentDocumentInfo>;
  copyAgentDocument(): Promise<{ path: string; copied: boolean }>;
  openAgentDocumentDirectory(): Promise<{ path: string }>;
  notify(title: string, body: string): Promise<void>;
  setFloatingShortcut(shortcut: string): Promise<boolean>;
  getFloatingVisible(): Promise<boolean>;
  setFloatingVisible(visible: boolean): Promise<boolean>;
  onFloatingVisibilityChanged(listener: (visible: boolean) => void): () => void;
  resizeFloating(width: number, height: number): void;
  moveFloating(dx: number, dy: number): void;
  getFloatingState(): Promise<FloatingState>;
  onFloatingStateChanged(listener: (state: FloatingState) => void): () => void;
  updateFloatingStatus(status: Omit<FloatingState, "expanded" | "anchorX" | "anchorY">): void;
  setFloatingExpanded(expanded: boolean): void;
  getDesktopShortcut(): Promise<boolean>;
  createDesktopShortcut(): Promise<{ path: string }>;
  removeDesktopShortcut(): Promise<void>;
  windowAction(action: "minimize" | "maximize" | "close"): void;
  openFloating(): void;
  closeFloating(): void;
  openMain(): void;
  submitQuickAdd(text: string): Promise<void>;
  completeQuickAdd(requestId: string, error?: string): void;
  onQuickAdd(listener: (text: string, requestId: string) => void): () => void;
  onExternalData(listener: (payload: {
    data: AppData;
    reason: string;
    taskIds?: string[];
  }) => void): () => void;
}
declare global {
  interface Window {
    didaLocal?: DesktopBridge;
  }
}

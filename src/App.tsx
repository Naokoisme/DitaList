import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDownAZ,
  Bell,
  Bot,
  CalendarDays,
  CalendarRange,
  CalendarCheck2,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  Flag,
  Folder,
  FolderPlus,
  Hash,
  Inbox,
  LayoutGrid,
  List,
  ListFilter,
  Menu,
  Minus,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareCheck,
  Sun,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  AppData,
  Priority,
  Reminder,
  RepeatRule,
  StorageInfo,
  Task,
  TaskList,
  ViewId,
} from "./model";
import {
  addDays,
  isInDateView,
  localDate,
  parseQuickInput,
} from "./core/domain";
import { desktopAction, desktopStatus, errorMessage, executeOperation, exportBackup, getSnapshot, importBackup, watchCore, watchNavigation, type Snapshot } from "./core/client";
import { installMainMotion } from "./desktop/mainMotion";
import { listen } from "@tauri-apps/api/event";
import type { CommandReceipt, Operation } from "./generated/contracts";
import AgentReviewPanel from "./components/AgentReviewPanel";
import McpSettings from "./components/McpSettings";
import AppNavigation from "./components/AppNavigation";
import TaskFilterControl from "./components/TaskFilterControl";
import AnchoredPopover from "./components/AnchoredPopover";
import CustomDateInput from "./components/CustomDateInput";
import { createTaskViewFilter, describeTaskViewFilter, hasTaskViewFilter, matchesTaskViewFilter, type TaskViewFilter } from "./core/task-filter";
import type { ListMoveTarget } from "./core/list-organization";
import CalendarView from "./components/CalendarView";
import TaskDateHint from "./components/TaskDateHint";
import { FocusView, HabitsView, MatrixView } from "./components/Tools";
import "./calendar.css";

const saveStatusLabels = {
  saved: "已保存到本机",
  saving: "正在保存到本机",
  error: "本机保存失败",
};
type SaveStatus = keyof typeof saveStatusLabels;

const labels: Record<string, string> = {
  today: "今天",
  next7: "最近7天",
  inbox: "收集箱",
  all: "所有任务",
  "agent-review": "Agent 待确认",
  calendar: "日历",
  completed: "已完成",
  trash: "回收站",
  matrix: "四象限",
  focus: "专注",
  habits: "习惯",
};
const priorities: { value: Priority; label: string; color: string }[] = [
  { value: 1, label: "高优先级", color: "#e13e39" },
  { value: 2, label: "中优先级", color: "#faa80c" },
  { value: 3, label: "低优先级", color: "#4772fa" },
  { value: 0, label: "无优先级", color: "#a0a0a0" },
];
const repeats: { value: RepeatRule; label: string }[] = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "每个工作日" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "yearly", label: "每年" },
];
const reminders: { value: Reminder; label: string }[] = [
  { value: "none", label: "不提醒" },
  { value: "at-time", label: "准时提醒" },
  { value: "5m", label: "提前5分钟" },
  { value: "15m", label: "提前15分钟" },
  { value: "30m", label: "提前30分钟" },
  { value: "1h", label: "提前1小时" },
  { value: "1d", label: "提前1天" },
];
const colors = [
  "#4772fa",
  "#e13e39",
  "#faa80c",
  "#28a66b",
  "#ad6de4",
  "#e16eac",
  "#28a9b2",
  "#81909d",
];
const stamp = () => new Date().toISOString();
const TargetIcon = Clock3;

function shortcutLabel(shortcut: string) {
  return shortcut
    .replaceAll("CommandOrControl", "Ctrl")
    .replaceAll("Command", "⌘")
    .replaceAll("Control", "Ctrl")
    .replaceAll("Alt", "Alt")
    .replaceAll("Shift", "Shift")
    .replaceAll("Plus", "+")
    .replaceAll("Space", "空格");
}

function shortcutFromKeyEvent(event: React.KeyboardEvent) {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (!modifiers.length) return null;
  const special: Record<string, string> = {
    " ": "Space",
    Escape: "Esc",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  const key = special[event.key] ||
    (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  if (!key || key === "Unidentified") return null;
  return [...modifiers, key].join("+");
}

function floatingDefaultDueDate(
  value: AppData["settings"]["floatingDefaultDate"],
) {
  if (value === "today") return localDate();
  if (value === "tomorrow") return addDays(localDate(), 1);
  return null;
}

function IconButton({
  label,
  children,
  onClick,
  className = "",
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function dateText(date: string | null) {
  if (!date) return "";
  const today = localDate();
  if (date === today) return "今天";
  if (date === addDays(today, 1)) return "明天";
  if (date === addDays(today, -1)) return "昨天";
  return new Date(date + "T12:00:00").toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}
function matchesQuery(task: Task, query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return terms.every((term) => {
    if (term === "#" || !term) return true;
    if (term.startsWith("#"))
      return task.tags.some((t) => t.toLowerCase().includes(term.slice(1)));
    if (["!1", "!2", "!3", "!0"].includes(term))
      return task.priority === Number(term.slice(1));
    if (term === "今天") return task.dueDate === localDate();
    if (term === "逾期")
      return !!task.dueDate && task.dueDate < localDate() && !task.completedAt;
    return `${task.title} ${task.content} ${task.tags.join(" ")}`
      .toLowerCase()
      .includes(term);
  });
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const data = snapshot?.data || null;
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<ViewId>("today");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState(localDate);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [calendarKey, setCalendarKey] = useState(0);
  const [calendarBacklogOpen, setCalendarBacklogOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [settingsSection, setSettingsSection] = useState<
    "general" | "data" | null
  >(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [createDialog, setCreateDialog] = useState<{
    date: string | null;
    endDate?: string;
    time?: string;
  } | null>(null);
  const [dateTask, setDateTask] = useState<Task | null>(null);
  const [listDialog, setListDialog] = useState<
    "list" | "folder" | TaskList | null
  >(null);
  const [tagDialog, setTagDialog] = useState<{
    mode: "create" | "edit";
    name: string;
  } | null>(null);
  const [filterDialog, setFilterDialog] = useState(false);
  const [context, setContext] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [sort, setSort] = useState<"manual" | "priority" | "date" | "title">(
    "manual",
  );
  const [navigationEditing, setNavigationEditing] = useState(false);
  const [windowControlHover, setWindowControlHover] = useState<"minimize" | "maximize" | "close" | null>(null);
  const [taskFilters, setTaskFilters] = useState<Partial<Record<ViewId, TaskViewFilter>>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [dragOverNav, setDragOverNav] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [draggingListId, setDraggingListId] = useState<string | null>(null);
  const [listDropTarget, setListDropTarget] = useState<ListMoveTarget | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchTargetId = useRef<string | null>(null);
  const latestSnapshot = useRef<Snapshot | null>(null);
  latestSnapshot.current = snapshot;
  const pendingWrites = useRef(new Set<Promise<CommandReceipt | null>>());
  const writeTail = useRef<Promise<unknown>>(Promise.resolve());
  const detailDraft = useRef(false);
  const reportDetailDraft = useCallback((dirty: boolean) => { detailDraft.current = dirty; }, []);
  const habitDraft = useRef(false);
  const reportHabitDraft = useCallback((dirty: boolean) => { habitDraft.current = dirty; }, []);
  const listDraftId = useRef("");
  const filterDraftId = useRef("");
  useEffect(() => { listDraftId.current = typeof listDialog === "string" ? crypto.randomUUID() : ""; }, [typeof listDialog === "string" ? listDialog : null]);
  useEffect(() => { filterDraftId.current = filterDialog ? crypto.randomUUID() : ""; }, [filterDialog]);
  const unsubmittedForm = useRef(false);
  unsubmittedForm.current = Boolean(createDialog || dateTask || listDialog || tagDialog || filterDialog || navigationEditing);
  const creatingTask = useRef(false);
  const failedWrites = useRef(new Map<string, Operation>());
  const [failedWriteCount, setFailedWriteCount] = useState(0);
  const [retryingWrites, setRetryingWrites] = useState(false);
  const [detailReset, setDetailReset] = useState(0);
  const [exitPending, setExitPending] = useState(false);
  const exitRequested = useRef(false);
  const exitSequence = useRef(0);
  const [boot, setBoot] = useState(0);
  const acceptSnapshot = useCallback((next: Snapshot) => {
    if (latestSnapshot.current && next.revision < latestSnapshot.current.revision) return;
    latestSnapshot.current = next;
    setSnapshot((previous) => !previous || next.revision >= previous.revision ? next : previous);
    setSelectedId((id) => id && next.data.tasks.some((task) => task.id === id) ? id : null);
    setContext((context) => context && next.data.tasks.some((task) => task.id === context.id) ? context : null);
  }, []);
  const perform = useCallback((operation: Operation): Promise<CommandReceipt | null> => {
    // A later successful edit of the same fields supersedes their earlier failed draft.
    const key = operation.type === "taskUpdate"
      ? `${operation.type}:${operation.id}:${Object.keys(operation.patch || {}).sort().join(",")}`
      : operation.type === "settingsUpdate" || operation.type === "preferencesUpdate"
        ? `${operation.type}:${Object.keys(operation.patch || {}).sort().join(",")}`
        : operation.type === "navigationUpdate" && Object.keys(operation.renames).length === 0
          ? "navigationUpdate"
        : operation.type === "collectionUpsert" && operation.value && typeof operation.value === "object" && !Array.isArray(operation.value)
          ? `${operation.type}:${operation.collection}:${operation.value.id}` : JSON.stringify(operation);
    setSaveStatus("saving");
    // Track queued work as well as IPC. Close waits through readback and error handling.
    const pending = writeTail.current.then(async (): Promise<CommandReceipt | null> => {
    try {
      const receipt = await executeOperation(operation);
      failedWrites.current.delete(key);
      setFailedWriteCount(failedWrites.current.size);
      setSaveStatus(failedWrites.current.size ? "error" : "saved");
      // The receipt already proves the write. A refresh failure must not turn it into an unsaved operation.
      try { acceptSnapshot(await getSnapshot()); }
      catch (error) { setToast(`已保存，但刷新界面失败：${errorMessage(error)}`); }
      return receipt;
    } catch (error) {
      failedWrites.current.set(key, operation);
      setFailedWriteCount(failedWrites.current.size);
      setSaveStatus("error");
      setToast(errorMessage(error));
      return null;
    }
    });
    pendingWrites.current.add(pending);
    writeTail.current = pending;
    void pending.finally(() => pendingWrites.current.delete(pending));
    return pending;
  }, [acceptSnapshot]);
  useEffect(() => {
    let canceled = false;
    const cleanups: (() => void)[] = [];
    const keep = (cleanup: () => void) => canceled ? cleanup() : cleanups.push(cleanup);
    const report = (error: unknown) => { if (!canceled) setLoadError(errorMessage(error)); };
    void (async () => {
      keep(await installMainMotion(report, () => !canceled));
      keep(await watchNavigation((intent) => {
        setWindowControlHover(null);
        if (intent.view) { setView(intent.view as ViewId); setSelectedId(null); }
        if (intent.taskId) setSelectedId(intent.taskId);
      }));
      keep(await listen<{window: string}>("desktop://prepare-close", ({payload}) => {
        if (payload.window === "main") void closeWindow();
      }));
      keep(await listen<{window: string}>("desktop://prepare-exit", ({payload}) => {
        if (payload.window === "main") void prepareExit();
      }));
      keep(await listen("desktop://exit-cancelled", () => {
        exitSequence.current += 1; exitRequested.current = false; setExitPending(false);
      }));
      keep(await watchCore((next) => {
        if (canceled) return;
        if (!latestSnapshot.current) setView(next.data.settings.defaultView);
        acceptSnapshot(next);
        setLoadError("");
      }, report));
      const status = await desktopStatus();
      if (!canceled) {
        setInfo({kind: "desktop", path: status.dataPath, backupPath: status.backupPath});
        await desktopAction("ready", {window: "main"});
      }
    })().catch(report);
    return () => { canceled = true; cleanups.forEach((cleanup) => cleanup()); };
  }, [boot, acceptSnapshot]);
  useEffect(() => {
    // A hidden WebView can retain :hover until its next mouse move. Window
    // controls use fresh pointer input, never that retained browser hit target.
    const clearHover = () => setWindowControlHover(null);
    const visibilityChanged = () => { if (document.hidden) clearHover(); };
    window.addEventListener("blur", clearHover);
    window.addEventListener("focus", clearHover);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("blur", clearHover);
      window.removeEventListener("focus", clearHover);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);
  useEffect(() => {
    document.body.inert = exitPending;
    return () => { document.body.inert = false; };
  }, [exitPending]);

  useEffect(() => {
    if (import.meta.env.VITE_DITALIST_DRAG_TRACE !== "1") return;
    let sawDragOver = false;
    const events = ["dragstart", "dragover", "drop", "dragend"] as const;
    const trace = (event: DragEvent) => {
      if (event.type === "dragstart") sawDragOver = false;
      if (event.type === "dragover") {
        if (sawDragOver) return;
        sawDragOver = true;
      }
      const target = event.target instanceof Element ? event.target : null;
      // Diagnostic builds observe native events only; never read transfer contents or change the gesture.
      void desktopAction(`trace:${event.type}`, {
        window: "main", type: event.type, clientX: event.clientX, clientY: event.clientY,
        screenX: event.screenX, screenY: event.screenY, types: [...(event.dataTransfer?.types || [])],
        calendarTask: Boolean(target?.closest(".cal-event")),
        date: target?.closest<HTMLElement>(".cal-day[data-date]")?.dataset.date || null,
      }).catch(() => {});
    };
    events.forEach((event) => document.addEventListener(event, trace, true));
    return () => events.forEach((event) => document.removeEventListener(event, trace, true));
  }, []);

  useEffect(() => {
    const clearDrag = () => {
      setDraggingTaskId(null);
      setDragOverNav(null);
      setDraggingListId(null);
      setListDropTarget(null);
    };
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("drop", clearDrag);
    return () => {
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("drop", clearDrag);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!data) return;
    const dark =
      data.settings.theme === "dark" ||
      (data.settings.theme === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.setProperty(
      "--accent",
      data.settings.accent,
    );
    const m = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      if (data.settings.theme === "system")
        document.documentElement.dataset.theme = m.matches ? "dark" : "light";
    };
    m.addEventListener("change", sync);
    return () => m.removeEventListener("change", sync);
  }, [data?.settings.theme, data?.settings.accent]);
  const patchTask = useCallback((id: string, patch: Partial<Task>) => {
    return perform({type: "taskUpdate", id, patch, expectedVersion: null});
  }, [perform]);
  const toggle = useCallback((id: string) => {
    const task = latestSnapshot.current?.data.tasks.find((item) => item.id === id);
    if (task && !task.deletedAt) void perform({type: "taskComplete", id, completed: !task.completedAt});
  }, [perform]);
  const go = useCallback((next: ViewId) => {
    setView(next);
    setSelectedId(null);
    setCalendarBacklogOpen(false);
    setSidebarOpen(false);
    setContext(null);
  }, []);
  const openNewTask = useCallback(() => {
    setCreateDialog({date: view === "today" || view === "next7" ? localDate() : view === "calendar" ? anchor : null});
  }, [view, anchor]);
  useEffect(() => {
    const targetId = searchTargetId.current;
    if (searchOpen || !targetId || selectedId !== targetId) return;
    const row = document.querySelector<HTMLElement>(
      `.task-row[data-task-id="${CSS.escape(targetId)}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
    searchTargetId.current = null;
  }, [searchOpen, selectedId, view]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        setCreateDialog(null);
        setDateTask(null);
        setSearchOpen(false);
        setSettingsSection(null);
        setListDialog(null);
        setTagDialog(null);
        setContext(null);
        setSelectedId(null);
        setCalendarBacklogOpen(false);
        setHelpOpen(false);
        setSidebarOpen(false);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "k") {
          e.preventDefault();
          setSearchOpen(true);
        }
        if (e.key.toLowerCase() === "n") {
          e.preventDefault();
          openNewTask();
        }
        if (["1", "2", "3", "4"].includes(e.key)) {
          e.preventDefault();
          go(
            (["today", "next7", "inbox", "calendar"] as ViewId[])[
              Number(e.key) - 1
            ],
          );
        }
      }
      if (
        e.key === "?" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      )
        setHelpOpen(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go, openNewTask]);
  const selected = data?.tasks.find((t) => t.id === selectedId) || null;
  const active =
    data?.tasks.filter((t) => !t.deletedAt && !t.completedAt && t.agentStatus !== "pending") || [];
  const tags = useMemo(
    () =>
      Array.from(
        new Set([
          ...(data?.settings.customTags || []),
          ...(data?.tasks.filter((t) => !t.deletedAt).flatMap((t) => t.tags) ||
            []),
        ]),
      ).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [data?.tasks, data?.settings.customTags],
  );
  const title = view.startsWith("list:")
    ? data?.lists.find((l) => l.id === view.slice(5))?.name || "清单"
    : view.startsWith("tag:")
      ? view.slice(4)
      : view.startsWith("filter:")
        ? data?.filters.find((f) => f.id === view.slice(7))?.name || "过滤器"
        : labels[view] || "任务";
  const currentListId = view.startsWith("list:") ? view.slice(5) : "inbox";
  const taskFilter = useMemo(() => {
    const value = taskFilters[view] || createTaskViewFilter(Boolean(data?.settings.showCompleted));
    return view === "completed" ? {...value, status: "completed" as const} : value;
  }, [taskFilters, view, data?.settings.showCompleted]);
  const filterActive = hasTaskViewFilter(view === "completed" ? {...taskFilter, status: createTaskViewFilter(Boolean(data?.settings.showCompleted)).status} : taskFilter, Boolean(data?.settings.showCompleted));
  const clearTaskFilter = () => setTaskFilters((current) => { const next = {...current}; delete next[view]; return next; });
  const visibleTasks = useMemo(() => {
    if (!data) return [];
    let tasks = data.tasks.filter((t) =>
      view === "trash" ? !!t.deletedAt : !t.deletedAt && t.agentStatus !== "pending",
    );
    const today = localDate();
    if (view === "completed") tasks = tasks.filter((t) => !!t.completedAt);
    else if (view === "today" || view === "next7")
      tasks = tasks.filter((t) => isInDateView(t.dueDate, view, today));
    else if (view === "inbox")
      tasks = tasks.filter((t) => t.listId === "inbox");
    else if (view.startsWith("list:"))
      tasks = tasks.filter((t) => t.listId === view.slice(5));
    else if (view.startsWith("tag:"))
      tasks = tasks.filter((t) => t.tags.includes(view.slice(4)));
    else if (view.startsWith("filter:"))
      tasks = tasks.filter((t) =>
        matchesQuery(
          t,
          data.filters.find((f) => f.id === view.slice(7))?.query || "",
        ),
      );
    if (view !== "trash") tasks = tasks.filter((task) => matchesTaskViewFilter(task, taskFilter));
    return tasks.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (sort === "title"
          ? a.title.localeCompare(b.title, "zh-CN")
          : sort === "priority"
            ? (a.priority || 4) - (b.priority || 4)
            : sort === "date"
              ? (a.dueDate || "9999").localeCompare(b.dueDate || "9999")
              : a.sortOrder - b.sortOrder) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  }, [data, view, sort, taskFilter]);
  const openTasks = visibleTasks.filter(
    (t) => !t.completedAt || view === "trash",
  );
  const doneTasks = visibleTasks.filter((t) => !!t.completedAt);
  const showOnlyCompleted = view !== "trash" && (view === "completed" || taskFilter.status === "completed" || taskFilter.dateField === "completed");
  const groups = useMemo(() => {
    const tasks = showOnlyCompleted ? doneTasks : openTasks;
    if (!tasks.length) return [];
    if (!["today", "next7", "all", "completed"].includes(view) && taskFilter.dateField !== "completed")
      return [{ label: "", tasks }];
    const result = new Map<string, Task[]>();
    for (const t of tasks) {
      const label =
        view === "completed" || taskFilter.dateField === "completed"
          ? t.completedAt
            ? dateText(localDate(new Date(t.completedAt)))
            : "已完成"
          : !showOnlyCompleted && t.dueDate && t.dueDate < localDate()
            ? "已过期"
            : t.dueDate
              ? dateText(t.dueDate)
              : "无日期";
      if (!result.has(label)) result.set(label, []);
      result.get(label)!.push(t);
    }
    return Array.from(result, ([label, tasks]) => ({ label, tasks }));
  }, [openTasks, doneTasks, view, showOnlyCompleted, taskFilter.dateField]);

  async function addTaskFromInput(text: string, overrides: Partial<Task> & {defaultDueDate?: string | null} = {}) {
    if (!text.trim() || creatingTask.current) return;
    creatingTask.current = true;
    const {title: _title, defaultDueDate, ...explicit} = overrides;
    const tagDefaults = view.startsWith("tag:") ? {tags: [view.slice(4)]} : {};
    const receipt = await perform({type: "quickAdd", text, listId: explicit.listId || currentListId,
      date: defaultDueDate || "none",
      overrides: {...tagDefaults, ...explicit}});
    creatingTask.current = false;
    if (!receipt) return;
    const result = receipt.result as {task?: Task; id?: string};
    if (result?.task?.id || result?.id) setSelectedId(result.task?.id || result.id || null);
    return receipt;
  }
  async function trashTask(id: string) {
    if (await perform({type: "taskTrash", id})) {
      if (selectedId === id) setSelectedId(null);
      setContext(null); setToast("任务已移到回收站，可随时恢复。");
    }
  }
  async function restoreTask(id: string) {
    if (await perform({type: "taskRestore", id})) {
      setContext(null); setToast("任务已恢复。");
    }
  }
  async function purgeTask(id?: string) {
    if (snapshot?.preferences.confirmPurge && !window.confirm(id ? "永久删除这条任务？此操作无法从回收站恢复。" : "永久清空回收站？此操作无法恢复。")) return;
    if (await perform(id ? {type: "taskPurge", id, confirmed: true} : {type: "trashEmpty", confirmed: true})) {
      setSelectedId(null); setContext(null); setToast("已永久删除。");
    }
  }
  async function importText(text: string) {
    const receipt = await perform({type: "import", text});
    if (receipt) setToast("导入已完成，已有任务保留本机版本。");
  }
  async function flushBeforeLeaving(): Promise<boolean> {
    if (unsubmittedForm.current || detailDraft.current || habitDraft.current) { setToast("有尚未提交的输入或表单，请先保存或取消，再关闭主界面。"); return false; }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await Promise.resolve();
    while (pendingWrites.current.size) await Promise.allSettled([...pendingWrites.current]);
    if (failedWrites.current.size) { setToast("还有未确认保存的操作，请先重试或放弃这些操作，再关闭。"); return false; }
    return true;
  }
  async function closeWindow() {
    if (exitRequested.current || !await flushBeforeLeaving()) return;
    setWindowControlHover(null);
    try { await desktopAction("closeMain"); } catch (error) { setToast(errorMessage(error)); }
  }
  async function prepareExit() {
    const sequence = ++exitSequence.current;
    exitRequested.current = true; setExitPending(true);
    try {
      const ready = await flushBeforeLeaving();
      if (sequence !== exitSequence.current) return;
      if (!ready) { exitRequested.current = false; setExitPending(false); }
      await desktopAction("exitReady", {window: "main", ready});
    } catch (error) {
      if (sequence !== exitSequence.current) return;
      exitRequested.current = false; setExitPending(false); setToast(errorMessage(error));
      await desktopAction("exitReady", {window: "main", ready: false}).catch(() => {});
    }
  }
  async function retryFailedWrites() {
    setRetryingWrites(true);
    try {
      for (const operation of [...failedWrites.current.values()]) await perform(operation);
    } finally { setRetryingWrites(false); }
  }
  async function discardFailedWrites() {
    if (!window.confirm("放弃重试这些操作并重新读取已保存的数据？尚未保存的修改会丢失，已经保存成功的数据会保留。")) return;
    try {
      acceptSnapshot(await getSnapshot());
      failedWrites.current.clear(); setFailedWriteCount(0); setSaveStatus("saved");
      setDetailReset((value) => value + 1);
      setToast("已重新读取核心中的数据。");
    } catch (error) { setToast(errorMessage(error)); }
  }
  async function doImport() {
    try { const text = await importBackup(); if (text !== null) await importText(text); }
    catch (error) { setToast(errorMessage(error)); }
  }
  async function doExport() {
    try { if (await exportBackup()) setToast("备份已导出。"); }
    catch (error) { setToast(errorMessage(error)); }
  }

  if (loadError)
    return (
      <div className="boot-error">
        <ShieldCheck size={40} />
        <h1>本地数据暂时无法读取</h1>
        <p>{loadError}</p>
        <p>为保全已有数据，应用没有创建空数据覆盖原文件。</p>
        <button
          className="primary-button"
          onClick={() => setBoot((x) => x + 1)}
        >
          重新读取
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="boot-loading">
        <span className="loading-mark">
          <Check size={22} />
        </span>
        <span>正在读取 DitaList…</span>
      </div>
    );

  const canDropOnNav = (id: ViewId) =>
    id === "today" ||
    id === "next7" ||
    id === "inbox" ||
    id === "completed" ||
    id === "trash" ||
    id.startsWith("list:") ||
    id.startsWith("tag:");

  const handleSidebarDrop = (target: ViewId, taskId: string) => {
    setDragOverNav(null); setDraggingTaskId(null);
    if (taskId) void perform({type: "taskMove", id: taskId, view: target});
  };

  const orderedLists = data.lists
    .filter((list) => list.id !== "inbox" && !list.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const hasDropHintTask = !draggingListId && Boolean(draggingTaskId || selectedId);

  const handleListDrop = (e: React.DragEvent, target: ListMoveTarget) => {
    e.preventDefault();
    e.stopPropagation();
    const listId = e.dataTransfer.getData("text/dida-list");
    setDraggingListId(null);
    setListDropTarget(null);
    if (!listId || listId !== draggingListId) return;
    void perform({type: "listMove", id: listId, target});
  };

  const listGroupDropProps = (folderId: string | null) => ({
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!draggingListId || !e.dataTransfer.types.includes("text/dida-list")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setListDropTarget({ kind: "group", folderId });
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setListDropTarget((target) => target?.kind === "group" &&
        target.folderId === folderId ? null : target);
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes("text/dida-list")) return;
      const details = e.currentTarget.closest("details");
      handleListDrop(e, { kind: "group", folderId });
      if (details) details.open = true;
    },
  });

  const sidebarItem = (
    id: ViewId,
    label: string,
    Icon: LucideIcon,
    count?: number,
  ) => {
    const droppable = canDropOnNav(id);
    const isDropCandidate = droppable && view !== id && hasDropHintTask;
    return (
      <button
        key={id}
        className={`sidebar-item ${view === id ? "selected" : ""} ${isDropCandidate ? "drop-candidate" : ""} ${dragOverNav === id ? "drag-over" : ""}`}
        title={
          id === "inbox"
            ? "暂时不知道放哪的任务先放这里，之后再整理；也可将任务拖到这里、今天或最近7天"
            : droppable
              ? `可将任务拖动到「${label}」`
              : undefined
        }
        onClick={() => go(id)}
        onDragOver={
          droppable
            ? (e) => {
                if (!e.dataTransfer.types.includes("text/dida-task")) return;
                e.preventDefault();
                if (dragOverNav !== id) setDragOverNav(id);
              }
            : undefined
        }
        onDragLeave={
          droppable
            ? () => {
                if (dragOverNav === id) setDragOverNav(null);
              }
            : undefined
        }
        onDrop={
          droppable
            ? (e) => {
                if (!e.dataTransfer.types.includes("text/dida-task")) return;
                e.preventDefault();
                handleSidebarDrop(
                  id,
                  e.dataTransfer.getData("text/dida-task"),
                );
              }
            : undefined
        }
        data-nav-id={id}
      >
        <Icon size={17} />
        <span>{label}</span>
        {!!count && <small>{count}</small>}
      </button>
    );
  };
  const listItem = (l: TaskList) => {
    const navId: ViewId = `list:${l.id}`;
    const isDropCandidate = view !== navId && hasDropHintTask;
    const dropPosition = listDropTarget?.kind === "list" &&
      listDropTarget.listId === l.id ? listDropTarget.position : "";
    return (
      <div
        key={l.id}
        className={`sidebar-list-item ${draggingListId === l.id ? "is-list-dragging" : ""} ${dropPosition ? `list-drop-${dropPosition}` : ""}`}
        onContextMenu={(e) => {
          e.preventDefault();
          setListDialog(l);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("text/dida-list")) {
            e.stopPropagation();
            if (!draggingListId || draggingListId === l.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const bounds = e.currentTarget.getBoundingClientRect();
            setListDropTarget({
              kind: "list",
              listId: l.id,
              position: e.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
            });
            return;
          }
          if (!e.dataTransfer.types.includes("text/dida-task")) return;
          e.preventDefault();
          if (dragOverNav !== navId) setDragOverNav(navId);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          if (dragOverNav === navId) setDragOverNav(null);
          setListDropTarget((target) => target?.kind === "list" &&
            target.listId === l.id ? null : target);
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes("text/dida-list")) {
            const bounds = e.currentTarget.getBoundingClientRect();
            handleListDrop(e, {
              kind: "list",
              listId: l.id,
              position: e.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
            });
            return;
          }
          if (!e.dataTransfer.types.includes("text/dida-task")) return;
          e.preventDefault();
          handleSidebarDrop(navId, e.dataTransfer.getData("text/dida-task"));
        }}
      >
        <button
          className={`sidebar-item draggable-list ${view === navId ? "selected" : ""} ${isDropCandidate ? "drop-candidate" : ""} ${dragOverNav === navId ? "drag-over" : ""}`}
          draggable
          title="拖动调整顺序或移入分组；双击可编辑清单"
          onDragStart={(e) => {
            e.dataTransfer.setData("text/dida-list", l.id);
            e.dataTransfer.effectAllowed = "move";
            setDraggingListId(l.id);
            setDraggingTaskId(null);
            setDragOverNav(null);
            setListDropTarget(null);
          }}
          onDragEnd={() => {
            setDraggingListId(null);
            setListDropTarget(null);
          }}
          onClick={() => go(navId)}
          onDoubleClick={() => setListDialog(l)}
          data-nav-id={navId}
        >
          <List size={17} style={{ color: l.color }} />
          <span>{l.name}</span>
          <small>{active.filter((t) => t.listId === l.id).length || ""}</small>
        </button>
        <button
          className="list-edit-button"
          aria-label={`编辑清单 ${l.name}`}
          onClick={() => setListDialog(l)}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };
  const tagItem = (t: string) => {
    const navId: ViewId = `tag:${t}`;
    const isDropCandidate = view !== navId && hasDropHintTask;
    const count = active.filter((x) => x.tags.includes(t)).length;
    return (
      <div
        key={t}
        className="sidebar-list-item"
        onContextMenu={(e) => {
          e.preventDefault();
          setTagDialog({ mode: "edit", name: t });
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("text/dida-task")) return;
          e.preventDefault();
          if (dragOverNav !== navId) setDragOverNav(navId);
        }}
        onDragLeave={() => {
          if (dragOverNav === navId) setDragOverNav(null);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("text/dida-task")) return;
          e.preventDefault();
          handleSidebarDrop(navId, e.dataTransfer.getData("text/dida-task"));
        }}
      >
        <button
          className={`sidebar-item ${view === navId ? "selected" : ""} ${isDropCandidate ? "drop-candidate" : ""} ${dragOverNav === navId ? "drag-over" : ""}`}
          title={`可将任务拖动到标签 #${t}，双击、右键或点击右侧按钮可重命名或删除`}
          onClick={() => go(navId)}
          onDoubleClick={() => setTagDialog({ mode: "edit", name: t })}
          data-nav-id={navId}
        >
          <Hash size={17} />
          <span>{t}</span>
          {!!count && <small>{count}</small>}
        </button>
        <button
          className="list-edit-button"
          aria-label={`编辑标签 ${t}`}
          title={`重命名或删除标签 #${t}`}
          onClick={() => setTagDialog({ mode: "edit", name: t })}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  const taskDetailPanel = selected ? (
    <TaskDetail
      key={`${selected.id}:${detailReset}`}
      task={selected}
      data={data}
      onPatch={(patch) => patchTask(selected.id, patch)}
      onToggle={() => toggle(selected.id)}
      onClose={() => setSelectedId(null)}
      onDate={() => setDateTask(selected)}
      onTrash={() => trashTask(selected.id)}
      onRestore={() => restoreTask(selected.id)}
      onNewList={() => setListDialog("list")}
      onToast={setToast}
      onDraftChange={reportDetailDraft}
    />
  ) : null;

  return (
    <div
      className={`app-shell ${selected && view !== "calendar" ? "detail-visible" : ""}`}
      onClick={() => {
        if (context) setContext(null);
      }}
    >
      <AppNavigation
        data={data}
        view={view}
        active={active}
        tags={tags}
        saveStatus={saveStatus}
        saveStatusLabel={saveStatusLabels[saveStatus]}
        sidebarOpen={sidebarOpen}
        draggingListId={draggingListId}
        listDropTarget={listDropTarget}
        onGo={go}
        onSettings={setSettingsSection}
        onSearch={() => setSearchOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onSaveNavigation={async (preferences) => Boolean(await perform({type: "navigationUpdate", preferences, renames: {}}))}
        onEditingChange={setNavigationEditing}
        onAgentReview={() => go("agent-review")}
        todayCount={snapshot!.todayCount}
        pendingCount={snapshot!.pendingCount}
        onCloseSidebar={() => setSidebarOpen(false)}
        onAddList={() => setListDialog("list")}
        onAddFolder={() => setListDialog("folder")}
        onAddTag={() => setTagDialog({ mode: "create", name: "" })}
        onAddFilter={() => setFilterDialog(true)}
        renderSidebarItem={sidebarItem}
        renderListItem={listItem}
        renderTagItem={tagItem}
        listGroupDropProps={listGroupDropProps}
      />
      {info?.kind === "desktop" && (
        <div className="window-drag-bar" data-tauri-drag-region aria-hidden="true" />
      )}
      <main
        className={`main-content ${["calendar", "matrix", "focus", "habits"].includes(view) ? "full-view" : ""}`}
      >
        <div className={view === "focus" ? "persistent-focus" : "hidden"}>
          <FocusView data={data} focus={snapshot!.focus} visible={view === "focus"} onCommand={perform} />
        </div>
        {view === "agent-review" ? (
          <AgentReviewPanel snapshot={snapshot!} onCommand={perform} onOpenSidebar={() => setSidebarOpen(true)}/>
        ) : view === "calendar" ? (
          <CalendarView
            key={calendarKey}
            data={data}
            anchor={anchor}
            mode={data.settings.calendarMode}
            showBacklog={calendarBacklogOpen}
            onBacklogChange={(open) => {
              setCalendarBacklogOpen(open);
              if (open) setSelectedId(null);
            }}
            detailPanel={taskDetailPanel}
            onAnchorChange={setAnchor}
            onModeChange={(mode) => void perform({type: "settingsUpdate", patch: {calendarMode: mode}})}
            onSelectTask={(id) => {
              setCalendarBacklogOpen(false);
              setSelectedId(id);
            }}
            onCreateTask={(date, endDate, time) =>
              setCreateDialog({ date, endDate, time })
            }
            onMoveTask={(id, date, time) => {
              const t = data.tasks.find((t) => t.id === id);
              if (!t) return;
              const span =
                t.startDate && t.dueDate
                  ? Math.round(
                      (new Date(t.dueDate + "T12:00:00").getTime() -
                        new Date(t.startDate + "T12:00:00").getTime()) /
                        86400000,
                    )
                  : 0;
              const patch: Partial<Task> = {
                dueDate: span ? addDays(date, span) : date,
                startDate: t.startDate ? date : null,
              };
              if (time === null) {
                patch.time = null;
                patch.endTime = null;
              } else if (time) {
                patch.time = time;
                if (t.time && t.endTime) {
                  const mins = (v: string) =>
                    Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
                  const end = Math.min(
                    1439,
                    mins(time) + Math.max(15, mins(t.endTime) - mins(t.time)),
                  );
                  patch.endTime =
                    String(Math.floor(end / 60)).padStart(2, "0") +
                    ":" +
                    String(end % 60).padStart(2, "0");
                }
              }
              patchTask(id, patch);
            }}
            onToggleTask={toggle}
          />
        ) : view === "matrix" ? (
          <MatrixView
            data={data}
            onSelectTask={setSelectedId}
            onToggleTask={toggle}
            onCommand={perform}
          />
        ) : view === "focus" ? null : view === "habits" ? (
          <HabitsView data={data} onCommand={perform} onDraftChange={reportHabitDraft} />
        ) : (
          <div className="task-list-view">
            <header className="view-header task-list-header">
              <button
                className="mobile-menu icon-button"
                aria-label="展开清单"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu size={19} />
              </button>
              <h1
                onDoubleClick={
                  view.startsWith("tag:")
                    ? () => setTagDialog({ mode: "edit", name: view.slice(4) })
                    : undefined
                }
                title={
                  view.startsWith("tag:") ? "双击编辑或删除当前标签" : undefined
                }
              >
                {title}
              </h1>
              {view.startsWith("tag:") && (
                <IconButton
                  label="管理当前标签"
                  onClick={() =>
                    setTagDialog({ mode: "edit", name: view.slice(4) })
                  }
                >
                  <Settings2 size={17} />
                </IconButton>
              )}
              <div className="header-actions">
                {!["completed", "trash"].includes(view) && <IconButton
                  label="添加任务 Ctrl+N"
                  onClick={openNewTask}
                >
                  <Plus size={20} />
                </IconButton>}
                <CustomSelect
                  className="sort-select"
                  ariaLabel="任务排序"
                  alignRight
                  value={sort}
                  options={[
                    { value: "manual", label: "手动排序" },
                    { value: "priority", label: "按优先级" },
                    { value: "date", label: "按日期" },
                    { value: "title", label: "按标题" },
                  ]}
                  onChange={(val) => setSort(val as typeof sort)}
                />
                {view !== "trash" && (
                  <TaskFilterControl
                    key={view}
                    value={taskFilter}
                    defaultShowCompleted={data.settings.showCompleted}
                    completedOnly={view === "completed"}
                    onChange={(value) => setTaskFilters((current) => ({ ...current, [view]: value }))}
                  />
                )}
              </div>
            </header>
            {view !== "trash" && filterActive && (
              <div className="task-filter-summary">
                <span>{describeTaskViewFilter(taskFilter)}</span>
                <button type="button" onClick={clearTaskFilter}>清除筛选</button>
              </div>
            )}
            <div className="task-scroll">
              {groups.map((group, i) => (
                <section className="task-group" key={`${group.label}-${i}`}>
                  {group.label && (
                    <div
                      className={`group-heading ${group.label === "已过期" ? "overdue" : ""}`}
                    >
                      <h2>{group.label}</h2>
                      <span>{group.tasks.length}</span>
                      {!showOnlyCompleted && (
                        <IconButton
                          label={`在${group.label}添加任务`}
                          onClick={() =>
                            setCreateDialog({
                              date: group.label === "已过期" ? localDate() : group.tasks[0]?.dueDate || null,
                            })
                          }
                        >
                          <Plus size={16} />
                        </IconButton>
                      )}
                    </div>
                  )}
                  {group.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      list={data.lists.find((l) => l.id === t.listId)}
                      selected={selectedId === t.id}
                      dragging={draggingTaskId === t.id}
                      showList={!view.startsWith("list:")}
                      onSelect={() => setSelectedId(t.id)}
                      onDragStartTask={() => {
                        setSelectedId(t.id);
                        setDraggingTaskId(t.id);
                      }}
                      onDragEndTask={() => {
                        setDraggingTaskId(null);
                        setDragOverNav(null);
                      }}
                      onToggle={() => toggle(t.id)}
                      onDate={() => setDateTask(t)}
                      onContext={(e) => {
                        e.preventDefault();
                        setContext({
                          id: t.id,
                          x: Math.min(e.clientX, window.innerWidth - 220),
                          y: Math.min(e.clientY, window.innerHeight - 290),
                        });
                      }}
                      onDrop={(dragId) => {
                        if (dragId === t.id) return;
                        const ids = visibleTasks.map((item) => item.id).filter((id) => id !== dragId);
                        ids.splice(ids.indexOf(t.id), 0, dragId);
                        void perform({type: "taskReorder", ids});
                      }}
                    />
                  ))}
                </section>
              ))}
              {!visibleTasks.length &&
                view !== "completed" &&
                view !== "trash" && (
                  <div className="list-empty">
                    <div className="empty-line-art">
                      <CheckCheck size={56} strokeWidth={1.1} />
                      <span />
                    </div>
                    <h2>
                      {filterActive ? "没有符合筛选条件的任务" : view === "today"
                        ? "今天，轻松一点"
                        : view === "inbox"
                          ? "把想做的事收集在这里"
                          : "暂时没有任务"}
                    </h2>
                    <p>
                      {filterActive ? "试试调整日期范围或完成状态。" : view === "today"
                        ? "安排好每一件小事，留一点时间给自己。"
                        : "点击右上角 ＋ 添加任务。"}
                    </p>
                    {filterActive && <button type="button" className="text-button" onClick={clearTaskFilter}>清除筛选</button>}
                  </div>
                )}
              {view === "trash" &&
                (!visibleTasks.length ? (
                  <div className="list-empty">
                    <Trash2 size={42} strokeWidth={1.1} />
                    <h2>回收站是空的</h2>
                    <p>删除的任务可以在这里恢复。</p>
                  </div>
                ) : (
                  <div className="trash-actions">
                    <button className="text-button danger" onClick={() => void purgeTask()}>永久清空</button>
                    <label className="purge-preference"><input type="checkbox" checked={!snapshot!.preferences.confirmPurge} onChange={(event) => void perform({type: "preferencesUpdate", patch: {confirmPurge: !event.target.checked}})}/>不再提醒二次确认</label>
                    <button
                      className="text-button"
                      onClick={() => {
                        void perform({type: "trashRestoreAll"});
                        setSelectedId(null); setContext(null);
                      }}
                    >
                      <RotateCcw size={14} />
                      恢复全部
                    </button>
                  </div>
                ))}
              {view === "completed" && !doneTasks.length && (
                <div className="list-empty">
                  <SquareCheck size={46} strokeWidth={1.1} />
                  <h2>{filterActive ? "没有符合筛选条件的任务" : "每一步都值得记录"}</h2>
                  <p>{filterActive ? "试试调整日期范围。" : "已完成的任务会保留在这里。"}</p>
                  {filterActive && (
                    <button type="button" className="text-button" onClick={clearTaskFilter}>清除筛选</button>
                  )}
                </div>
              )}
              {!["completed", "trash"].includes(view) &&
                !showOnlyCompleted &&
                doneTasks.length > 0 && (
                  <div className="completed-section">
                    <div className="completed-heading">
                      <span>已完成</span>
                      <small>{doneTasks.length}</small>
                    </div>
                    {doneTasks.map((t) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          list={data.lists.find((l) => l.id === t.listId)}
                          selected={selectedId === t.id}
                          dragging={draggingTaskId === t.id}
                          onSelect={() => setSelectedId(t.id)}
                          onDragStartTask={() => {
                            setSelectedId(t.id);
                            setDraggingTaskId(t.id);
                          }}
                          onDragEndTask={() => {
                            setDraggingTaskId(null);
                            setDragOverNav(null);
                          }}
                          onToggle={() => toggle(t.id)}
                          onDate={() => setDateTask(t)}
                          onContext={(e) => {
                            e.preventDefault();
                            setContext({
                              id: t.id,
                              x: Math.min(e.clientX, window.innerWidth - 220),
                              y: Math.min(e.clientY, window.innerHeight - 290),
                            });
                          }}
                        />
                      ))}
                  </div>
                )}
            </div>
          </div>
        )}
      </main>
      {view !== "calendar" && taskDetailPanel}

      {context && (
        <div
          className="context-menu popover"
          style={{ left: context.x, top: context.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const task = data.tasks.find((t) => t.id === context.id);
            if (!task) return null;
            return (
              <>
                <button
                  disabled={!!task.deletedAt}
                  title={task.deletedAt ? "恢复任务后可修改完成状态" : undefined}
                  onClick={() => {
                    toggle(task.id);
                    setContext(null);
                  }}
                >
                  <Check size={15} />
                  {task.completedAt ? "标为未完成" : "完成任务"}
                </button>
                <button
                  onClick={() => {
                    setDateTask(task);
                    setContext(null);
                  }}
                >
                  <CalendarDays size={15} />
                  设置日期
                </button>
                <button
                  onClick={() => {
                    patchTask(task.id, { pinned: !task.pinned });
                    setContext(null);
                  }}
                >
                  <Pin size={15} />
                  {task.pinned ? "取消置顶" : "置顶"}
                </button>
                <div className="menu-priorities">
                  {priorities.map((p) => (
                    <button
                      title={p.label}
                      key={p.value}
                      onClick={() => {
                        patchTask(task.id, { priority: p.value });
                        setContext(null);
                      }}
                    >
                      <Flag
                        size={17}
                        style={{ color: p.color }}
                        fill={task.priority === p.value ? p.color : "none"}
                      />
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => {
                    void perform({type: "taskCopy", id: task.id});
                    setContext(null);
                  }}
                >
                  <Copy size={15} />
                  复制任务
                </button>
                <div className="menu-divider" />
                {task.deletedAt && <button className="danger" onClick={() => void purgeTask(task.id)}><Trash2 size={15}/>永久删除</button>}
                {task.deletedAt ? (
                  <button
                    onClick={() => restoreTask(task.id)}
                  >
                    <RotateCcw size={15} />
                    恢复任务
                  </button>
                ) : (
                  <button className="danger" onClick={() => trashTask(task.id)}>
                    <Trash2 size={15} />
                    删除任务
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}
      {createDialog && (
        <NewTaskDialog
          data={data}
          defaultList={currentListId}
          date={createDialog.date}
          endDate={createDialog.endDate}
          defaultTime={createDialog.time}
          onClose={() => setCreateDialog(null)}
          onNewList={() => setListDialog("list")}
          onCreate={async (input) => {
            if (await addTaskFromInput(input.title, input)) setCreateDialog(null);
            else throw new Error("任务尚未保存，请检查提示后重试。");
          }}
        />
      )}
      {dateTask && (
        <DateDialog
          task={dateTask}
          onClose={() => setDateTask(null)}
          onSave={async (patch) => {
            if (await patchTask(dateTask.id, patch)) setDateTask(null);
          }}
        />
      )}
      {listDialog && (
        <ListDialog
          value={listDialog}
          data={data}
          onClose={() => setListDialog(null)}
          onSave={async (name, color, folderId) => {
            const id = typeof listDialog === "object" ? listDialog.id : listDraftId.current;
            const value = listDialog === "folder"
              ? {id, name, sortOrder: data.folders.length}
              : {...(typeof listDialog === "object" ? listDialog : {id, archived: false, sortOrder: data.lists.length}), name, color, folderId};
            if (await perform({type: "collectionUpsert", collection: listDialog === "folder" ? "folders" : "lists", value})) {
              if (listDialog === "list") go(`list:${id}`);
              setListDialog(null);
            }
          }}
          onArchive={typeof listDialog === "object" ? async () => {
            if (await perform({type: "collectionUpsert", collection: "lists", value: {...listDialog, archived: true}})) {
              setListDialog(null); go("all");
            }
          } : undefined}
        />
      )}
      {tagDialog && (
        <TagDialog mode={tagDialog.mode} initialName={tagDialog.name} onClose={() => setTagDialog(null)}
          onSave={async (rawName) => {
            const name = rawName.trim().replace(/^#+/, "").trim();
            if (!name) return;
            const operation: Operation = tagDialog.mode === "create"
              ? {type: "settingsUpdate", patch: {customTags: [...new Set([...(data.settings.customTags || []), name])]}}
              : {type: "tagRename", from: tagDialog.name, to: name};
            if (await perform(operation)) {
              if (tagDialog.mode === "edit" && tagDialog.name !== name) setTaskFilters((filters) => {
                const next = {...filters};
                if (next[`tag:${tagDialog.name}`]) next[`tag:${name}`] = next[`tag:${tagDialog.name}`];
                delete next[`tag:${tagDialog.name}`]; return next;
              });
              setTagDialog(null); go(`tag:${name}`);
            }
          }}
          onDelete={tagDialog.mode === "edit" ? async () => {
            if (await perform({type: "tagDelete", name: tagDialog.name})) {
              setTagDialog(null); if (view === `tag:${tagDialog.name}`) go("all");
            }
          } : undefined}
        />
      )}
      {filterDialog && (
        <FilterDialog onClose={() => setFilterDialog(false)} onSave={async (name, query) => {
          const id = filterDraftId.current;
          if (await perform({type: "collectionUpsert", collection: "filters", value: {id, name, query, color: data.settings.accent}})) {
            setFilterDialog(false); go(`filter:${id}`);
          }
        }}/>
      )}
      {searchOpen && (
        <div
          className="modal-backdrop search-backdrop"
          onMouseDown={() => setSearchOpen(false)}
        >
          <div
            className="search-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="search-input">
              <Search size={20} />
              <input
                autoFocus
                placeholder="搜索任务、描述或 #标签"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="搜索全部任务"
              />
              <kbd>Esc</kbd>
            </div>
            <div className="search-results">
              {search.trim() ? (
                data.tasks
                  .filter((t) => !t.deletedAt && t.agentStatus !== "pending" && matchesQuery(t, search))
                  .slice(0, 100)
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        const list = data.lists.find(
                          (l) => l.id === t.listId && !l.archived,
                        );
                        const targetView: ViewId = t.completedAt
                            ? "completed"
                            : t.listId === "inbox"
                              ? "inbox"
                              : list
                                ? `list:${list.id}`
                                : "all";
                        setTaskFilters((filters) => { const next = {...filters}; delete next[targetView]; return next; });
                        go(targetView);
                        searchTargetId.current = t.id;
                        setSearchOpen(false);
                        setSelectedId(t.id);
                      }}
                    >
                      <span className={`search-check p${t.priority}`}>
                        {t.completedAt && <Check size={11} />}
                      </span>
                      <span>
                        {t.title}
                        <small>
                          {data.lists.find((l) => l.id === t.listId)?.name}
                        </small>
                      </span>
                      <time>{dateText(t.dueDate)}</time>
                    </button>
                  ))
              ) : (
                <p>输入关键词查找本机的任务</p>
              )}
              {search.trim() &&
                !data.tasks.some(
                  (t) => !t.deletedAt && t.agentStatus !== "pending" && matchesQuery(t, search),
                ) && <p>没有找到相关任务</p>}
            </div>
          </div>
        </div>
      )}
      {settingsSection && (
        <SettingsDialog
          data={data}
          info={info}
          initialTab={settingsSection}
          saveStatus={saveStatus}
          onClose={() => setSettingsSection(null)}
          snapshot={snapshot!}
          onCommand={perform}
          onChange={(settings) => void perform({type: "settingsUpdate", patch: settings})}
          onExport={doExport}
          onImport={doImport}
          onReveal={() => void desktopAction("revealData")}
          onToast={setToast}
          onUnarchive={(id) => {
            const list = data.lists.find((item) => item.id === id);
            if (list) void perform({type: "collectionUpsert", collection: "lists", value: {...list, archived: false}});
          }}
        />
      )}
      {helpOpen && (
        <div className="modal-backdrop" onMouseDown={() => setHelpOpen(false)}>
          <div
            className="dialog help-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="dialog-header">
              <h2>快捷键与使用帮助</h2>
              <IconButton label="关闭帮助" onClick={() => setHelpOpen(false)}>
                <X size={18} />
              </IconButton>
            </div>
            {[
              ["Ctrl + N", "新建任务"],
              ["Ctrl + K", "搜索全部任务"],
              ["Ctrl + 1 / 2 / 3 / 4", "今天 / 最近7天 / 收集箱 / 日历"],
              ["Enter", "快速添加任务"],
              [shortcutLabel(data.settings.floatingShortcut), "展开悬浮栏快速输入"],
              ["Esc", "关闭详情和弹窗"],
            ].map(([key, text]) => (
              <div className="shortcut-row" key={key}>
                <span>{text}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
            <div className="help-note">
              <p>
                快速输入：<code>明天 10:00 看书 #学习 !2</code>
              </p>
              <p>
                在月历空白处双击添加任务，拖动任务即可改期。任务右键菜单可以置顶、复制和设置优先级。
              </p>
              <p>悬浮栏点击“今天”查看待办，点击“+”快速输入，拖动左侧握柄调整位置。输入时 Enter 保存、Shift + Enter 换行、Esc 收起并保留本次运行中的草稿。</p>
              <p>
                数据只保存在当前设备。请定期在“设置 →
                数据与备份”导出；在另一台设备导入即可迁移。
              </p>
            </div>
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) {
            if (file.size > 50 * 1024 * 1024)
              setToast("文件超过50MB，暂无法导入。");
            else await importText(await file.text());
          }
          e.target.value = "";
        }}
      />
      {failedWriteCount > 0 && !navigationEditing && <div className="save-recovery" role="alert">
        <span>{failedWriteCount} 项操作尚未确认保存</span>
        <button disabled={retryingWrites} onClick={() => void retryFailedWrites()}>{retryingWrites ? "正在重试…" : "重试保存"}</button>
        <button disabled={retryingWrites} onClick={() => void discardFailedWrites()}>放弃重试</button>
      </div>}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {info?.kind === "desktop" && (
        <div className="window-controls" onPointerLeave={() => setWindowControlHover(null)}>
          <button
            type="button"
            aria-label="最小化"
            title="最小化"
            data-hovered={windowControlHover === "minimize"}
            onPointerMove={() => setWindowControlHover("minimize")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setWindowControlHover(null);
              if (event.detail > 0) event.currentTarget.blur();
              void desktopAction("minimize");
            }}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            aria-label="最大化或还原"
            title="最大化或还原"
            data-hovered={windowControlHover === "maximize"}
            onPointerMove={() => setWindowControlHover("maximize")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setWindowControlHover(null);
              if (event.detail > 0) event.currentTarget.blur();
              void desktopAction("maximize");
            }}
          >
            <Square size={11} />
          </button>
          <button
            type="button"
            className="close-window"
            aria-label="关闭窗口"
            title="关闭窗口"
            data-hovered={windowControlHover === "close"}
            onPointerMove={() => setWindowControlHover("close")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setWindowControlHover(null);
              if (event.detail > 0) event.currentTarget.blur();
              void closeWindow();
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function attachCompactDragGhost(e: React.DragEvent, task: Task) {
  if (!e.dataTransfer?.setDragImage) return;
  let ghost = document.getElementById("dida-drag-ghost");
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.id = "dida-drag-ghost";
    ghost.className = "task-drag-ghost";
    document.body.appendChild(ghost);
  }
  const color =
    priorities.find((p) => p.value === task.priority)?.color || "#4772fa";
  ghost.innerHTML = "";
  const dot = document.createElement("i");
  dot.className = "task-drag-ghost-dot";
  dot.style.background = color;
  const text = document.createElement("span");
  text.textContent =
    task.title.length > 10 ? `${task.title.slice(0, 10)}…` : task.title;
  ghost.append(dot, text);
  e.dataTransfer.setDragImage(ghost, 28, 20);
}

function TaskRow({
  task,
  list,
  selected,
  dragging,
  showList,
  onSelect,
  onDragStartTask,
  onDragEndTask,
  onToggle,
  onDate,
  onContext,
  onDrop,
}: {
  task: Task;
  list?: TaskList;
  selected: boolean;
  dragging?: boolean;
  showList?: boolean;
  onSelect: () => void;
  onDragStartTask?: () => void;
  onDragEndTask?: () => void;
  onToggle: () => void;
  onDate: () => void;
  onContext: (e: React.MouseEvent) => void;
  onDrop?: (id: string) => void;
}) {
  return (
    <div
      className={`task-row ${selected ? "selected" : ""} ${dragging ? "is-dragging" : ""} ${task.completedAt ? "completed" : ""}`}
      draggable={!task.deletedAt}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/dida-task", task.id);
        attachCompactDragGhost(e, task);
        onDragStartTask?.();
      }}
      onDragEnd={() => onDragEndTask?.()}
      onDragOver={(e) => {
        if (onDrop) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop?.(e.dataTransfer.getData("text/dida-task"));
      }}
      onClick={onSelect}
      onContextMenu={onContext}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") onSelect();
        if (e.key === " ") {
          e.preventDefault();
          if (!task.deletedAt) onToggle();
        }
      }}
      data-task-id={task.id}
    >
      <button
        className={`task-check p${task.priority} ${task.completedAt ? "checked" : ""}`}
        aria-label={`${task.completedAt ? "取消完成" : "完成"} ${task.title}`}
        disabled={!!task.deletedAt}
        title={task.deletedAt ? "恢复任务后可修改完成状态" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {task.completedAt && <Check size={12} />}
      </button>
      <div className="task-row-title">
        <span>{task.title}</span>
        {task.createdBy === "agent" && (
          <span
            className={`agent-task-badge ${task.agentStatus === "pending" && !task.completedAt ? "pending" : "approved"}`}
            title={
              task.agentStatus === "pending" && !task.completedAt
                ? "Agent 创建，等待确认"
                : "Agent 创建，已确认"
            }
          >
            <Bot size={12} />
            {task.agentStatus === "pending" && !task.completedAt
              ? "待确认"
              : "Agent"}
          </span>
        )}
        {task.content && <small className="task-content-indicator">≡</small>}
        {task.subtasks.length > 0 && (
          <small className="subtask-count">
            {task.subtasks.filter((s) => s.completed).length}/
            {task.subtasks.length}
          </small>
        )}
        {task.pinned && <Pin size={12} className="muted" />}
      </div>
      <div className="task-row-meta">
        {task.tags.slice(0, 2).map((t) => (
          <span className="row-tag" key={t}>
            #{t}
          </span>
        ))}
        {showList && list && (
          <small className="row-list" style={{ color: list.color }}>
            {list.name}
          </small>
        )}
        {task.repeat !== "none" && <RotateCcw size={12} />}
        <button
          className={`row-date ${task.dueDate && task.dueDate < localDate() && !task.completedAt ? "overdue" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onDate();
          }}
          title="设置日期"
        >
          {dateText(task.dueDate)}
          {task.time && ` ${task.time}`}
        </button>
      </div>
    </div>
  );
}

function TaskDetail({
  task,
  data,
  onPatch,
  onToggle,
  onClose,
  onDate,
  onTrash,
  onRestore,
  onNewList,
  onToast,
  onDraftChange,
}: {
  task: Task;
  data: AppData;
  onPatch: (patch: Partial<Task>) => Promise<CommandReceipt | null>;
  onToggle: () => void;
  onClose: () => void;
  onDate: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onNewList?: () => void;
  onToast?: (message: string) => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [subtask, setSubtask] = useState("");
  const [tag, setTag] = useState("");
  const [editedTitle, setEditedTitle] = useState(task.title);
  const [editedContent, setEditedContent] = useState(task.content);
  const [draftSubtasks, setDraftSubtasks] = useState(task.subtasks);
  const [draftTags, setDraftTags] = useState(task.tags);
  const collectionDraft = useRef({subtasks: task.subtasks, tags: task.tags, dirtySubtasks: false, dirtyTags: false});
  useEffect(() => {
    const draft = collectionDraft.current;
    if (JSON.stringify(task.subtasks) === JSON.stringify(draft.subtasks)) draft.dirtySubtasks = false;
    if (!draft.dirtySubtasks) { draft.subtasks = task.subtasks; setDraftSubtasks(task.subtasks); }
    if (JSON.stringify(task.tags) === JSON.stringify(draft.tags)) draft.dirtyTags = false;
    if (!draft.dirtyTags) { draft.tags = task.tags; setDraftTags(task.tags); }
  }, [task.subtasks, task.tags]);
  useEffect(() => { onDraftChange(Boolean(subtask.trim() || tag.trim())); return () => onDraftChange(false); }, [subtask, tag, onDraftChange]);
  function editSubtasks(next: Task["subtasks"], commit = true) {
    collectionDraft.current.subtasks = next; collectionDraft.current.dirtySubtasks = true; setDraftSubtasks(next);
    if (commit) void onPatch({subtasks: next});
  }
  function editTags(next: string[]) {
    collectionDraft.current.tags = next; collectionDraft.current.dirtyTags = true; setDraftTags(next);
    void onPatch({tags: next});
  }
  useEffect(() => setEditedTitle(task.title), [task.id, task.title]);
  useEffect(() => setEditedContent(task.content), [task.id, task.content]);
  return (
    <aside className="task-detail" aria-label="任务详情">
      <header className="detail-toolbar">
        <button
          className={`task-check p${task.priority} ${task.completedAt ? "checked" : ""}`}
          aria-label={task.completedAt ? "取消完成任务" : "完成任务"}
          disabled={!!task.deletedAt}
          title={task.deletedAt ? "恢复任务后可修改完成状态" : undefined}
          onClick={onToggle}
        >
          {task.completedAt && <Check size={12} />}
        </button>
        <button
          className={`detail-date ${task.dueDate && task.dueDate < localDate() ? "overdue" : ""}`}
          onClick={onDate}
        >
          <CalendarDays size={16} />
          {task.dueDate
            ? `${dateText(task.dueDate)}${task.time ? " " + task.time : ""}`
            : "设置日期"}
          {task.repeat !== "none" && <RotateCcw size={12} />}
        </button>
        <div className="detail-priority">
          <CustomSelect
            ariaLabel="任务优先级"
            alignRight
            iconOnly
            triggerIcon={<Flag size={17} />}
            value={task.priority}
            options={priorities.map((p) => ({
              value: p.value,
              label: p.label,
              color: p.color,
            }))}
            onChange={(val) => onPatch({ priority: val as Priority })}
          />
        </div>
        <IconButton label="关闭任务详情" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </header>
      <div className="detail-body">
        <textarea
          key={task.id + "title"}
          className={`detail-title ${task.completedAt ? "completed" : ""}`}
          aria-label="任务标题"
          maxLength={10000}
          value={editedTitle}
          onChange={(e) => {
            setEditedTitle(e.target.value);
          }}
          onBlur={() => { const title = editedTitle.trim() || "未命名任务"; if (title !== task.title) onPatch({title}); }}
          rows={Math.min(5, Math.max(1, Math.ceil(task.title.length / 18)))}
        />
        <textarea
          className="detail-description"
          aria-label="任务描述"
          maxLength={2000000}
          placeholder="添加描述"
          value={editedContent}
          onChange={(e) => setEditedContent(e.target.value)}
          onBlur={() => { if (editedContent !== task.content) onPatch({content: editedContent}); }}
          rows={Math.max(4, Math.min(14, task.content.split("\n").length + 1))}
        />
        <div className="subtasks">
          {draftSubtasks.map((s) => (
            <div className="subtask-row" key={s.id}>
              <button
                className={`task-check ${s.completed ? "checked" : ""}`}
                aria-label={`完成子任务 ${s.title}`}
                onClick={() =>
                  editSubtasks(collectionDraft.current.subtasks.map((x) =>
                      x.id === s.id ? { ...x, completed: !x.completed } : x,
                    ))
                }
              >
                {s.completed && <Check size={11} />}
              </button>
              <input
                className={s.completed ? "completed" : ""}
                aria-label="子任务标题"
                maxLength={10000}
                value={s.title}
                onChange={(event) => editSubtasks(collectionDraft.current.subtasks.map((item) => item.id === s.id ? {...item, title: event.target.value} : item), false)}
                onBlur={() => { if (collectionDraft.current.dirtySubtasks) editSubtasks(collectionDraft.current.subtasks); }}
              />
              <button
                className="remove-subtask"
                aria-label={`删除子任务 ${s.title}`}
                onClick={() =>
                  editSubtasks(collectionDraft.current.subtasks.filter((x) => x.id !== s.id))
                }
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <form
            className="add-subtask"
            onSubmit={(e) => {
              e.preventDefault();
              if (!subtask.trim()) return;
              editSubtasks([
                  ...collectionDraft.current.subtasks,
                  {
                    id: crypto.randomUUID(),
                    title: subtask.trim(),
                    completed: false,
                  },
                ]);
              setSubtask("");
            }}
          >
            <Plus size={15} />
            <input
              value={subtask}
              onChange={(e) => setSubtask(e.target.value)}
              placeholder="添加子任务"
              aria-label="添加子任务"
            />
          </form>
        </div>
        <div className="detail-tags">
          {draftTags.map((t) => (
            <span key={t}>
              #{t}
              <button
                title={`移除标签 ${t}`}
                onClick={() =>
                  editTags(collectionDraft.current.tags.filter((x) => x !== t))
                }
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = tag.trim().replace(/^#+/, "");
              if (t && !collectionDraft.current.tags.includes(t))
                editTags([...collectionDraft.current.tags, t]);
              setTag("");
            }}
          >
            <Tag size={13} />
            <input
              aria-label="添加标签"
              maxLength={200}
              placeholder="添加标签"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
          </form>
        </div>
        <div className="detail-settings-row">
          <RotateCcw size={15} />
          <span>重复</span>
          <CustomSelect
            ariaLabel="重复规则"
            alignRight
            value={task.repeat}
            options={repeats}
            onChange={(val) =>
              onPatch({
                repeat: val as RepeatRule,
                ...(val !== "none" && !task.dueDate
                  ? { dueDate: localDate() }
                  : {}),
                recurrenceAnchor: task.dueDate || localDate(),
              })
            }
          />
        </div>
        <button className="detail-settings-row" onClick={onDate}>
          <Bell size={15} />
          <span>提醒</span>
          <small>
            {reminders.find((r) => r.value === task.reminder)?.label}
          </small>
          <ChevronRight size={14} />
        </button>
        {task.startDate && task.startDate !== task.dueDate && (
          <p className="detail-range">
            {task.startDate} 至 {task.dueDate}
          </p>
        )}
      </div>
      <footer className="detail-footer">
        <div className="detail-list-select">
          <TaskDestinationSelect
            listId={task.listId}
            lists={data.lists}
            ariaLabel="所属清单"
            popUp
            onNewList={onNewList}
            onChange={(patch, notice) => {
              onPatch(patch);
              if (notice) onToast?.(notice);
            }}
          />
        </div>
        <IconButton
          label={task.pinned ? "取消置顶" : "置顶任务"}
          onClick={() => onPatch({ pinned: !task.pinned })}
        >
          <Pin size={15} fill={task.pinned ? "currentColor" : "none"} />
        </IconButton>
        {task.deletedAt ? (
          <IconButton label="恢复任务" onClick={onRestore}>
            <RotateCcw size={16} />
          </IconButton>
        ) : (
          <IconButton label="删除任务" onClick={onTrash}>
            <Trash2 size={16} />
          </IconButton>
        )}
      </footer>
    </aside>
  );
}

export interface SelectOption<T extends string | number = string> {
  value: T;
  label: string;
  color?: string;
}

export function CustomSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  alignRight = false,
  popUp = false,
  disabled = false,
  iconOnly = false,
  triggerIcon,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  alignRight?: boolean;
  popUp?: boolean;
  disabled?: boolean;
  iconOnly?: boolean;
  triggerIcon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) || options[0];

  return (
    <div className={`custom-select ${className}`} ref={wrapperRef}>
      <select
        className="sr-only-select"
        aria-label={ariaLabel}
        tabIndex={-1}
        disabled={disabled}
        value={String(value)}
        onChange={(e) => {
          const found = options.find((o) => String(o.value) === e.target.value);
          if (found) onChange(found.value);
        }}
      >
        {options.map((opt) => (
          <option key={String(opt.value)} value={String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={`custom-select-trigger ${iconOnly ? "icon-only" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={ariaLabel || selected?.label}
        style={selected?.color ? { color: selected.color } : undefined}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        {triggerIcon}
        {!iconOnly && <span>{selected?.label}</span>}
        {!iconOnly && <ChevronDown size={13} />}
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={wrapperRef}
          className="custom-select-popover"
          role="listbox"
          ariaLabel={ariaLabel}
          alignRight={alignRight}
          preferAbove={popUp}
          maxHeight={280}
          onClose={() => setOpen(false)}
        >
          {options.map((opt) => (
            <button
              type="button"
              role="option"
              aria-selected={opt.value === value}
              key={String(opt.value)}
              className={`custom-select-option ${opt.value === value ? "is-selected" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span
                className="custom-select-option-label"
                style={opt.color ? { color: opt.color } : undefined}
              >
                {opt.color && (
                  <i
                    className="custom-select-dot"
                    style={{ background: opt.color }}
                  />
                )}
                {opt.label}
              </span>
              {opt.value === value && <Check size={13} />}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

function TaskDestinationSelect({
  listId,
  lists,
  ariaLabel,
  popUp = false,
  onChange,
  onNewList,
}: {
  listId: string;
  lists: TaskList[];
  ariaLabel: string;
  popUp?: boolean;
  onChange: (patch: { listId: string }, notice?: string) => void;
  onNewList?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const availableLists = lists.filter((list) => !list.archived);
  const currentList =
    availableLists.find((list) => list.id === listId) ||
    lists.find((list) => list.id === listId);

  return (
    <div className="custom-select destination-select" ref={wrapperRef}>
      <select
        className="sr-only-select"
        aria-label={ariaLabel}
        tabIndex={-1}
        value={listId}
        onChange={(event) => onChange({ listId: event.target.value })}
      >
        {availableLists.map((list) => (
          <option key={list.id} value={list.id}>
            {list.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="custom-select-trigger destination-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={ariaLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <i
          className="custom-select-dot"
          style={{ background: currentList?.color || "#4772fa" }}
        />
        <span className="destination-trigger-text">
          清单：{currentList?.name || "收集箱"}
        </span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={wrapperRef}
          className="custom-select-popover destination-popover"
          role="dialog"
          ariaLabel="选择归属清单"
          preferAbove={popUp}
          maxHeight={320}
          onClose={() => setOpen(false)}
        >
          <div className="destination-group-title">归属清单</div>
          <p className="destination-hint">
            不确定放哪里时，先留在收集箱，以后再归类。日期单独设置。
          </p>
          <div
            className="destination-list-options"
            role="listbox"
            aria-label={ariaLabel}
          >
            {availableLists.map((list) => (
              <button
                type="button"
                role="option"
                aria-selected={list.id === listId}
                key={list.id}
                className={`custom-select-option ${list.id === listId ? "is-selected" : ""}`}
                onClick={() => {
                  onChange({ listId: list.id }, `已归入清单「${list.name}」`);
                  setOpen(false);
                }}
              >
                <span className="custom-select-option-label">
                  <i
                    className="custom-select-dot"
                    style={{ background: list.color }}
                  />
                  {list.name}
                  {list.id === "inbox" && <small>默认</small>}
                </span>
                {list.id === listId && <Check size={13} />}
              </button>
            ))}
          </div>
          {onNewList && (
            <>
              <div className="destination-divider" />
              <button
                type="button"
                className="custom-select-option destination-new-list"
                onClick={() => {
                  setOpen(false);
                  onNewList();
                }}
              >
                <span className="custom-select-option-label">
                  <Plus size={14} />
                  新建清单…
                </span>
              </button>
            </>
          )}
        </AnchoredPopover>
      )}
    </div>
  );
}

const timeSlots = Array.from({ length: 48 }, (_, idx) => {
  const hh = String(Math.floor(idx / 2)).padStart(2, "0");
  const mm = idx % 2 === 0 ? "00" : "30";
  return `${hh}:${mm}`;
});

function CustomTimeInput({
  value,
  onChange,
  ariaLabel,
  placeholder = "选择时间",
  alignRight = false,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  alignRight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  return (
    <div className="custom-picker" ref={wrapperRef}>
      <input
        type="text"
        value={value}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && (
        <AnchoredPopover
          anchorRef={wrapperRef}
          className="custom-picker-popover custom-time-popover"
          role="dialog"
          ariaLabel={ariaLabel}
          alignRight={alignRight}
          onClose={() => setOpen(false)}
        >
          <div className="custom-time-Presets">
            {["09:00", "12:00", "14:00", "18:00", "20:00"].map((preset) => (
              <button
                type="button"
                key={preset}
                className={value === preset ? "is-selected" : ""}
                onClick={() => {
                  onChange(preset);
                  setOpen(false);
                }}
              >
                {preset}
              </button>
            ))}
          </div>
          <div className="custom-time-list">
            {timeSlots.map((slot) => (
              <button
                type="button"
                key={slot}
                className={`custom-time-item ${value === slot ? "is-selected" : ""}`}
                onClick={() => {
                  onChange(slot);
                  setOpen(false);
                }}
              >
                <span>{slot}</span>
                {value === slot && <Check size={13} />}
              </button>
            ))}
          </div>
          <div className="custom-picker-footer">
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              清除
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={() => {
                const now = new Date();
                const hh = String(now.getHours()).padStart(2, "0");
                const mm = String(Math.floor(now.getMinutes() / 15) * 15).padStart(
                  2,
                  "0",
                );
                onChange(`${hh}:${mm}`);
                setOpen(false);
              }}
            >
              现在
            </button>
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
}

function NewTaskDialog({
  data,
  defaultList,
  date,
  endDate,
  defaultTime,
  onClose,
  onCreate,
  onNewList,
}: {
  data: AppData;
  defaultList: string;
  date: string | null;
  endDate?: string;
  defaultTime?: string;
  onClose: () => void;
  onCreate: (task: Partial<Task> & { title: string; defaultDueDate?: string | null }) => Promise<void>;
  onNewList?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [due, setDue] = useState(endDate || date || "");
  const [dateEdited, setDateEdited] = useState(Boolean(endDate));
  const [list, setList] = useState(defaultList);
  const [priority, setPriority] = useState<Priority>(0);
  const [time, setTime] = useState(defaultTime || "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // The core parses the title. Only an explicit date selection overrides it;
  // the page's date is a fallback, so “明天开会” still means tomorrow on Today.
  const displayedDate = dateEdited ? due : parseQuickInput(title, list).dueDate || due;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="dialog new-task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || submitting) return;
          if (endDate && date && displayedDate && date > displayedDate) { setError("结束日期不能早于开始日期。"); return; }
          setSubmitting(true); setError("");
          try {
            await onCreate({title, content, listId: list, defaultDueDate: endDate || date,
              ...(dateEdited ? {dueDate: due || null} : {}), ...(endDate ? {startDate: date} : {}),
              ...(time ? {time} : {}), ...(priority ? {priority} : {})});
          } catch (error) { setError(errorMessage(error)); }
          finally { setSubmitting(false); }
        }}
      >
        <div className="dialog-header">
          <h2 id="new-task-title">添加任务</h2>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <input
          className="new-task-title"
          autoFocus
          aria-label="新任务标题"
          placeholder="准备做些什么？"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={2000}
        />
        <textarea
          aria-label="新任务描述"
          placeholder="添加描述"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
        />
        <div className="new-task-options">
          <label>
            <CalendarDays size={15} />
            <CustomDateInput
              value={displayedDate}
              ariaLabel="新任务日期"
              onChange={(value) => { setDue(value); setDateEdited(true); }}
            />
          </label>
          <label>
            <Clock3 size={15} />
            <CustomTimeInput
              value={time}
              ariaLabel="新任务时间"
              onChange={setTime}
            />
          </label>
          <div className="new-task-option-item">
            <Flag size={15} />
            <CustomSelect
              value={priority}
              ariaLabel="新任务优先级"
              alignRight
              options={priorities.map((p) => ({
                value: p.value,
                label: p.label,
                color: p.color,
              }))}
              onChange={(val) => setPriority(val as Priority)}
            />
          </div>
        </div>
        <TaskDateHint date={displayedDate || null} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <TaskDestinationSelect
            listId={list}
            lists={data.lists}
            ariaLabel="新任务所属清单"
            onNewList={onNewList}
            onChange={(patch) => {
              setList(patch.listId);
            }}
          />
          <button className="text-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? "正在保存…" : "添加"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DateDialog({
  task,
  onClose,
  onSave,
}: {
  task: Task;
  onClose: () => void;
  onSave: (patch: Partial<Task>) => void;
}) {
  const [date, setDate] = useState(task.dueDate || localDate());
  const [start, setStart] = useState(task.startDate || "");
  const [time, setTime] = useState(task.time || "");
  const [repeat, setRepeat] = useState(task.repeat);
  const [reminder, setReminder] = useState(task.reminder);
  const [error, setError] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="dialog date-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (start && date && start > date) {
            setError("开始日期应早于或等于结束日期。");
            return;
          }
          if (repeat !== "none" && !date) {
            setError("请为重复任务选择日期。");
            return;
          }
          if (reminder !== "none" && (!time || !date)) {
            setError("设置提醒需要先选择日期和时间。");
            return;
          }
          onSave({
            dueDate: date || null,
            startDate: start || null,
            time: time || null,
            repeat,
            reminder,
            recurrenceAnchor: repeat !== "none" ? date : undefined,
          });
        }}
      >
        <div className="dialog-header">
          <h2>日期与提醒</h2>
          <IconButton label="关闭日期设置" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="quick-dates">
          {[
            { text: "今天", date: localDate(), icon: Sun },
            { text: "明天", date: addDays(localDate(), 1), icon: Sun },
            {
              text: "下周",
              date: addDays(localDate(), 7),
              icon: CalendarRange,
            },
          ].map((d) => (
            <button
              type="button"
              key={d.text}
              className={date === d.date ? "selected" : ""}
              onClick={() => setDate(d.date)}
            >
              <d.icon size={19} />
              <span>{d.text}</span>
            </button>
          ))}
        </div>
        <label>
          日期
          <CustomDateInput
            ariaLabel="截止日期"
            value={date}
            onChange={setDate}
          />
        </label>
        <TaskDateHint date={date} />
        <div className="date-two-columns">
          <label>
            开始日期（可选）
            <CustomDateInput
              ariaLabel="开始日期"
              value={start}
              onChange={setStart}
              placeholder="可选开始日期"
            />
          </label>
          <label>
            时间
            <CustomTimeInput
              ariaLabel="任务时间"
              value={time}
              onChange={setTime}
              alignRight
            />
          </label>
        </div>
        <div className="select-row">
          <RotateCcw size={16} />
          重复
          <CustomSelect
            ariaLabel="重复"
            alignRight
            value={repeat}
            options={repeats}
            onChange={(val) => setRepeat(val as RepeatRule)}
          />
        </div>
        <div className="select-row">
          <Bell size={16} />
          提醒
          <CustomSelect
            ariaLabel="提醒"
            alignRight
            value={reminder}
            options={reminders}
            onChange={(val) => setReminder(val as Reminder)}
          />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onSave({
                dueDate: null,
                startDate: null,
                time: null,
                repeat: "none",
                reminder: "none",
              })
            }
          >
            清除日期
          </button>
          <button type="button" className="text-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit">
            确定
          </button>
        </div>
      </form>
    </div>
  );
}

function ListDialog({
  value,
  data,
  onClose,
  onSave,
  onArchive,
}: {
  value: "list" | "folder" | TaskList;
  data: AppData;
  onClose: () => void;
  onSave: (name: string, color: string, folderId: string | null) => void;
  onArchive?: () => void;
}) {
  const editing = typeof value === "object";
  const [name, setName] = useState(editing ? value.name : "");
  const [color, setColor] = useState(editing ? value.color : colors[0]);
  const [folderId, setFolder] = useState(editing ? value.folderId || "" : "");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="dialog list-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim(), color, folderId || null);
        }}
      >
        <div className="dialog-header">
          <h2>
            {value === "folder"
              ? "新建清单分组"
              : editing
                ? "编辑清单"
                : "添加清单"}
          </h2>
          <IconButton label="关闭清单设置" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <label>
          名称
          <input
            autoFocus
            aria-label="清单名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder={
              value === "folder" ? "例如：工作相关、生活" : "例如：工作、生活、学习"
            }
            required
          />
        </label>
        {value !== "folder" && (
          <>
            <div className="color-picker">
              {colors.map((c) => (
                <button
                  type="button"
                  key={c}
                  aria-label={`颜色 ${c}`}
                  aria-pressed={color.toLowerCase() === c}
                  className={color.toLowerCase() === c ? "selected" : ""}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                >
                  {color.toLowerCase() === c && <Check size={14} strokeWidth={2.5} />}
                </button>
              ))}
            </div>
            <div className="field-group">
              <span>清单分组（可选）</span>
              <CustomSelect
                ariaLabel="清单分组"
                value={folderId}
                options={[
                  { value: "", label: "不分组" },
                  ...data.folders.map((f) => ({ value: f.id, label: f.name })),
                ]}
                onChange={(val) => setFolder(String(val))}
              />
              <p className="field-help">分组用于在侧栏整理多个清单，不分组时直接显示清单。</p>
            </div>
          </>
        )}
        <div className="dialog-footer">
          {onArchive && (
            <button type="button" className="text-button" onClick={onArchive}>
              <Archive size={14} />
              归档
            </button>
          )}
          <button type="button" className="text-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit">
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

function TagDialog({
  mode,
  initialName,
  onClose,
  onSave,
  onDelete,
}: {
  mode: "create" | "edit";
  initialName: string;
  onClose: () => void;
  onSave: (name: string) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const clean = name.trim().replace(/^#+/, "").trim();
          if (clean) onSave(clean);
        }}
      >
        <div className="dialog-header">
          <h2>{mode === "create" ? "添加标签" : "编辑标签"}</h2>
          <IconButton label="关闭标签设置" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <label>
          标签名称
          <input
            autoFocus
            aria-label="标签名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="例如：工作、读书、紧急（无需输入 #）"
            required
          />
        </label>
        <div className="dialog-footer">
          {onDelete && (
            <button
              type="button"
              className="text-button danger"
              onClick={onDelete}
            >
              <Trash2 size={14} />
              删除标签
            </button>
          )}
          <button type="button" className="text-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit">
            {mode === "create" ? "添加" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

function FilterDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, query: string) => void;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && query.trim()) onSave(name.trim(), query.trim());
        }}
      >
        <div className="dialog-header">
          <h2>添加过滤器</h2>
          <IconButton label="关闭过滤器" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <label>
          名称
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          筛选条件
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例如：#工作 !1"
            required
          />
        </label>
        <p className="muted form-hint">
          支持关键词、#标签、!1 高优先级、!2 中优先级、!3
          低优先级，以及“今天”“逾期”。多个条件用空格连接。
        </p>
        <div className="dialog-footer">
          <button type="button" className="text-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button">创建</button>
        </div>
      </form>
    </div>
  );
}

function SettingsDialog({
  data,
  info,
  initialTab,
  saveStatus,
  onClose,
  onChange,
  onExport,
  onImport,
  onReveal,
  onToast,
  onUnarchive,
  snapshot,
  onCommand,
}: {
  data: AppData;
  info: StorageInfo | null;
  initialTab: "general" | "data";
  saveStatus: SaveStatus;
  onClose: () => void;
  onChange: (settings: Partial<AppData["settings"]>) => void;
  onExport: () => void;
  onImport: () => void;
  onReveal: () => void;
  onToast?: (message: string) => void;
  onUnarchive: (id: string) => void;
  snapshot: Snapshot;
  onCommand: (operation: Operation) => Promise<CommandReceipt | null>;
}) {
  const [tab, setTab] = useState<string>(initialTab);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const floatingVisible = snapshot.preferences.floatingVisible;
  const [changingFloating, setChangingFloating] = useState(false);
  const [floatingError, setFloatingError] = useState("");
  const [desktopShortcutStatus, setDesktopShortcutStatus] = useState<"checking" | "missing" | "exists" | "error">("checking");
  useEffect(() => {
    let active = true;
    void desktopStatus().then((status) => { if (active) setDesktopShortcutStatus(status.shortcutExists ? "exists" : "missing"); })
      .catch(() => { if (active) setDesktopShortcutStatus("error"); });
    return () => { active = false; };
  }, []);
  async function toggleFloating(visible: boolean) {
    if (changingFloating) return;
    setChangingFloating(true); setFloatingError("");
    if (!await onCommand({type: "preferencesUpdate", patch: {floatingVisible: visible}})) setFloatingError("悬浮栏切换失败，请重试。");
    setChangingFloating(false);
  }
  async function createDesktopShortcut() {
    try { await desktopAction("createShortcut"); setDesktopShortcutStatus("exists"); }
    catch (error) { setDesktopShortcutStatus("error"); onToast?.(errorMessage(error)); }
  }
  async function removeDesktopShortcut() {
    try { await desktopAction("removeShortcut"); setDesktopShortcutStatus("missing"); }
    catch (error) { setDesktopShortcutStatus("error"); onToast?.(errorMessage(error)); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <h2>设置</h2>
          {[
            { id: "general", label: "通用", icon: SlidersHorizontal },
            { id: "appearance", label: "外观", icon: Sun },
            { id: "focus", label: "专注", icon: Clock3 },
            { id: "data", label: "数据与备份", icon: ShieldCheck },
             { id: "agent", label: "Agent / MCP", icon: Bot },
          ].map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "selected" : ""}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
          <div className="settings-brand">
            <span className="app-mark">
              <img src="./icon.svg" alt="" />
            </span>
            <strong>DitaList</strong>
            <small>离线使用 · 数据留在本机</small>
          </div>
        </aside>
        <div className="settings-content">
          <div className="dialog-header">
            <h2>
              {
                (
                  {
                    general: "通用",
                    appearance: "外观",
                    focus: "专注",
                    data: "数据与备份",
                     agent: "Agent / MCP",
                  } as Record<string, string>
                )[tab]
              }
            </h2>
            <IconButton label="关闭设置" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
          {tab === "general" && (
            <>
              <label className="setting-row"><span>安静模式<small>保留数量，暂停主动展开与声音</small></span><input type="checkbox" checked={snapshot.preferences.quiet} onChange={(event) => void onCommand({type: "preferencesUpdate", patch: {quiet: event.target.checked}})}/></label>
              <div className="setting-row">
                <span>启动时显示</span>
                <CustomSelect
                  ariaLabel="启动时显示"
                  alignRight
                  value={data.settings.defaultView}
                  options={(
                    [
                      "today",
                      "next7",
                      "inbox",
                      "calendar",
                      "focus",
                      "habits",
                    ] as ViewId[]
                  ).map((v) => ({ value: v, label: labels[v] }))}
                  onChange={(val) => onChange({ defaultView: val as ViewId })}
                />
              </div>
              <div className="setting-row">
                <span>每周开始于</span>
                <CustomSelect
                  ariaLabel="每周开始于"
                  alignRight
                  value={data.settings.weekStart}
                  options={[
                    { value: 1, label: "星期一" },
                    { value: 0, label: "星期日" },
                  ]}
                  onChange={(val) =>
                    onChange({ weekStart: Number(val) as 0 | 1 })
                  }
                />
              </div>
              <label className="setting-row">
                <span>默认显示已完成任务</span>
                <input
                  type="checkbox"
                  checked={data.settings.showCompleted}
                  onChange={(e) =>
                    onChange({ showCompleted: e.target.checked })
                  }
                />
              </label>
              <label className="setting-row">
                <span>任务与专注提醒</span>
                <input
                  type="checkbox"
                  checked={data.settings.notifications}
                  onChange={(e) =>
                    onChange({ notifications: e.target.checked })
                  }
                />
              </label>
              <p className="setting-caption">
                Windows 提醒需要应用保持运行。设备休眠或退出应用时不会触发。
              </p>
              <div className="setting-subheading">桌面悬浮栏</div>
              {info?.kind === "desktop" && (
                <>
                  <label className="setting-row">
                    <span>显示悬浮栏</span>
                    <input
                      type="checkbox"
                      checked={floatingVisible === true}
                      disabled={floatingVisible === null || changingFloating}
                      onChange={(event) => void toggleFloating(event.target.checked)}
                    />
                  </label>
                  {floatingError && <p className="form-error" role="alert">{floatingError}</p>}
                  <p className="setting-caption">
                    点击悬浮栏的“今天”查看待办，点击“+”快速记录，拖动左侧握柄调整位置。数字显示“今天”的未完成任务数（含逾期）。
                  </p>
                </>
              )}
              <div className="setting-row setting-shortcut-row">
                <span>呼出快捷键</span>
                <div className="shortcut-controls">
                  <button
                    type="button"
                    className={`shortcut-capture ${capturingShortcut ? "capturing" : ""}`}
                    onClick={() => setCapturingShortcut(true)}
                    onBlur={() => setCapturingShortcut(false)}
                    onKeyDown={(event) => {
                      const shortcut = shortcutFromKeyEvent(event);
                      if (!shortcut) return;
                      event.preventDefault();
                      onChange({ floatingShortcut: shortcut });
                      setCapturingShortcut(false);
                    }}
                  >
                    {capturingShortcut
                      ? "请按下组合键…"
                      : data.settings.floatingShortcut
                        ? shortcutLabel(data.settings.floatingShortcut)
                        : "未设置"}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onChange({ floatingShortcut: "CommandOrControl+Alt+Space" })}
                  >
                    恢复默认
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <span>默认清单</span>
                <CustomSelect
                  ariaLabel="默认清单"
                  alignRight
                  value={data.settings.floatingDefaultListId}
                  options={data.lists
                    .filter((list) => !list.archived)
                    .map((list) => ({
                      value: list.id,
                      label: list.name,
                      color: list.color,
                    }))}
                  onChange={(val) =>
                    onChange({ floatingDefaultListId: String(val) })
                  }
                />
              </div>
              <div className="setting-row">
                <span>默认日期</span>
                <CustomSelect
                  ariaLabel="默认日期"
                  alignRight
                  value={data.settings.floatingDefaultDate}
                  options={[
                    { value: "none", label: "不设置日期" },
                    { value: "today", label: "今天" },
                    { value: "tomorrow", label: "明天" },
                  ]}
                  onChange={(val) =>
                    onChange({
                      floatingDefaultDate:
                        val as AppData["settings"]["floatingDefaultDate"],
                    })
                  }
                />
              </div>
              <p className="setting-caption">
                托盘切换悬浮栏，快捷键直接展开输入框。输入中的日期和时间会覆盖默认日期。
              </p>
              {info?.kind === "desktop" && (
                <>
                  <div className="setting-row">
                    <span>桌面快捷方式</span>
                    <div className="shortcut-controls">
                      <button
                        type="button"
                        className="shortcut-capture"
                        onClick={() => void createDesktopShortcut()}
                        disabled={desktopShortcutStatus === "checking"}
                      >
                        {desktopShortcutStatus === "exists"
                          ? "重新创建"
                          : "创建桌面图标"}
                      </button>
                      {desktopShortcutStatus === "exists" && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => void removeDesktopShortcut()}
                        >
                          移除
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="setting-caption">
                    快捷方式会放在 Windows 桌面，使用 DitaList 图标启动当前程序。
                    {desktopShortcutStatus === "error" && " 最近一次操作没有成功。"}
                  </p>
                </>
              )}
              <div className="setting-subheading">已归档清单</div>
              {data.lists
                .filter((l) => l.archived)
                .map((l) => (
                  <div className="setting-row" key={l.id}>
                    <span>{l.name}</span>
                    <button
                      className="text-button"
                      onClick={() => onUnarchive(l.id)}
                    >
                      恢复清单
                    </button>
                  </div>
                ))}
              {!data.lists.some((l) => l.archived) && (
                <p className="muted">暂无归档清单</p>
              )}
            </>
          )}
          {tab === "appearance" && (
            <>
              <p className="setting-subheading">主题</p>
              <div className="theme-picker">
                {[
                  { id: "light", label: "浅色", icon: Sun },
                  { id: "dark", label: "深色", icon: Moon },
                  { id: "system", label: "跟随系统", icon: Monitor },
                ].map((t) => (
                  <button
                    key={t.id}
                    className={data.settings.theme === t.id ? "selected" : ""}
                    onClick={() =>
                      onChange({ theme: t.id as AppData["settings"]["theme"] })
                    }
                  >
                    <t.icon size={25} />
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
              <p className="setting-subheading">主题色</p>
              <div className="color-picker">
                {colors.map((c) => (
                  <button
                    key={c}
                    aria-label={`主题色 ${c}`}
                    aria-pressed={data.settings.accent.toLowerCase() === c}
                    style={{ background: c }}
                    className={data.settings.accent.toLowerCase() === c ? "selected" : ""}
                    onClick={() => onChange({ accent: c })}
                  >
                    {data.settings.accent.toLowerCase() === c && <Check size={14} strokeWidth={2.5} />}
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "focus" && (
            <>
              <label className="setting-row">
                <span>番茄专注时长（分钟）</span>
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={data.settings.pomodoroMinutes}
                  onChange={(e) =>
                    onChange({
                      pomodoroMinutes: Math.max(
                        1,
                        Math.min(180, Number(e.target.value) || 1),
                      ),
                    })
                  }
                />
              </label>
              <label className="setting-row">
                <span>休息时长（分钟）</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={data.settings.breakMinutes}
                  onChange={(e) =>
                    onChange({
                      breakMinutes: Math.max(
                        1,
                        Math.min(60, Number(e.target.value) || 1),
                      ),
                    })
                  }
                />
              </label>
              <label className="setting-row">
                <span>专注完成提示音</span>
                <input
                  type="checkbox"
                  checked={data.settings.sound}
                  onChange={(e) => onChange({ sound: e.target.checked })}
                />
              </label>
            </>
          )}
          {tab === "data" && (
            <>
              <div className={`data-status ${saveStatus}`} role="status">
                <ShieldCheck size={23} />
                <div>
                  <strong>{saveStatusLabels[saveStatus]}</strong>
                  <p>
                    {saveStatus === "error"
                      ? "最近的更改尚未保存，请先导出备份，再检查本机存储。"
                      : saveStatus === "saving"
                        ? "正在写入当前设备，请稍候。"
                        : "数据只保存在当前设备，请定期导出一份独立备份。"}
                  </p>
                </div>
              </div>
              <div className="data-stats">
                <span>
                  <b>{data.tasks.filter((t) => !t.deletedAt).length}</b>条任务
                </span>
                <span>
                  <b>{data.lists.filter((l) => l.id !== "inbox").length}</b>
                  个清单
                </span>
                <span>
                  <b>{data.habits.length}</b>个习惯
                </span>
              </div>
              <div className="backup-actions">
                <button onClick={onExport}>
                  <Download size={19} />
                  <span>
                    <strong>导出备份</strong>
                    <small>保存全部任务、习惯和设置</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
                <button onClick={onImport}>
                  <Upload size={19} />
                  <span>
                    <strong>导入数据</strong>
                    <small>支持 DitaList JSON、滴答清单 CSV</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
                {info?.kind === "desktop" && (
                  <button onClick={onReveal}>
                    <Folder size={19} />
                    <span>
                      <strong>打开数据文件夹</strong>
                      <small>查看本地文件与自动备份</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                )}
              </div>
              <p className="data-location">{info?.path}</p>
              <p className="setting-caption">
                不同设备各自保存数据。需要迁移时，在原设备导出备份，再到另一台设备导入。请保留一份独立备份。
              </p>
            </>
          )}
          {tab === "agent" && <McpSettings snapshot={snapshot} onCommand={onCommand}/>}
        </div>
      </div>
    </div>
  );
}

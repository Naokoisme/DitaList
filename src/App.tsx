import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  AgentDocumentInfo,
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
  completeTask,
  createTask,
  importBackupText,
  localDate,
  parseQuickInput,
  validateData,
} from "./core/domain";
import { exportData, loadData, saveData } from "./core/storage";
import CalendarView from "./components/CalendarView";
import { FocusView, HabitsView, MatrixView } from "./components/Tools";
import "./calendar.css";

const labels: Record<string, string> = {
  today: "今天",
  next7: "最近7天",
  inbox: "收集箱",
  all: "所有任务",
  calendar: "日历",
  completed: "已完成",
  trash: "垃圾桶",
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
  const [data, setData] = useState<AppData | null>(null);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<ViewId>("today");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState(localDate);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [calendarKey, setCalendarKey] = useState(0);
  const [toast, setToast] = useState("");
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">(
    "saved",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState("");
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
  const [completedOpen, setCompletedOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [agentReviewOpen, setAgentReviewOpen] = useState(false);
  const [dragOverNav, setDragOverNav] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  const latestData = useRef<AppData | null>(null);
  const saveRevision = useRef(0);
  const reviewedAgentIds = useRef(new Set<string>());
  latestData.current = data;
  const [boot, setBoot] = useState(0);

  useEffect(() => {
    let canceled = false;
    loadData()
      .then((result) => {
        if (canceled) return;
        setData(result.data);
        setInfo(result.info);
        setView(result.data.settings.defaultView);
        loaded.current = true;
        setLoadError("");
      })
      .catch((e) => {
        if (!canceled) setLoadError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      canceled = true;
    };
  }, [boot]);
  useEffect(() => {
    if (!window.didaLocal?.onExternalData) return;
    return window.didaLocal.onExternalData((payload) => {
      try {
        const next = validateData(payload.data);
        setData(next);
        setSelectedId((id) => (id && next.tasks.some((task) => task.id === id) ? id : null));
        if (payload.reason.startsWith("agent-task-")) setToast("Agent 已更新本机任务");
      } catch (error) {
        setToast(`外部任务更新无效：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }, []);
  useEffect(() => {
    if (!data) return;
    const pending = data.tasks.filter(
      (task) => task.createdBy === "agent" && task.agentStatus === "pending" && !task.deletedAt,
    );
    if (pending.length && pending.some((task) => !reviewedAgentIds.current.has(task.id))) {
      setAgentReviewOpen(true);
      pending.forEach((task) => reviewedAgentIds.current.add(task.id));
    }
  }, [data]);

  useEffect(() => {
    if (!data || !loaded.current) return;
    const revision = ++saveRevision.current;
    setSaveStatus("saving");
    saveData(data)
      .then(() => {
        if (revision === saveRevision.current) setSaveStatus("saved");
      })
      .catch((e) => {
        if (revision === saveRevision.current) {
          setSaveStatus("error");
          setToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        }
      });
  }, [data]);

  useEffect(() => {
    const clearDrag = () => {
      setDraggingTaskId(null);
      setDragOverNav(null);
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
  useEffect(() => {
    if (
      info?.kind !== "desktop" ||
      !data?.settings.floatingShortcut ||
      !window.didaLocal?.setFloatingShortcut
    )
      return;
    void window.didaLocal
      .setFloatingShortcut(data.settings.floatingShortcut)
      .then((ok) => {
        if (!ok) setToast("快捷键注册失败，可能与其他程序冲突。");
      });
  }, [data?.settings.floatingShortcut, info?.kind]);
  const update = useCallback(
    (fn: (s: AppData) => AppData) => setData((s) => (s ? fn(s) : s)),
    [],
  );
  const patchTask = useCallback(
    (id: string, patch: Partial<Task>) =>
      update((s) => ({
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, ...patch, updatedAt: stamp() } : t,
        ),
      })),
    [update],
  );
  const approveAgentTasks = useCallback((ids: string[]) => {
    if (!ids.length) return;
    update((s) => ({
      ...s,
      tasks: s.tasks.map((task) =>
        ids.includes(task.id) && task.createdBy === "agent" && task.agentStatus === "pending"
          ? { ...task, agentStatus: "approved", updatedAt: stamp() }
          : task,
      ),
    }));
    setAgentReviewOpen(false);
    setToast(`${ids.length} 条 Agent 任务已确认`);
  }, [update]);

  const toggle = useCallback(
    (id: string) =>
      update((s) => {
        const t = s.tasks.find((x) => x.id === id);
        return t?.completedAt
          ? {
              ...s,
              tasks: s.tasks.map((x) =>
                x.id === id
                  ? { ...x, completedAt: null, updatedAt: stamp() }
                  : x,
              ),
            }
          : completeTask(s, id);
      }),
    [update],
  );
  const go = useCallback((next: ViewId) => {
    setView(next);
    setSelectedId(null);
    setSidebarOpen(false);
    setContext(null);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCreateDialog(null);
        setDateTask(null);
        setSearchOpen(false);
        setSettingsOpen(false);
        setListDialog(null);
        setTagDialog(null);
        setContext(null);
        setSelectedId(null);
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
          setCreateDialog({ date: localDate() });
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
  }, [go]);
  const reminded = useRef(new Set<string>());
  useEffect(() => {
    if (
      !data?.settings.notifications ||
      !window.didaLocal ||
      info?.kind === "android"
    )
      return;
    const offsets: Record<Reminder, number> = {
      none: 0,
      "at-time": 0,
      "5m": 5,
      "15m": 15,
      "30m": 30,
      "1h": 60,
      "1d": 1440,
    };
    const tick = () => {
      const current = latestData.current;
      if (!current) return;
      for (const task of current.tasks) {
        if (
          task.deletedAt ||
          task.completedAt ||
          !task.dueDate ||
          !task.time ||
          task.reminder === "none"
        )
          continue;
        const when =
          new Date(`${task.dueDate}T${task.time}:00`).getTime() -
          offsets[task.reminder] * 60000;
        const key = `${task.id}:${when}`;
        if (
          Date.now() >= when &&
          Date.now() - when < 60000 &&
          !reminded.current.has(key)
        ) {
          reminded.current.add(key);
          void window.didaLocal?.notify(
            task.title,
            `${dateText(task.dueDate)} ${task.time}`,
          );
        }
      }
    };
    tick();
    const t = setInterval(tick, 10000);
    return () => clearInterval(t);
  }, [data?.settings.notifications, info?.kind]);

  const selected = data?.tasks.find((t) => t.id === selectedId) || null;
  const active =
    data?.tasks.filter((t) => !t.deletedAt && !t.completedAt) || [];
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
  const visibleTasks = useMemo(() => {
    if (!data) return [];
    let tasks = data.tasks.filter((t) =>
      view === "trash" ? !!t.deletedAt : !t.deletedAt,
    );
    const today = localDate();
    if (view === "completed") tasks = tasks.filter((t) => !!t.completedAt);
    else if (view === "today")
      tasks = tasks.filter((t) => !!t.dueDate && t.dueDate <= today);
    else if (view === "next7")
      tasks = tasks.filter(
        (t) => !!t.dueDate && t.dueDate <= addDays(today, 6),
      );
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
  }, [data, view, sort]);
  const openTasks = visibleTasks.filter(
    (t) => !t.completedAt || view === "trash",
  );
  const doneTasks = visibleTasks.filter((t) => !!t.completedAt);
  const groups = useMemo(() => {
    const tasks = view === "completed" ? doneTasks : openTasks;
    if (!["today", "next7", "all", "completed"].includes(view))
      return [{ label: "", tasks }];
    const result = new Map<string, Task[]>();
    for (const t of tasks) {
      const label =
        view === "completed"
          ? t.completedAt
            ? dateText(localDate(new Date(t.completedAt)))
            : "已完成"
          : t.dueDate && t.dueDate < localDate()
            ? "已过期"
            : t.dueDate
              ? dateText(t.dueDate)
              : "无日期";
      if (!result.has(label)) result.set(label, []);
      result.get(label)!.push(t);
    }
    if (!result.size) result.set(view === "today" ? "今天" : "", []);
    return Array.from(result, ([label, tasks]) => ({ label, tasks }));
  }, [openTasks, doneTasks, view]);

  function addTaskFromInput(
    text: string,
    overrides: Partial<Task> & { defaultDueDate?: string | null } = {},
  ) {
    const { defaultDueDate, ...taskOverrides } = overrides;
    const parsed = parseQuickInput(text, currentListId);
    if (!parsed.title.trim()) return;
    const currentTag = view.startsWith("tag:") ? view.slice(4) : null;
    const t = createTask({
      ...parsed,
      ...(currentTag
        ? { tags: Array.from(new Set([...(parsed.tags || []), currentTag])) }
        : {}),
      listId: currentListId,
      ...(view === "today" && !parsed.dueDate ? { dueDate: localDate() } : {}),
      ...(defaultDueDate !== undefined && !parsed.dueDate
        ? { dueDate: defaultDueDate }
        : {}),
      ...taskOverrides,
    });
    update((s) => ({
      ...s,
      tasks: [
        ...s.tasks,
        {
          ...t,
          sortOrder: Math.max(0, ...s.tasks.map((x) => x.sortOrder)) + 1,
        },
      ],
    }));
    setSelectedId(t.id);
    setQuick("");
    return t.id;
  }
  useEffect(() => {
    if (!data || !window.didaLocal?.onQuickAdd) return;
    return window.didaLocal.onQuickAdd((text) => {
      const list = data.lists.find(
        (item) => item.id === data.settings.floatingDefaultListId,
      );
      const listId = list && !list.archived ? list.id : "inbox";
      if (
        addTaskFromInput(text, {
          listId,
          defaultDueDate: floatingDefaultDueDate(
            data.settings.floatingDefaultDate,
          ),
        })
      )
        setToast("已从悬浮窗添加任务");
    });
  }, [data, currentListId, view]);
  function trashTask(id: string) {
    patchTask(id, { deletedAt: stamp() });
    if (selectedId === id) setSelectedId(null);
    setContext(null);
    setToast("任务已移到垃圾桶，可在垃圾桶恢复。");
  }
  async function importText(text: string) {
    if (!data) return;
    try {
      const result = importBackupText(text, data);
      setData(result.data);
      setToast(
        `已导入 ${result.count} 条任务${result.warnings.length ? "。" + result.warnings.join("；") : ""}`,
      );
    } catch (e) {
      setToast(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function closeWindow() {
    try {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (latestData.current) await saveData(latestData.current);
      window.didaLocal?.windowAction("close");
    } catch (e) {
      setSaveStatus("error");
      setToast("关闭前保存失败，请先导出备份：" + String(e));
    }
  }
  async function doImport() {
    if (window.didaLocal) {
      try {
        const text = await window.didaLocal.importBackup();
        if (text) await importText(text);
      } catch (e) {
        setToast(String(e));
      }
    } else fileRef.current?.click();
  }
  async function doExport() {
    if (!data) return;
    try {
      const ok = await exportData(data);
      if (ok) setToast("备份已导出。");
    } catch (e) {
      setToast(`导出失败：${String(e)}`);
    }
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
    setDragOverNav(null);
    setDraggingTaskId(null);
    if (!taskId) return;
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const today = localDate();
    if (target === "today") {
      patchTask(taskId, { dueDate: today, deletedAt: null });
      setToast("已将任务排入「今天」");
      return;
    }
    if (target === "next7") {
      const nextDate =
        !task.dueDate ||
        task.dueDate <= today ||
        task.dueDate > addDays(today, 6)
          ? addDays(today, 1)
          : task.dueDate;
      patchTask(taskId, { dueDate: nextDate, deletedAt: null });
      setToast(`已将任务排入「最近7天」（${dateText(nextDate)}）`);
      return;
    }
    if (target === "inbox") {
      const clearSchedule =
        (view === "today" || view === "next7") && task.listId === "inbox";
      patchTask(taskId, {
        listId: "inbox",
        deletedAt: null,
        ...(clearSchedule ? { dueDate: null, startDate: null } : {}),
      });
      setToast(
        clearSchedule ? "已移回「收集箱」并清除日期" : "已移至「收集箱」",
      );
      return;
    }
    if (target.startsWith("list:")) {
      const listId = target.slice(5);
      const listName =
        data.lists.find((l) => l.id === listId)?.name || "清单";
      patchTask(taskId, { listId, deletedAt: null });
      setToast(`已移至清单「${listName}」`);
      return;
    }
    if (target.startsWith("tag:")) {
      const tagName = target.slice(4);
      if (!task.tags.includes(tagName)) {
        patchTask(taskId, {
          tags: [...task.tags, tagName],
          deletedAt: null,
        });
      }
      setToast(`已添加标签 #${tagName}`);
      return;
    }
    if (target === "completed") {
      if (!task.completedAt) toggle(taskId);
      setToast("已完成任务");
      return;
    }
    if (target === "trash") {
      trashTask(taskId);
    }
  };

  const hasDropHintTask = Boolean(draggingTaskId || selectedId);

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
    return (
      <div
        key={l.id}
        className="sidebar-list-item"
        onContextMenu={(e) => {
          e.preventDefault();
          setListDialog(l);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (dragOverNav !== navId) setDragOverNav(navId);
        }}
        onDragLeave={() => {
          if (dragOverNav === navId) setDragOverNav(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          handleSidebarDrop(navId, e.dataTransfer.getData("text/dida-task"));
        }}
      >
        <button
          className={`sidebar-item ${view === navId ? "selected" : ""} ${isDropCandidate ? "drop-candidate" : ""} ${dragOverNav === navId ? "drag-over" : ""}`}
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
          e.preventDefault();
          if (dragOverNav !== navId) setDragOverNav(navId);
        }}
        onDragLeave={() => {
          if (dragOverNav === navId) setDragOverNav(null);
        }}
        onDrop={(e) => {
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

  return (
    <div
      className={`app-shell ${selected ? "detail-visible" : ""}`}
      onClick={() => {
        if (context) setContext(null);
      }}
    >
      <nav className="icon-rail" aria-label="主导航">
        <button
          className="local-avatar"
          aria-label="设置"
          title="DitaList · 设置"
          onClick={() => setSettingsOpen(true)}
        >
          <img src="./icon.svg" alt="" />
        </button>
        <div className="rail-primary">
          {(
            [
              { id: "today", icon: SquareCheck, label: "任务" },
              { id: "calendar", icon: CalendarDays, label: "日历" },
              { id: "matrix", icon: LayoutGrid, label: "四象限" },
              { id: "focus", icon: TargetIcon, label: "专注" },
              { id: "habits", icon: CalendarCheck2, label: "习惯" },
            ] as { id: ViewId; icon: LucideIcon; label: string }[]
          ).map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              title={label}
              aria-label={label}
              className={`rail-button ${view === id || (id === "today" && !["calendar", "matrix", "focus", "habits"].includes(view)) ? "active" : ""}`}
              onClick={() => go(id)}
            >
              <Icon size={21} />
            </button>
          ))}
          <button
            className="rail-button"
            title="搜索 Ctrl+K"
            aria-label="搜索"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={22} />
          </button>
          <button
            className="rail-button mobile-settings"
            title="设置"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={20} />
          </button>
        </div>
        <div className="rail-bottom">
          <button
            className={`rail-button save-indicator ${saveStatus}`}
            title={
              saveStatus === "saved"
                ? "已保存到本机"
                : saveStatus === "saving"
                  ? "正在保存到本机"
                  : "本机保存失败"
            }
            aria-label={saveStatus === "saved" ? "已保存到本机" : "保存状态"}
          >
            <ShieldCheck size={20} />
          </button>
          <button
            className="rail-button"
            title="设置"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={20} />
          </button>
          <button
            className="rail-button"
            title="快捷键与帮助"
            aria-label="快捷键与帮助"
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={20} />
          </button>
        </div>
      </nav>
      {info?.kind === "desktop" && (
        <div className="window-drag-bar" aria-hidden="true" />
      )}
      {!["calendar", "matrix", "focus", "habits"].includes(view) && (
        <>
          <aside
            className={`app-sidebar ${sidebarOpen ? "mobile-open" : ""}`}
            aria-label="任务分类"
          >
            <div className="smart-lists">
              {sidebarItem(
                "today",
                "今天",
                CalendarDays,
                active.filter((t) => t.dueDate === localDate()).length,
              )}
              {sidebarItem(
                "next7",
                "最近7天",
                CalendarRange,
                active.filter(
                  (t) =>
                    t.dueDate &&
                    t.dueDate >= localDate() &&
                    t.dueDate <= addDays(localDate(), 6),
                ).length,
              )}
              {sidebarItem(
                "inbox",
                "收集箱",
                Inbox,
                active.filter((t) => t.listId === "inbox").length,
              )}
              {sidebarItem("all", "所有任务", List, active.length)}
            </div>
            <div className="sidebar-divider" />
            <div className="sidebar-scroll">
              <div className="sidebar-section-heading">
                <span>清单</span>
                <div>
                  <button
                    title="新建文件夹"
                    aria-label="新建文件夹"
                    onClick={() => setListDialog("folder")}
                  >
                    <FolderPlus size={14} />
                  </button>
                  <button
                    title="添加清单"
                    aria-label="添加清单"
                    onClick={() => setListDialog("list")}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              {data.lists
                .filter((l) => l.id !== "inbox" && !l.folderId && !l.archived)
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map(listItem)}
              {data.folders.map((f) => (
                <details className="sidebar-folder" key={f.id} open>
                  <summary>
                    <ChevronRight size={12} />
                    <Folder size={16} />
                    <span>{f.name}</span>
                  </summary>
                  {data.lists
                    .filter((l) => l.folderId === f.id && !l.archived)
                    .map(listItem)}
                </details>
              ))}
              {data.lists.filter((l) => l.id !== "inbox" && !l.archived)
                .length === 0 && (
                <button
                  className="sidebar-empty-add"
                  onClick={() => setListDialog("list")}
                >
                  <Plus size={13} />
                  添加你的第一个清单
                </button>
              )}
              <div className="sidebar-section-heading tag-heading">
                <span>标签</span>
                <button
                  title="添加标签"
                  aria-label="新建标签"
                  onClick={() => setTagDialog({ mode: "create", name: "" })}
                >
                  <Plus size={14} />
                </button>
              </div>
              {tags.map(tagItem)}
              {!tags.length && (
                <button
                  className="sidebar-empty-add"
                  onClick={() => setTagDialog({ mode: "create", name: "" })}
                >
                  <Plus size={13} />
                  添加你的第一个标签
                </button>
              )}
              <div className="sidebar-section-heading">
                <span>过滤器</span>
                <button
                  title="添加过滤器"
                  aria-label="添加过滤器"
                  onClick={() => setFilterDialog(true)}
                >
                  <Plus size={14} />
                </button>
              </div>
              {data.filters.map((f) =>
                sidebarItem(`filter:${f.id}`, f.name, ListFilter),
              )}
              {!data.filters.length && (
                <p className="sidebar-hint">
                  按日期、优先级和标签，
                  <br />
                  快速找到你关心的任务。
                </p>
              )}
            </div>
            <div className="sidebar-lower">
              <div className="sidebar-divider" />
              {sidebarItem("completed", "已完成", SquareCheck)}
              {sidebarItem(
                "trash",
                "垃圾桶",
                Trash2,
                data.tasks.filter((t) => t.deletedAt).length,
              )}
              <div className="sidebar-local-note">
                <span
                  className={`status-dot ${saveStatus === "error" ? "error" : ""}`}
                />
                {saveStatus === "saved"
                  ? "仅本机 · 已保存"
                  : saveStatus === "saving"
                    ? "正在保存…"
                    : "保存失败，请检查"}
              </div>
            </div>
          </aside>
          {sidebarOpen && (
            <div
              className="sidebar-scrim"
              onClick={() => setSidebarOpen(false)}
            />
          )}
        </>
      )}

      <main
        className={`main-content ${["calendar", "matrix", "focus", "habits"].includes(view) ? "full-view" : ""}`}
      >
        <div className={view === "focus" ? "persistent-focus" : "hidden"}>
          <FocusView data={data} onUpdate={update} />
        </div>
        {view === "calendar" ? (
          <CalendarView
            key={calendarKey}
            data={data}
            anchor={anchor}
            mode={data.settings.calendarMode}
            onAnchorChange={setAnchor}
            onModeChange={(mode) =>
              update((s) => ({
                ...s,
                settings: { ...s.settings, calendarMode: mode },
              }))
            }
            onSelectTask={setSelectedId}
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
            onUpdate={update}
          />
        ) : view === "focus" ? null : view === "habits" ? (
          <HabitsView data={data} onUpdate={update} />
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
                <IconButton
                  label="添加任务 Ctrl+N"
                  onClick={() =>
                    setCreateDialog({
                      date: view === "today" ? localDate() : null,
                    })
                  }
                >
                  <Plus size={20} />
                </IconButton>
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
                <IconButton
                  label={
                    data.settings.showCompleted ? "隐藏已完成" : "显示已完成"
                  }
                  onClick={() =>
                    update((s) => ({
                      ...s,
                      settings: {
                        ...s.settings,
                        showCompleted: !s.settings.showCompleted,
                      },
                    }))
                  }
                >
                  <MoreHorizontal size={21} />
                </IconButton>
              </div>
            </header>
            {!["trash", "completed"].includes(view) && (
              <form
                className="quick-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  addTaskFromInput(quick);
                }}
              >
                <Plus size={18} />
                <input
                  ref={quickRef}
                  aria-label="添加任务"
                  placeholder="添加任务，回车即可保存"
                  value={quick}
                  onChange={(e) => setQuick(e.target.value)}
                />
                {quick && (
                  <button type="submit" className="quick-save">
                    添加
                  </button>
                )}
              </form>
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
                      {view !== "completed" && (
                        <IconButton
                          label={`在${group.label}添加任务`}
                          onClick={() =>
                            setCreateDialog({
                              date: view === "today" ? localDate() : null,
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
                        update((s) => {
                          const tasks = s.tasks.slice();
                          const moving = tasks.find((x) => x.id === dragId);
                          if (!moving) return s;
                          const inView = visibleTasks
                            .map((x) => x.id)
                            .filter((id) => id !== dragId);
                          inView.splice(inView.indexOf(t.id), 0, dragId);
                          return {
                            ...s,
                            tasks: tasks.map((x) =>
                              inView.includes(x.id)
                                ? { ...x, sortOrder: inView.indexOf(x.id) }
                                : x,
                            ),
                          };
                        });
                      }}
                    />
                  ))}
                </section>
              ))}
              {!openTasks.length &&
                view !== "completed" &&
                view !== "trash" && (
                  <div className="list-empty">
                    <div className="empty-line-art">
                      <CheckCheck size={56} strokeWidth={1.1} />
                      <span />
                    </div>
                    <h2>
                      {view === "today"
                        ? "今天，轻松一点"
                        : view === "inbox"
                          ? "把想做的事收集在这里"
                          : "暂时没有任务"}
                    </h2>
                    <p>
                      {view === "today"
                        ? "安排好每一件小事，留一点时间给自己。"
                        : "在上方添加任务，或者点击 + 开始。"}
                    </p>
                  </div>
                )}
              {view === "trash" &&
                (!visibleTasks.length ? (
                  <div className="list-empty">
                    <Trash2 size={42} strokeWidth={1.1} />
                    <h2>垃圾桶是空的</h2>
                    <p>删除的任务可以在这里恢复。</p>
                  </div>
                ) : (
                  <div className="trash-actions">
                    <button
                      className="text-button"
                      onClick={() => {
                        update((s) => ({
                          ...s,
                          tasks: s.tasks.map((t) =>
                            t.deletedAt
                              ? { ...t, deletedAt: null, updatedAt: stamp() }
                              : t,
                          ),
                        }));
                        setToast("已恢复垃圾桶中的任务。");
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
                  <h2>每一步都值得记录</h2>
                  <p>已完成的任务会保留在这里。</p>
                </div>
              )}
              {!["completed", "trash"].includes(view) &&
                doneTasks.length > 0 && (
                  <div className="completed-section">
                    <button
                      className="completed-heading"
                      onClick={() => setCompletedOpen((v) => !v)}
                    >
                      {completedOpen || data.settings.showCompleted ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                      <span>已完成</span>
                      <small>{doneTasks.length}</small>
                    </button>
                    {(completedOpen || data.settings.showCompleted) &&
                      doneTasks.map((t) => (
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
      {selected && (
        <TaskDetail
          task={selected}
          data={data}
          onPatch={(patch) => patchTask(selected.id, patch)}
          onToggle={() => toggle(selected.id)}
          onClose={() => setSelectedId(null)}
          onDate={() => setDateTask(selected)}
          onTrash={() => trashTask(selected.id)}
          onRestore={() => patchTask(selected.id, { deletedAt: null })}
          onNewList={() => setListDialog("list")}
          onToast={setToast}
        />
      )}

      {context && (
        <div
          className="context-menu popover"
          style={{ left: context.x, top: context.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const task = data.tasks.find((t) => t.id === context.id)!;
            return (
              <>
                <button
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
                    const copy = createTask({
                      ...task,
                      id: crypto.randomUUID(),
                      title: task.title + "（副本）",
                      completedAt: null,
                      deletedAt: null,
                      recurrenceId: undefined,
                      createdAt: stamp(),
                      updatedAt: stamp(),
                      subtasks: task.subtasks.map((s) => ({
                        ...s,
                        id: crypto.randomUUID(),
                      })),
                    });
                    update((s) => ({ ...s, tasks: [...s.tasks, copy] }));
                    setContext(null);
                  }}
                >
                  <Copy size={15} />
                  复制任务
                </button>
                <div className="menu-divider" />
                {task.deletedAt ? (
                  <button
                    onClick={() => {
                      patchTask(task.id, { deletedAt: null });
                      setContext(null);
                    }}
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
          onCreate={(input) => {
            addTaskFromInput(input.title, input);
            setCreateDialog(null);
          }}
        />
      )}
      {dateTask && (
        <DateDialog
          task={dateTask}
          onClose={() => setDateTask(null)}
          onSave={(patch) => {
            patchTask(dateTask.id, patch);
            setDateTask(null);
          }}
        />
      )}
      {listDialog && (
        <ListDialog
          value={listDialog}
          data={data}
          onClose={() => setListDialog(null)}
          onSave={(name, color, folderId) => {
            if (listDialog === "folder")
              update((s) => ({
                ...s,
                folders: [
                  ...s.folders,
                  {
                    id: crypto.randomUUID(),
                    name,
                    sortOrder: s.folders.length,
                  },
                ],
              }));
            else if (listDialog === "list") {
              const id = crypto.randomUUID();
              update((s) => ({
                ...s,
                lists: [
                  ...s.lists,
                  {
                    id,
                    name,
                    color,
                    folderId,
                    archived: false,
                    sortOrder: s.lists.length,
                  },
                ],
              }));
              go(`list:${id}`);
            } else
              update((s) => ({
                ...s,
                lists: s.lists.map((l) =>
                  l.id === listDialog.id ? { ...l, name, color, folderId } : l,
                ),
              }));
            setListDialog(null);
          }}
          onArchive={
            typeof listDialog === "object"
              ? () => {
                  const id = listDialog.id;
                  update((s) => ({
                    ...s,
                    lists: s.lists.map((l) =>
                      l.id === id ? { ...l, archived: true } : l,
                    ),
                  }));
                  setListDialog(null);
                  go("all");
                }
              : undefined
          }
        />
      )}
      {tagDialog && (
        <TagDialog
          mode={tagDialog.mode}
          initialName={tagDialog.name}
          onClose={() => setTagDialog(null)}
          onSave={(rawName) => {
            const cleanName = rawName.trim().replace(/^#+/, "").trim();
            if (!cleanName) return;
            if (tagDialog.mode === "create") {
              update((s) => ({
                ...s,
                settings: {
                  ...s.settings,
                  customTags: Array.from(
                    new Set([...(s.settings.customTags || []), cleanName]),
                  ),
                },
              }));
              setTagDialog(null);
              go(`tag:${cleanName}`);
              setToast(`已添加标签 #${cleanName}`);
            } else {
              const oldName = tagDialog.name;
              const now = stamp();
              update((s) => ({
                ...s,
                settings: {
                  ...s.settings,
                  customTags: Array.from(
                    new Set(
                      (s.settings.customTags || []).map((t) =>
                        t === oldName ? cleanName : t,
                      ),
                    ),
                  ),
                },
                tasks: s.tasks.map((task) =>
                  task.tags.includes(oldName)
                    ? {
                        ...task,
                        tags: Array.from(
                          new Set(
                            task.tags.map((t) =>
                              t === oldName ? cleanName : t,
                            ),
                          ),
                        ),
                        updatedAt: now,
                      }
                    : task,
                ),
              }));
              setTagDialog(null);
              if (view === `tag:${oldName}`) go(`tag:${cleanName}`);
              setToast(`已将标签重命名为 #${cleanName}`);
            }
          }}
          onDelete={
            tagDialog.mode === "edit"
              ? () => {
                  const oldName = tagDialog.name;
                  const now = stamp();
                  update((s) => ({
                    ...s,
                    settings: {
                      ...s.settings,
                      customTags: (s.settings.customTags || []).filter(
                        (t) => t !== oldName,
                      ),
                    },
                    tasks: s.tasks.map((task) =>
                      task.tags.includes(oldName)
                        ? {
                            ...task,
                            tags: task.tags.filter((t) => t !== oldName),
                            updatedAt: now,
                          }
                        : task,
                    ),
                  }));
                  setTagDialog(null);
                  if (view === `tag:${oldName}`) go("all");
                  setToast(`已删除标签 #${oldName}`);
                }
              : undefined
          }
        />
      )}
      {filterDialog && (
        <FilterDialog
          onClose={() => setFilterDialog(false)}
          onSave={(name, query) => {
            const id = crypto.randomUUID();
            update((s) => ({
              ...s,
              filters: [
                ...s.filters,
                { id, name, query, color: s.settings.accent },
              ],
            }));
            setFilterDialog(false);
            go(`filter:${id}`);
          }}
        />
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
                  .filter((t) => !t.deletedAt && matchesQuery(t, search))
                  .slice(0, 100)
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
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
                  (t) => !t.deletedAt && matchesQuery(t, search),
                ) && <p>没有找到相关任务</p>}
            </div>
          </div>
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog
          data={data}
          info={info}
          onClose={() => setSettingsOpen(false)}
          onChange={(settings) =>
            update((s) => ({ ...s, settings: { ...s.settings, ...settings } }))
          }
          onExport={doExport}
          onImport={doImport}
          onReveal={() => void window.didaLocal?.revealData()}
          onToast={setToast}
          onUnarchive={(id) =>
            update((s) => ({
              ...s,
              lists: s.lists.map((l) =>
                l.id === id ? { ...l, archived: false } : l,
              ),
            }))
          }
        />
      )}
      {agentReviewOpen &&
        data &&
        data.tasks.some(
          (task) =>
            task.createdBy === "agent" &&
            task.agentStatus === "pending" &&
            !task.deletedAt,
        ) && (
          <AgentReviewDialog
            tasks={data.tasks.filter(
              (task) =>
                task.createdBy === "agent" &&
                task.agentStatus === "pending" &&
                !task.deletedAt,
            )}
            lists={data.lists}
            onClose={() => setAgentReviewOpen(false)}
            onApprove={approveAgentTasks}
            onReject={(ids) => {
              const now = stamp();
              update((s) => ({
                ...s,
                tasks: s.tasks.map((t) =>
                  ids.includes(t.id) ? { ...t, deletedAt: now, updatedAt: now } : t,
                ),
              }));
              setToast(`已移除 ${ids.length} 条待确认任务`);
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
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {info?.kind === "desktop" && (
        <div className="window-controls">
          <button
            type="button"
            aria-label="最小化"
            title="最小化"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              window.didaLocal?.windowAction("minimize");
            }}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            aria-label="最大化或还原"
            title="最大化或还原"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              window.didaLocal?.windowAction("maximize");
            }}
          >
            <Square size={11} />
          </button>
          <button
            type="button"
            className="close-window"
            aria-label="关闭窗口"
            title="关闭窗口"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
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

function AgentReviewDialog({
  tasks,
  lists,
  onClose,
  onApprove,
  onReject,
}: {
  tasks: Task[];
  lists: TaskList[];
  onClose: () => void;
  onApprove: (ids: string[]) => void;
  onReject: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState(
    () => new Set(tasks.map((task) => task.id)),
  );
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const task of tasks) {
        if (!next.has(task.id)) next.add(task.id);
      }
      return next;
    });
  }, [tasks]);
  const selectedIds = tasks
    .filter((task) => selected.has(task.id))
    .map((task) => task.id);
  const allSelected = selectedIds.length === tasks.length && tasks.length > 0;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog agent-review-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <div className="agent-review-header-title">
            <h2>
              <Bot size={18} />
              <span>Agent 任务确认</span>
              <span className="agent-review-count">{tasks.length}</span>
            </h2>
            <p className="agent-review-note">
              Agent 已规划以下待办任务，确认后将正式加入你的清单。
            </p>
          </div>
          <IconButton label="关闭确认" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="agent-review-list">
          {tasks.map((task) => {
            const checked = selected.has(task.id);
            const list = lists.find((l) => l.id === task.listId);
            return (
              <div
                className={`agent-review-item ${checked ? "is-checked" : ""}`}
                key={task.id}
                onClick={() => toggle(task.id)}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={`选择 ${task.title}`}
                  className={`task-check p${task.priority} ${checked ? "checked" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(task.id);
                  }}
                >
                  {checked && <Check size={12} />}
                </button>
                <div className="agent-review-body">
                  <div className="agent-review-title-row">
                    <strong>{task.title}</strong>
                    {list && (
                      <span
                        className="agent-review-list-badge"
                        style={{ color: list.color }}
                      >
                        {list.name}
                      </span>
                    )}
                    {task.dueDate && (
                      <span className="agent-review-date-badge">
                        <CalendarDays size={11} />
                        {dateText(task.dueDate)}
                        {task.time ? ` ${task.time}` : ""}
                      </span>
                    )}
                  </div>
                  {task.content && (
                    <p className="agent-review-desc">{task.content}</p>
                  )}
                  {task.tags.length > 0 && (
                    <div className="agent-review-tags">
                      {task.tags.map((t) => (
                        <span key={t}>#{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div
                  className="agent-review-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="agent-review-approve"
                    onClick={() => onApprove([task.id])}
                    title="单独确认此任务"
                    aria-label={`确认 ${task.title}`}
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    className="agent-review-reject"
                    onClick={() => onReject([task.id])}
                    title="移入垃圾桶"
                    aria-label={`移除 ${task.title}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setSelected(
                allSelected ? new Set() : new Set(tasks.map((task) => task.id)),
              )
            }
          >
            {allSelected ? "取消全选" : "全选"}
          </button>
          <button type="button" className="text-button" onClick={onClose}>
            稍后处理
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!selectedIds.length}
            onClick={() => onApprove(selectedIds)}
          >
            <Check size={15} />
            确认选中 ({selectedIds.length})
          </button>
        </div>
      </div>
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
          onToggle();
        }
      }}
      data-task-id={task.id}
    >
      <button
        className={`task-check p${task.priority} ${task.completedAt ? "checked" : ""}`}
        aria-label={`${task.completedAt ? "取消完成" : "完成"} ${task.title}`}
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
}: {
  task: Task;
  data: AppData;
  onPatch: (patch: Partial<Task>) => void;
  onToggle: () => void;
  onClose: () => void;
  onDate: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onNewList?: () => void;
  onToast?: (message: string) => void;
}) {
  const [subtask, setSubtask] = useState("");
  const [tag, setTag] = useState("");
  const [editedTitle, setEditedTitle] = useState(task.title);
  useEffect(() => setEditedTitle(task.title), [task.id, task.title]);
  return (
    <aside className="task-detail" aria-label="任务详情">
      <header className="detail-toolbar">
        <button
          className={`task-check p${task.priority} ${task.completedAt ? "checked" : ""}`}
          aria-label={task.completedAt ? "取消完成任务" : "完成任务"}
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
            if (e.target.value.trim()) onPatch({ title: e.target.value });
          }}
          onBlur={() => onPatch({ title: editedTitle.trim() || "未命名任务" })}
          rows={Math.min(5, Math.max(1, Math.ceil(task.title.length / 18)))}
        />
        <textarea
          className="detail-description"
          aria-label="任务描述"
          maxLength={2000000}
          placeholder="添加描述"
          value={task.content}
          onChange={(e) => onPatch({ content: e.target.value })}
          rows={Math.max(4, Math.min(14, task.content.split("\n").length + 1))}
        />
        <div className="subtasks">
          {task.subtasks.map((s) => (
            <div className="subtask-row" key={s.id}>
              <button
                className={`task-check ${s.completed ? "checked" : ""}`}
                aria-label={`完成子任务 ${s.title}`}
                onClick={() =>
                  onPatch({
                    subtasks: task.subtasks.map((x) =>
                      x.id === s.id ? { ...x, completed: !x.completed } : x,
                    ),
                  })
                }
              >
                {s.completed && <Check size={11} />}
              </button>
              <input
                className={s.completed ? "completed" : ""}
                aria-label="子任务标题"
                maxLength={10000}
                value={s.title}
                onChange={(e) =>
                  onPatch({
                    subtasks: task.subtasks.map((x) =>
                      x.id === s.id ? { ...x, title: e.target.value } : x,
                    ),
                  })
                }
              />
              <button
                className="remove-subtask"
                aria-label={`删除子任务 ${s.title}`}
                onClick={() =>
                  onPatch({
                    subtasks: task.subtasks.filter((x) => x.id !== s.id),
                  })
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
              onPatch({
                subtasks: [
                  ...task.subtasks,
                  {
                    id: crypto.randomUUID(),
                    title: subtask.trim(),
                    completed: false,
                  },
                ],
              });
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
          {task.tags.map((t) => (
            <span key={t}>
              #{t}
              <button
                title={`移除标签 ${t}`}
                onClick={() =>
                  onPatch({ tags: task.tags.filter((x) => x !== t) })
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
              if (t && !task.tags.includes(t))
                onPatch({ tags: [...task.tags, t] });
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
            dueDate={task.dueDate}
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

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

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
        <div
          className={`custom-select-popover ${alignRight ? "align-right" : ""} ${popUp ? "pop-up" : ""}`}
          role="listbox"
          onMouseDown={(e) => e.stopPropagation()}
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
        </div>
      )}
    </div>
  );
}

function TaskDestinationSelect({
  listId,
  dueDate,
  lists,
  ariaLabel,
  popUp = false,
  onChange,
  onNewList,
}: {
  listId: string;
  dueDate: string | null;
  lists: TaskList[];
  ariaLabel: string;
  popUp?: boolean;
  onChange: (
    patch: { listId?: string; dueDate?: string | null },
    notice?: string,
  ) => void;
  onNewList?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const today = localDate();
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(today, 7);
  const availableLists = lists.filter((l) => !l.archived);
  const currentList =
    availableLists.find((l) => l.id === listId) ||
    lists.find((l) => l.id === listId) ||
    availableLists[0];

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const scheduleTag =
    dueDate === today
      ? "今天"
      : dueDate === tomorrow
        ? "明天"
        : dueDate && dueDate > tomorrow && dueDate <= addDays(today, 6)
          ? "最近7天"
          : dueDate
            ? dateText(dueDate)
            : "";

  return (
    <div
      className="custom-select destination-select"
      ref={wrapperRef}
    >
      <select
        className="sr-only-select"
        aria-label={ariaLabel}
        tabIndex={-1}
        value={listId}
        onChange={(e) => onChange({ listId: e.target.value })}
      >
        {availableLists.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="custom-select-trigger destination-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <i
          className="custom-select-dot"
          style={{ background: currentList?.color || "#4772fa" }}
        />
        <span className="destination-trigger-text">
          {currentList?.name || "收集箱"}
          {scheduleTag && <small> · {scheduleTag}</small>}
        </span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          className={`custom-select-popover destination-popover ${popUp ? "pop-up" : ""}`}
          role="listbox"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="destination-group-title">快捷排入（智能视图）</div>
          <button
            type="button"
            className={`custom-select-option ${dueDate === today ? "is-selected" : ""}`}
            onClick={() => {
              onChange({ dueDate: today }, "已排入「今天」");
              setOpen(false);
            }}
          >
            <span className="custom-select-option-label">
              <CalendarDays size={14} />
              今天
            </span>
            {dueDate === today && <Check size={13} />}
          </button>
          <button
            type="button"
            className={`custom-select-option ${dueDate === tomorrow ? "is-selected" : ""}`}
            onClick={() => {
              onChange({ dueDate: tomorrow }, "已排入「最近7天」（明天）");
              setOpen(false);
            }}
          >
            <span className="custom-select-option-label">
              <CalendarRange size={14} />
              明天 · 最近7天
            </span>
            {dueDate === tomorrow && <Check size={13} />}
          </button>
          <button
            type="button"
            className={`custom-select-option ${dueDate === nextWeek ? "is-selected" : ""}`}
            onClick={() => {
              onChange({ dueDate: nextWeek }, "已排入下周");
              setOpen(false);
            }}
          >
            <span className="custom-select-option-label">
              <CalendarCheck2 size={14} />
              下周（+7天）
            </span>
            {dueDate === nextWeek && <Check size={13} />}
          </button>
          <button
            type="button"
            className={`custom-select-option ${!dueDate ? "is-selected" : ""}`}
            onClick={() => {
              onChange({ dueDate: null, listId: "inbox" }, "已移回「收集箱」（无日期）");
              setOpen(false);
            }}
          >
            <span className="custom-select-option-label">
              <Inbox size={14} />
              仅收集箱（不设日期）
            </span>
            {!dueDate && listId === "inbox" && <Check size={13} />}
          </button>
          <div className="destination-divider" />
          <div className="destination-group-title">所属清单</div>
          {availableLists.map((l) => (
            <button
              type="button"
              key={l.id}
              className={`custom-select-option ${l.id === listId ? "is-selected" : ""}`}
              onClick={() => {
                onChange({ listId: l.id }, `已归入清单「${l.name}」`);
                setOpen(false);
              }}
            >
              <span className="custom-select-option-label">
                <i
                  className="custom-select-dot"
                  style={{ background: l.color }}
                />
                {l.name}
              </span>
              {l.id === listId && <Check size={13} />}
            </button>
          ))}
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
        </div>
      )}
    </div>
  );
}

function CustomDateInput({
  value,
  onChange,
  ariaLabel,
  placeholder = "选择日期",
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const today = localDate();
  const initial = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today;
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => `${initial.slice(0, 7)}-01`);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      setViewMonth(`${value.slice(0, 7)}-01`);
    }
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const [y, m] = viewMonth.split("-").map(Number);
  const firstOfMonth = new Date(y, m - 1, 1, 12);
  const offset = (firstOfMonth.getDay() + 6) % 7;
  const startCell = addDays(viewMonth, -offset);
  const days = Array.from({ length: 42 }, (_, idx) => addDays(startCell, idx));
  const shiftMonth = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1, 12);
    setViewMonth(localDate(d));
  };

  return (
    <div className="custom-picker" ref={wrapperRef}>
      <input
        type="text"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && (
        <div
          className="custom-picker-popover custom-date-popover"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="custom-picker-header">
            <button
              type="button"
              className="icon-button"
              aria-label="上个月"
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft size={15} />
            </button>
            <strong>
              {y}年{m}月
            </strong>
            <button
              type="button"
              className="icon-button"
              aria-label="下个月"
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="custom-picker-weekdays">
            {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="custom-picker-days">
            {days.map((d) => {
              const dayNum = Number(d.slice(8, 10));
              const inMonth = Number(d.slice(5, 7)) === m;
              const isSelected = d === value;
              const isToday = d === today;
              return (
                <button
                  type="button"
                  key={d}
                  className={`custom-day-cell ${inMonth ? "" : "is-outside"} ${isSelected ? "is-selected" : ""} ${isToday ? "is-today" : ""}`}
                  onClick={() => {
                    onChange(d);
                    setOpen(false);
                  }}
                >
                  {dayNum}
                </button>
              );
            })}
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
                onChange(today);
                setOpen(false);
              }}
            >
              今天
            </button>
          </div>
        </div>
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

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="custom-picker" ref={wrapperRef}>
      <input
        type="text"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && (
        <div
          className={`custom-picker-popover custom-time-popover ${alignRight ? "align-right" : ""}`}
          onMouseDown={(e) => e.stopPropagation()}
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
        </div>
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
  onCreate: (task: Partial<Task> & { title: string }) => void;
  onNewList?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [due, setDue] = useState(endDate || date || "");
  const [list, setList] = useState(defaultList);
  const [priority, setPriority] = useState<Priority>(0);
  const [time, setTime] = useState(defaultTime || "");
  const [error, setError] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="dialog new-task-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          const parsed = parseQuickInput(title, list);
          if (!parsed.title.trim()) {
            setError("请输入任务标题。");
            return;
          }
          if (endDate && date && due && date > due) {
            setError("结束日期不能早于开始日期。");
            return;
          }
          try {
            onCreate({
              ...parsed,
              title: parsed.title,
              content,
              listId: list,
              dueDate: due || parsed.dueDate || null,
              startDate: endDate ? date : null,
              time: time || parsed.time || null,
              priority: priority || parsed.priority || 0,
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        <div className="dialog-header">
          <h2>添加任务</h2>
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
              value={due}
              ariaLabel="新任务日期"
              onChange={setDue}
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
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <TaskDestinationSelect
            listId={list}
            dueDate={due || null}
            lists={data.lists}
            ariaLabel="新任务所属清单"
            onNewList={onNewList}
            onChange={(patch) => {
              if (patch.listId !== undefined) setList(patch.listId);
              if (patch.dueDate !== undefined) setDue(patch.dueDate || "");
            }}
          />
          <button className="text-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit">
            添加
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
              ? "新建文件夹"
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
              value === "folder" ? "文件夹名称" : "例如：工作、生活、学习"
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
                  className={color === c ? "selected" : ""}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                >
                  {color === c && <Check size={15} />}
                </button>
              ))}
            </div>
            <div className="field-group">
              <span>所在文件夹</span>
              <CustomSelect
                ariaLabel="所在文件夹"
                value={folderId}
                options={[
                  { value: "", label: "无" },
                  ...data.folders.map((f) => ({ value: f.id, label: f.name })),
                ]}
                onChange={(val) => setFolder(String(val))}
              />
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

const defaultAgentDocTemplate = `# DitaList 本地 Agent / MCP 配置说明

> 本文档保存在 DitaList「设置 → Agent / MCP」中，支持随时查看、复制或稍后配置。
> 你可以将以下说明直接发给 Agent（如 Claude Code、Codex、Cursor 等），让 Agent 自动完成 MCP 配置。

## 1. 给 Agent 的一句话指令

请将 DitaList 本地 MCP 服务添加到你的 MCP 配置中，并通过它帮我读取和规划任务。

## 2. MCP 客户端配置示例

\`\`\`json
{
  "mcpServers": {
    "ditalist": {
      "command": "node",
      "args": ["<DitaList目录>/resources/app/mcp/server.mjs"]
    }
  }
}
\`\`\`

## 3. 可用 MCP 工具与确认机制

- dida_list_list_tasks：查询本机任务（支持关键词 query 与 includeDeleted）
- dida_list_get_task：按任务 ID 读取单条任务
- dida_list_create_task：创建 Agent 待确认任务（在 DitaList 弹窗等待用户单条或批量确认）
- dida_list_update_task：修改任务字段
- dida_list_delete_task：将任务移入垃圾桶（可在垃圾桶恢复）
`;

function SettingsDialog({
  data,
  info,
  onClose,
  onChange,
  onExport,
  onImport,
  onReveal,
  onToast,
  onUnarchive,
}: {
  data: AppData;
  info: StorageInfo | null;
  onClose: () => void;
  onChange: (settings: Partial<AppData["settings"]>) => void;
  onExport: () => void;
  onImport: () => void;
  onReveal: () => void;
  onToast?: (message: string) => void;
  onUnarchive: (id: string) => void;
}) {
  const [tab, setTab] = useState("general");
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [desktopShortcutStatus, setDesktopShortcutStatus] = useState<
    "checking" | "missing" | "exists" | "error"
  >("checking");
  const [agentDoc, setAgentDoc] = useState<AgentDocumentInfo | null>(null);
  const [copiedAgentDoc, setCopiedAgentDoc] = useState(false);
  const [agentNotice, setAgentNotice] = useState(
    "你可以现在复制配置说明发给 Agent，也可以稍后配置；说明文案会一直保留在这里。",
  );
  useEffect(() => {
    if (info?.kind !== "desktop" || !window.didaLocal?.getDesktopShortcut) {
      setDesktopShortcutStatus("missing");
      return;
    }
    void window.didaLocal
      .getDesktopShortcut()
      .then((exists) => setDesktopShortcutStatus(exists ? "exists" : "missing"))
      .catch(() => setDesktopShortcutStatus("error"));
  }, [info?.kind]);
  useEffect(() => {
    if (info?.kind !== "desktop" || !window.didaLocal?.generateAgentDocument)
      return;
    void window.didaLocal
      .generateAgentDocument()
      .then((doc) => setAgentDoc(doc))
      .catch((error) =>
        setAgentNotice(
          `生成 Agent 说明文档失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }, [info?.kind]);

  async function refreshAgentDoc() {
    if (!window.didaLocal?.generateAgentDocument) return;
    try {
      const doc = await window.didaLocal.generateAgentDocument();
      setAgentDoc(doc);
      setAgentNotice(`已生成最新说明文档：${doc.path}`);
      onToast?.("已更新本地 Agent 配置说明文档");
    } catch (error) {
      setAgentNotice(
        `生成失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function copyAgentDoc() {
    try {
      if (window.didaLocal?.copyAgentDocument) {
        const result = await window.didaLocal.copyAgentDocument();
        if (!agentDoc && window.didaLocal.generateAgentDocument) {
          setAgentDoc(await window.didaLocal.generateAgentDocument());
        }
        setAgentNotice(`已复制完整配置说明（文档位置：${result.path}）`);
      } else {
        await navigator.clipboard.writeText(
          agentDoc?.content || defaultAgentDocTemplate,
        );
        setAgentNotice("已复制 Agent 配置说明到剪贴板。");
      }
      setCopiedAgentDoc(true);
      setTimeout(() => setCopiedAgentDoc(false), 2000);
      onToast?.("已复制 Agent 配置说明，可直接发给 Agent");
    } catch (error) {
      setAgentNotice(
        `复制失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function openAgentDocDir() {
    if (!window.didaLocal?.openAgentDocumentDirectory) return;
    try {
      await window.didaLocal.openAgentDocumentDirectory();
    } catch (error) {
      setAgentNotice(
        `打开目录失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function deferAgentSetup() {
    setAgentNotice(
      "已选择稍后配置。本页说明与本地 DitaList-Agent.md 会一直保留，随时可回来复制给 Agent。",
    );
    onToast?.("可随时在「设置 → Agent / MCP」中查看或复制 Agent 配置说明");
  }

  async function createDesktopShortcut() {
    try {
      await window.didaLocal?.createDesktopShortcut();
      setDesktopShortcutStatus("exists");
    } catch {
      setDesktopShortcutStatus("error");
    }
  }

  async function removeDesktopShortcut() {
    try {
      await window.didaLocal?.removeDesktopShortcut();
      setDesktopShortcutStatus("missing");
    } catch {
      setDesktopShortcutStatus("error");
    }
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
                <span>显示已完成任务</span>
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
              <div className="setting-subheading">桌面悬浮窗</div>
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
                单击右下角托盘图标或按快捷键打开悬浮窗。输入中的日期和时间会覆盖默认日期。
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
                    style={{ background: c }}
                    className={data.settings.accent === c ? "selected" : ""}
                    onClick={() => onChange({ accent: c })}
                  >
                    {data.settings.accent === c && <Check size={16} />}
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
              <div className="data-status">
                <ShieldCheck size={23} />
                <div>
                  <strong>数据保存在当前设备</strong>
                  <p>无需账号，不连接滴答清单服务器。</p>
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
          {tab === "agent" && (
            <>
              <div className="data-status">
                <Bot size={23} />
                <div>
                  <strong>把链接或说明交给 Agent 即可完成配置</strong>
                  <p>{agentNotice}</p>
                </div>
              </div>
              <div className="agent-url-box">
                <div className="agent-url-info">
                  <span>MCP 插件链接（Streamable HTTP）</span>
                  <code>
                    {agentDoc?.httpUrl || "http://127.0.0.1:27182/mcp"}
                  </code>
                </div>
                <button
                  type="button"
                  className="agent-doc-copy-btn"
                  onClick={() => {
                    const url =
                      agentDoc?.httpUrl || "http://127.0.0.1:27182/mcp";
                    void navigator.clipboard.writeText(url);
                    setAgentNotice(`已复制 MCP 插件链接：${url}`);
                    onToast?.("已复制 MCP 插件链接，可直接填入 Agent 框架");
                  }}
                >
                  <Copy size={14} />
                  <span>复制链接</span>
                </button>
              </div>
              <div className="backup-actions">
                <button onClick={() => void copyAgentDoc()}>
                  <Copy size={19} />
                  <span>
                    <strong>复制给 Agent 的配置说明</strong>
                    <small>
                      一键复制完整 MCP 配置与工具说明，直接粘贴给 Agent 即可
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
                {info?.kind === "desktop" && (
                  <>
                    <button onClick={() => void refreshAgentDoc()}>
                      <Sparkles size={19} />
                      <span>
                        <strong>重新生成说明文档</strong>
                        <small>
                          更新本地 DitaList-Agent.md 中的当前程序与管道路径
                        </small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                    <button onClick={() => void openAgentDocDir()}>
                      <Folder size={19} />
                      <span>
                        <strong>打开说明文档所在目录</strong>
                        <small>
                          查看本地生成的 DitaList-Agent.md 文件并交给 Agent 阅读
                        </small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  </>
                )}
                <button onClick={deferAgentSetup}>
                  <Clock3 size={19} />
                  <span>
                    <strong>稍后配置 Agent</strong>
                    <small>
                      暂不配置也不影响使用；本页说明文案会一直保留在设置中
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              </div>
              {agentDoc?.path && (
                <p className="data-location">
                  说明文档路径：{agentDoc.path}
                </p>
              )}
              <div className="agent-doc-header">
                <div className="setting-subheading">
                  说明文档全文（常驻保存，可随时复制）
                </div>
                <button
                  type="button"
                  className="agent-doc-copy-btn"
                  aria-label="复制说明文档全文"
                  onClick={() => void copyAgentDoc()}
                >
                  {copiedAgentDoc ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedAgentDoc ? "已复制全文" : "复制全文"}</span>
                </button>
              </div>
              <textarea
                className="agent-doc-textarea"
                aria-label="Agent 配置说明文案"
                readOnly
                value={agentDoc?.content || defaultAgentDocTemplate}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDownAZ,
  Bell,
  CalendarDays,
  CalendarRange,
  CalendarCheck2,
  Check,
  CheckCheck,
  ChevronDown,
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
  completeTask,
  createTask,
  importBackupText,
  localDate,
  parseQuickInput,
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
  const quickRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  const latestData = useRef<AppData | null>(null);
  const saveRevision = useRef(0);
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
        new Set(
          data?.tasks.filter((t) => !t.deletedAt).flatMap((t) => t.tags) || [],
        ),
      ).sort(),
    [data?.tasks],
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
    const t = createTask({
      ...parsed,
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
        <span>正在读取本地清单…</span>
      </div>
    );

  const sidebarItem = (
    id: ViewId,
    label: string,
    Icon: LucideIcon,
    count?: number,
  ) => (
    <button
      key={id}
      className={`sidebar-item ${view === id ? "selected" : ""}`}
      title={
        id === "inbox"
          ? "暂时不知道放哪的任务先放这里，之后再整理"
          : undefined
      }
      onClick={() => go(id)}
    >
      <Icon size={17} />
      <span>{label}</span>
      {!!count && <small>{count}</small>}
    </button>
  );
  const listItem = (l: TaskList) => (
    <div
      key={l.id}
      className="sidebar-list-item"
      onContextMenu={(e) => {
        e.preventDefault();
        setListDialog(l);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const id = e.dataTransfer.getData("text/dida-task");
        if (id) patchTask(id, { listId: l.id });
      }}
    >
      <button
        className={`sidebar-item ${view === `list:${l.id}` ? "selected" : ""}`}
        onClick={() => go(`list:${l.id}`)}
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
          title="本地清单 · 设置"
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
                  onClick={() => {
                    setToast("在任务标题输入 #标签，或在任务详情中添加标签。");
                    quickRef.current?.focus();
                  }}
                >
                  <Plus size={14} />
                </button>
              </div>
              {tags.map((t) =>
                sidebarItem(
                  `tag:${t}`,
                  t,
                  Hash,
                  active.filter((x) => x.tags.includes(t)).length,
                ),
              )}
              {!tags.length && (
                <p className="sidebar-hint">
                  添加任务时输入 #，
                  <br />
                  给任务加上标签。
                </p>
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
              <h1>{title}</h1>
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
                <select
                  className="sort-select"
                  aria-label="任务排序"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as typeof sort)}
                >
                  <option value="manual">手动排序</option>
                  <option value="priority">按优先级</option>
                  <option value="date">按日期</option>
                  <option value="title">按标题</option>
                </select>
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
                      showList={!view.startsWith("list:")}
                      onSelect={() => setSelectedId(t.id)}
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
                          onSelect={() => setSelectedId(t.id)}
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
    </div>
  );
}

const TargetIcon = Clock3;

function TaskRow({
  task,
  list,
  selected,
  showList,
  onSelect,
  onToggle,
  onDate,
  onContext,
  onDrop,
}: {
  task: Task;
  list?: TaskList;
  selected: boolean;
  showList?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDate: () => void;
  onContext: (e: React.MouseEvent) => void;
  onDrop?: (id: string) => void;
}) {
  return (
    <div
      className={`task-row ${selected ? "selected" : ""} ${task.completedAt ? "completed" : ""}`}
      draggable={!task.deletedAt}
      onDragStart={(e) => e.dataTransfer.setData("text/dida-task", task.id)}
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
}: {
  task: Task;
  data: AppData;
  onPatch: (patch: Partial<Task>) => void;
  onToggle: () => void;
  onClose: () => void;
  onDate: () => void;
  onTrash: () => void;
  onRestore: () => void;
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
          <select
            aria-label="任务优先级"
            value={task.priority}
            onChange={(e) =>
              onPatch({ priority: Number(e.target.value) as Priority })
            }
            style={{
              color: priorities.find((p) => p.value === task.priority)?.color,
            }}
          >
            {priorities.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <Flag size={17} />
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
          <select
            aria-label="重复规则"
            value={task.repeat}
            onChange={(e) =>
              onPatch({
                repeat: e.target.value as RepeatRule,
                ...(e.target.value !== "none" && !task.dueDate
                  ? { dueDate: localDate() }
                  : {}),
                recurrenceAnchor: task.dueDate || localDate(),
              })
            }
          >
            {repeats.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
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
          <List size={14} />
          <select
            value={task.listId}
            aria-label="所属清单"
            onChange={(e) => onPatch({ listId: e.target.value })}
          >
            {data.lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
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

function NewTaskDialog({
  data,
  defaultList,
  date,
  endDate,
  defaultTime,
  onClose,
  onCreate,
}: {
  data: AppData;
  defaultList: string;
  date: string | null;
  endDate?: string;
  defaultTime?: string;
  onClose: () => void;
  onCreate: (task: Partial<Task> & { title: string }) => void;
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
            <input
              type="date"
              value={due}
              aria-label="新任务日期"
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
          <label>
            <Clock3 size={15} />
            <input
              type="time"
              aria-label="新任务时间"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <label>
            <Flag size={15} />
            <select
              value={priority}
              aria-label="新任务优先级"
              onChange={(e) => setPriority(Number(e.target.value) as Priority)}
            >
              {priorities.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <select
            value={list}
            aria-label="新任务所属清单"
            onChange={(e) => setList(e.target.value)}
          >
            {data.lists
              .filter((l) => !l.archived)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
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
          <input
            aria-label="截止日期"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <div className="date-two-columns">
          <label>
            开始日期（可选）
            <input
              aria-label="开始日期"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            时间
            <input
              aria-label="任务时间"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>
        <label className="select-row">
          <RotateCcw size={16} />
          重复
          <select
            value={repeat}
            onChange={(e) => setRepeat(e.target.value as RepeatRule)}
          >
            {repeats.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="select-row">
          <Bell size={16} />
          提醒
          <select
            value={reminder}
            onChange={(e) => setReminder(e.target.value as Reminder)}
          >
            {reminders.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
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
            <label>
              所在文件夹
              <select
                value={folderId}
                onChange={(e) => setFolder(e.target.value)}
              >
                <option value="">无</option>
                {data.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
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
  onClose,
  onChange,
  onExport,
  onImport,
  onReveal,
  onUnarchive,
}: {
  data: AppData;
  info: StorageInfo | null;
  onClose: () => void;
  onChange: (settings: Partial<AppData["settings"]>) => void;
  onExport: () => void;
  onImport: () => void;
  onReveal: () => void;
  onUnarchive: (id: string) => void;
}) {
  const [tab, setTab] = useState("general");
  const [capturingShortcut, setCapturingShortcut] = useState(false);
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
            <strong>本地清单</strong>
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
              <label className="setting-row">
                <span>启动时显示</span>
                <select
                  value={data.settings.defaultView}
                  onChange={(e) =>
                    onChange({ defaultView: e.target.value as ViewId })
                  }
                >
                  {[
                    "today",
                    "next7",
                    "inbox",
                    "calendar",
                    "focus",
                    "habits",
                  ].map((v) => (
                    <option value={v} key={v}>
                      {labels[v]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-row">
                <span>每周开始于</span>
                <select
                  value={data.settings.weekStart}
                  onChange={(e) =>
                    onChange({ weekStart: Number(e.target.value) as 0 | 1 })
                  }
                >
                  <option value={1}>星期一</option>
                  <option value={0}>星期日</option>
                </select>
              </label>
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
              <label className="setting-row">
                <span>默认清单</span>
                <select
                  value={data.settings.floatingDefaultListId}
                  onChange={(e) =>
                    onChange({ floatingDefaultListId: e.target.value })
                  }
                >
                  {data.lists
                    .filter((list) => !list.archived)
                    .map((list) => (
                      <option value={list.id} key={list.id}>
                        {list.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="setting-row">
                <span>默认日期</span>
                <select
                  value={data.settings.floatingDefaultDate}
                  onChange={(e) =>
                    onChange({
                      floatingDefaultDate: e.target.value as AppData["settings"]["floatingDefaultDate"],
                    })
                  }
                >
                  <option value="none">不设置日期</option>
                  <option value="today">今天</option>
                  <option value="tomorrow">明天</option>
                </select>
              </label>
              <p className="setting-caption">
                单击右下角托盘图标或按快捷键打开悬浮窗。输入中的日期和时间会覆盖默认日期。
              </p>
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
                    <small>支持本地清单 JSON、滴答清单 CSV</small>
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
        </div>
      </div>
    </div>
  );
}

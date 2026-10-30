import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
  ListTodo,
  ListFilter,
  MoreHorizontal,
  Plus,
  Repeat2,
  X,
} from "lucide-react";
import type { AppData, CalendarMode, Task, TaskList } from "../model";
import "../calendar.css";

interface CalendarViewProps {
  data: AppData;
  anchor: string;
  mode: CalendarMode;
  onAnchorChange: (date: string) => void;
  onModeChange: (mode: CalendarMode) => void;
  onSelectTask: (id: string) => void;
  onCreateTask: (date: string, endDate?: string, time?: string) => void;
  onMoveTask: (id: string, date: string, time?: string | null) => void;
  onToggleTask: (id: string) => void;
  showBacklog: boolean;
  onBacklogChange: (open: boolean) => void;
  detailPanel?: ReactNode;
}

interface SpanEvent {
  task: Task;
  start: number;
  end: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}
interface TimedEvent {
  task: Task;
  start: number;
  end: number;
  column: number;
  columns: number;
}
const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
const MODE_NAMES: Record<CalendarMode, string> = {
  day: "日",
  week: "周",
  month: "月",
  agenda: "议程",
};
const LUNAR_DAYS = [
  "初一",
  "初二",
  "初三",
  "初四",
  "初五",
  "初六",
  "初七",
  "初八",
  "初九",
  "初十",
  "十一",
  "十二",
  "十三",
  "十四",
  "十五",
  "十六",
  "十七",
  "十八",
  "十九",
  "二十",
  "廿一",
  "廿二",
  "廿三",
  "廿四",
  "廿五",
  "廿六",
  "廿七",
  "廿八",
  "廿九",
  "三十",
];
const HOUR_HEIGHT = 60;
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (date: string, count: number) => {
  const value = parseDate(date);
  value.setDate(value.getDate() + count);
  return localDate(value);
};
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const monthEnd = (date: string) => {
  const value = parseDate(date);
  return localDate(new Date(value.getFullYear(), value.getMonth() + 1, 0));
};
const addMonths = (date: string, count: number) => {
  const value = parseDate(date);
  return localDate(new Date(value.getFullYear(), value.getMonth() + count, 1));
};
const weekStart = (date: string, start: number) =>
  addDays(date, -((parseDate(date).getDay() - start + 7) % 7));
const inRange = (date: string, start: string, end: string) =>
  date >= start && date <= end;
const taskStart = (task: Task) => task.startDate || task.dueDate;
const taskEnd = (task: Task) => task.dueDate || task.startDate;
const onDay = (task: Task, date: string) => {
  const start = taskStart(task);
  const end = taskEnd(task);
  return !!start && !!end && inRange(date, start, end);
};
const taskOrder = (a: Task, b: Task) =>
  Number(!!b.pinned) - Number(!!a.pinned) ||
  (a.time || "").localeCompare(b.time || "") ||
  a.sortOrder - b.sortOrder ||
  a.createdAt.localeCompare(b.createdAt);
const minutes = (time: string | null, fallback: number) =>
  time ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) : fallback;
const tint = (color: string, alpha: string) =>
  /^#[\da-f]{6}$/i.test(color) ? `${color}${alpha}` : "var(--soft)";
function timeAtOffset(offset: number): string {
  const minute = Math.max(
    0,
    Math.min(1425, Math.round(((offset / HOUR_HEIGHT) * 60) / 15) * 15),
  );
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

let lunarFormatter: Intl.DateTimeFormat | undefined;
try {
  lunarFormatter = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
    month: "long",
    day: "numeric",
  });
} catch {
  /* The calendar remains usable without optional lunar data. */
}
function lunarLabel(date: string) {
  try {
    const parts = lunarFormatter?.formatToParts(parseDate(date));
    const day = Number(parts?.find((p) => p.type === "day")?.value);
    return day === 1
      ? parts?.find((p) => p.type === "month")?.value || ""
      : LUNAR_DAYS[day - 1] || "";
  } catch {
    return "";
  }
}

function weekEvents(tasks: Task[], start: string): SpanEvent[] {
  const end = addDays(start, 6);
  const lanes: number[] = [];
  return tasks
    .filter(
      (t) => !!taskStart(t) && taskStart(t)! <= end && taskEnd(t)! >= start,
    )
    .sort(
      (a, b) =>
        taskStart(a)!.localeCompare(taskStart(b)!) ||
        taskEnd(b)!.localeCompare(taskEnd(a)!) ||
        taskOrder(a, b),
    )
    .map((task) => {
      const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      const first = Math.max(
        0,
        dates.findIndex((d) => d >= taskStart(task)!),
      );
      let last = 6;
      while (last >= 0 && dates[last] > taskEnd(task)!) last--;
      if (last < 0) last = 6;
      let lane = lanes.findIndex((lastColumn) => lastColumn < first);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = last;
      return {
        task,
        start: first,
        end: last,
        lane,
        continuesBefore: taskStart(task)! < start,
        continuesAfter: taskEnd(task)! > end,
      };
    });
}

function timeEvents(tasks: Task[], date: string): TimedEvent[] {
  const events: TimedEvent[] = tasks
    .filter((t) => onDay(t, date) && !!t.time)
    .map((task) => {
      const start = taskStart(task)! < date ? 0 : minutes(task.time, 0);
      let end =
        taskEnd(task)! > date ? 1440 : minutes(task.endTime, start + 60);
      if (end <= start) end = Math.min(start + 60, 1440);
      return {
        task,
        start,
        end: Math.min(1440, Math.max(start + 20, end)),
        column: 0,
        columns: 1,
      };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster: TimedEvent[] = [];
  let clusterEnd = -1;
  let ends: number[] = [];
  const finish = () =>
    cluster.forEach((event) => {
      event.columns = ends.length;
    });
  for (const event of events) {
    if (event.start >= clusterEnd) {
      finish();
      cluster = [];
      ends = [];
    }
    let column = ends.findIndex((end) => end <= event.start);
    if (column < 0) column = ends.length;
    event.column = column;
    ends[column] = event.end;
    cluster.push(event);
    clusterEnd = Math.max(event.end, ...cluster.map((t) => t.end));
  }
  finish();
  return events;
}

export default function CalendarView({
  data,
  anchor,
  mode,
  onAnchorChange,
  onModeChange,
  onSelectTask,
  onCreateTask,
  onMoveTask,
  onToggleTask,
  showBacklog,
  onBacklogChange,
  detailPanel,
}: CalendarViewProps) {
  const today = localDate(new Date());
  const [openPopover, setOpenPopover] = useState<"date" | "lists" | "options" | null>(null);
  const [pickerMode, setPickerMode] = useState<"days" | "months">("days");
  const [draggingBacklog, setDraggingBacklog] = useState(false);
  const [pickerYear, setPickerYear] = useState(() =>
    parseDate(anchor).getFullYear(),
  );
  const [showCompleted, setShowCompleted] = useState(
    data.settings.showCompleted,
  );
  const [showLunar, setShowLunar] = useState(true);
  const [selectedLists, setSelectedLists] = useState<Set<string> | null>(null);
  const [miniMonth, setMiniMonth] = useState(monthStart(anchor));
  const [gridHeight, setGridHeight] = useState(600);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [timeDropPreview, setTimeDropPreview] = useState<{
    date: string;
    time: string;
  } | null>(null);
  const [range, setRange] = useState<{ start: string; end: string } | null>(
    null,
  );
  const [clock, setClock] = useState(new Date());
  const monthViewport = useRef<HTMLDivElement>(null);
  const timeViewport = useRef<HTMLDivElement>(null);
  const timeDragPointer = useRef<{
    date: string;
    clientY: number;
    column: HTMLElement;
  } | null>(null);
  const rangeRef = useRef<{ start: string; end: string } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const monthPickerRef = useRef<HTMLDivElement>(null);
  const listPickerRef = useRef<HTMLDivElement>(null);
  const settingsWeekStart = data.settings.weekStart;
  const weekdays = Array.from(
    { length: 7 },
    (_, i) => (settingsWeekStart + i) % 7,
  );
  const lists = useMemo(() => {
    const value = data.lists
      .filter((list) => !list.archived)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder);
    if (!value.some((list) => list.id === "inbox"))
      value.unshift({
        id: "inbox",
        name: "收集箱",
        color: "#4772fa",
        folderId: null,
        archived: false,
        sortOrder: -1,
      });
    return value;
  }, [data.lists]);
  const listMap = useMemo(
    () => new Map(lists.map((list) => [list.id, list])),
    [lists],
  );
  const tasks = useMemo(
    () =>
      data.tasks.filter(
        (task) =>
          !task.deletedAt && task.agentStatus !== "pending" &&
          (showCompleted || !task.completedAt) &&
          (selectedLists === null || selectedLists.has(task.listId)),
      ),
    [data.tasks, selectedLists, showCompleted],
  );
  const backlog = useMemo(
    () => tasks.filter((task) => !taskStart(task)).sort(taskOrder),
    [tasks],
  );
  const firstDate = weekStart(monthStart(anchor), settingsWeekStart);
  const lastDate = addDays(weekStart(monthEnd(anchor), settingsWeekStart), 6);
  const weekCount =
    Math.floor((Date.parse(lastDate) - Date.parse(firstDate)) / 604800000) + 1;
  const weeks = Array.from({ length: weekCount }, (_, i) =>
    addDays(firstDate, i * 7),
  );
  const maxRows = Math.max(1, Math.floor((gridHeight / weekCount - 52) / 23));
  const timeDates =
    mode === "week"
      ? Array.from({ length: 7 }, (_, i) =>
          addDays(weekStart(anchor, settingsWeekStart), i),
        )
      : [anchor];
  const anchorDate = parseDate(anchor);
  const mainTitle =
    mode === "day"
      ? `${anchorDate.getFullYear()}年${anchorDate.getMonth() + 1}月${anchorDate.getDate()}日`
      : `${anchorDate.getFullYear()}年${anchorDate.getMonth() + 1}月`;
  const dateTitle = (date: string) =>
    `${parseDate(date).getMonth() + 1}月${parseDate(date).getDate()}日 周${DAY_NAMES[parseDate(date).getDay()]}`;

  useEffect(() => {
    setMiniMonth(monthStart(anchor));
    setPickerYear(parseDate(anchor).getFullYear());
  }, [anchor.slice(0, 7)]);
  useEffect(() => {
    const element = monthViewport.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setGridHeight(entries[0].contentRect.height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);
  useEffect(() => {
    if (mode === "day" || mode === "week")
      timeViewport.current?.scrollTo({
        top: Math.max(0, (new Date().getHours() - 1) * HOUR_HEIGHT),
      });
  }, [mode]);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const finish = () => {
      setDraggingBacklog(false);
      setDraggedTaskId(null);
      setDragOver(null);
      setTimeDropPreview(null);
      timeDragPointer.current = null;
    };
    window.addEventListener("dragend", finish, true);
    window.addEventListener("drop", finish, true);
    return () => {
      window.removeEventListener("dragend", finish, true);
      window.removeEventListener("drop", finish, true);
    };
  }, []);
  useEffect(() => {
    if (!openPopover) return;
    const container = (openPopover === "date"
      ? monthPickerRef
      : openPopover === "lists"
        ? listPickerRef
        : optionsRef).current;
    const close = (event: PointerEvent) => {
      if (!container?.contains(event.target as Node)) setOpenPopover(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpenPopover(null);
        container?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [openPopover]);
  useEffect(() => {
    const cancelHold = () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = null;
    };
    const move = (event: PointerEvent) => {
      if (!rangeRef.current) {
        if (
          pointerStart.current &&
          Math.hypot(
            pointerStart.current.x - event.clientX,
            pointerStart.current.y - event.clientY,
          ) > 8
        )
          cancelHold();
        return;
      }
      const cell = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(".cal-day[data-date]");
      const date = cell?.dataset.date;
      if (date && date !== rangeRef.current.end) {
        rangeRef.current = { ...rangeRef.current, end: date };
        setRange(rangeRef.current);
      }
    };
    const finish = () => {
      cancelHold();
      pointerStart.current = null;
      const selected = rangeRef.current;
      rangeRef.current = null;
      setRange(null);
      if (selected)
        onCreateTask(
          selected.start <= selected.end ? selected.start : selected.end,
          selected.start <= selected.end ? selected.end : selected.start,
        );
    };
    const cancel = () => {
      cancelHold();
      pointerStart.current = null;
      rangeRef.current = null;
      setRange(null);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancel);
    return () => {
      cancelHold();
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
    };
  }, [onCreateTask]);

  function toggleList(id: string) {
    setSelectedLists((previous) => {
      const next = new Set(previous ?? lists.map((list) => list.id));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size === lists.length ? null : next;
    });
  }
  function move(step: number) {
    setOpenPopover(null);
    onAnchorChange(
      mode === "day"
        ? addDays(anchor, step)
        : mode === "week"
          ? addDays(anchor, step * 7)
          : addMonths(anchor, step),
    );
  }
  function dragStart(event: DragEvent, task: Task) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/dida-task", task.id);
    event.dataTransfer.setData("text/plain", task.id);
    setDraggedTaskId(task.id);
    clearDropTarget();
    if (mode === "day" || mode === "week") {
      // The snapped line is the start-time anchor. A native card ghost would
      // retain the grab offset and appear to start earlier than the drop time.
      const ghost = document.createElement("canvas");
      ghost.width = ghost.height = 1;
      ghost.style.cssText = "position:fixed;top:0;left:0;pointer-events:none";
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 0, 0);
      requestAnimationFrame(() => ghost.remove());
    }
  }
  function clearDropTarget() {
    setDragOver(null);
    setTimeDropPreview(null);
    timeDragPointer.current = null;
  }
  function leaveDropTarget(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      clearDropTarget();
  }
  function updateTimeDropPreview() {
    const pointer = timeDragPointer.current;
    if (!pointer) return;
    const time = timeAtOffset(
      pointer.clientY - pointer.column.getBoundingClientRect().top,
    );
    setTimeDropPreview((previous) =>
      previous?.date === pointer.date && previous.time === time
        ? previous
        : { date: pointer.date, time },
    );
  }
  function drop(event: DragEvent, date: string, time?: string | null) {
    event.preventDefault();
    event.stopPropagation();
    clearDropTarget();
    const id = event.dataTransfer.getData("text/dida-task");
    if (id && data.tasks.some((task) => task.id === id && !task.deletedAt))
      onMoveTask(id, date, time);
  }
  function allowDrop(event: DragEvent<HTMLElement>, date: string, timed = false) {
    if (event.dataTransfer.types.includes("text/dida-task")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragOver(date);
      if (timed) {
        timeDragPointer.current = {
          date,
          clientY: event.clientY,
          column: event.currentTarget,
        };
        updateTimeDropPreview();
      } else {
        timeDragPointer.current = null;
        setTimeDropPreview(null);
      }
    }
  }
  function weekDropDate(event: DragEvent<HTMLElement>, start: string) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return addDays(
      start,
      Math.max(
        0,
        Math.min(
          6,
          Math.floor(((event.clientX - bounds.left) / bounds.width) * 7),
        ),
      ),
    );
  }
  function startRange(event: ReactPointerEvent, date: string) {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest(".cal-event,.cal-overflow,button")
    )
      return;
    pointerStart.current = { x: event.clientX, y: event.clientY };
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      rangeRef.current = { start: date, end: date };
      setRange(rangeRef.current);
    }, 420);
  }
  function taskColor(task: Task) {
    return listMap.get(task.listId)?.color || "#4772fa";
  }
  function eventStyle(task: Task, solid = false): CSSProperties {
    const color = taskColor(task);
    return {
      "--event-color": color,
      background: solid ? color : tint(color, "20"),
      color: solid ? "#fff" : "var(--calendar-event-text)",
    } as CSSProperties;
  }
  function taskBar(task: Task, extraClass = "", style?: CSSProperties) {
    return (
      <div
        key={task.id}
        className={`cal-event ${task.completedAt ? "cal-event--completed" : ""} ${task.id === draggedTaskId ? "is-drag-source" : ""} ${extraClass}`}
        style={style ?? eventStyle(task)}
        draggable
        onDragStart={(event) => dragStart(event, task)}
        onDragEnd={clearDropTarget}
        onClick={(event) => {
          event.stopPropagation();
          onSelectTask(task.id);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSelectTask(task.id);
        }}
        title={`${task.time ? task.time + " " : ""}${task.title}`}
      >
        <button
          className={`cal-check cal-priority-${task.priority}`}
          aria-label={`${task.completedAt ? "取消完成" : "完成"}：${task.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleTask(task.id);
          }}
        >
          {task.completedAt && <Check size={10} />}
        </button>
        {task.time && <span className="cal-event-time">{task.time}</span>}
        <span className="cal-event-title">{task.title || "无标题任务"}</span>
        {task.repeat !== "none" && (
          <Repeat2 className="cal-event-repeat" size={11} />
        )}
      </div>
    );
  }

  const miniStart = weekStart(miniMonth, settingsWeekStart);
  const draggedTask = data.tasks.find((task) => task.id === draggedTaskId);
  const miniDates = Array.from({ length: 42 }, (_, i) => addDays(miniStart, i));
  const agendaDates = Array.from(
    { length: parseDate(monthEnd(anchor)).getDate() },
    (_, i) => addDays(monthStart(anchor), i),
  ).filter((date) => tasks.some((task) => onDay(task, date)));

  return (
    <div className="calendar-view">
      <section className="cal-main" aria-label="日历">
        <header className="cal-toolbar">
          <div className="cal-toolbar-left">
            <div className="cal-title-picker" ref={monthPickerRef}>
              <button
                type="button"
                className="cal-title-picker-button"
                aria-expanded={openPopover === "date"}
                aria-haspopup="dialog"
                aria-label="选择日期"
                onClick={() => {
                  setPickerYear(anchorDate.getFullYear());
                  setMiniMonth(monthStart(anchor));
                  setPickerMode("days");
                  setOpenPopover((value) => value === "date" ? null : "date");
                }}
              >
                <h1>{mainTitle}</h1>
                <ChevronDown size={13} />
              </button>
              <input
                type="text"
                className="cal-month-sr-input"
                aria-label="选择日历月份"
                tabIndex={-1}
                value={anchor.slice(0, 7)}
                onChange={(event) => {
                  if (/^\d{4}-\d{2}$/.test(event.target.value)) {
                    onAnchorChange(`${event.target.value}-01`);
                    setOpenPopover(null);
                  }
                }}
              />
              {openPopover === "date" && (
                <div
                  className="cal-month-popover"
                  role="dialog"
                  aria-label="选择日历日期"
                >
                  <div className="cal-month-popover-header">
                    <button
                      type="button"
                      className="cal-icon-button"
                      aria-label={pickerMode === "months" ? "上一年" : "小日历上个月"}
                      onClick={() => pickerMode === "months"
                        ? setPickerYear((year) => year - 1)
                        : setMiniMonth(addMonths(miniMonth, -1))}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      className="cal-picker-heading"
                      aria-label={pickerMode === "days" ? "选择年份与月份" : "返回日期选择"}
                      onClick={() => {
                        setPickerYear(parseDate(miniMonth).getFullYear());
                        setPickerMode((value) => value === "days" ? "months" : "days");
                      }}
                    >
                      {pickerMode === "months"
                        ? `${pickerYear}年`
                        : `${parseDate(miniMonth).getFullYear()}年${parseDate(miniMonth).getMonth() + 1}月`}
                      <ChevronDown size={13} />
                    </button>
                    <button
                      type="button"
                      className="cal-icon-button"
                      aria-label={pickerMode === "months" ? "下一年" : "小日历下个月"}
                      onClick={() => pickerMode === "months"
                        ? setPickerYear((year) => year + 1)
                        : setMiniMonth(addMonths(miniMonth, 1))}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                  {pickerMode === "months" ? (
                    <div className="cal-month-popover-grid">
                      {Array.from({ length: 12 }, (_, idx) => {
                        const m = idx + 1;
                        const ym = `${pickerYear}-${String(m).padStart(2, "0")}`;
                        const selected = miniMonth.slice(0, 7) === ym;
                        const current = today.slice(0, 7) === ym;
                        return (
                          <button
                            type="button"
                            key={m}
                            className={`cal-month-cell ${selected ? "is-selected" : ""} ${current ? "is-current" : ""}`}
                            onClick={() => {
                              setMiniMonth(`${ym}-01`);
                              onAnchorChange(`${ym}-01`);
                              setPickerMode("days");
                            }}
                          >
                            {m}月
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="cal-mini-grid">
                      <div className="cal-mini-weekdays">
                        {weekdays.map((day) => <span key={day}>{DAY_NAMES[day]}</span>)}
                      </div>
                      <div className="cal-mini-dates">
                        {miniDates.map((date) => (
                          <button
                            key={date}
                            className={`${date.slice(0, 7) !== miniMonth.slice(0, 7) ? "cal-mini-outside" : ""} ${date === today ? "cal-mini-today" : ""} ${date === anchor ? "cal-mini-selected" : ""}`}
                            aria-label={date}
                            aria-current={date === today ? "date" : undefined}
                            onClick={() => {
                              onAnchorChange(date);
                              setOpenPopover(null);
                            }}
                          >
                            <span>{parseDate(date).getDate()}</span>
                            {tasks.some((task) => onDay(task, date) && !task.completedAt) && <i />}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="cal-month-popover-footer">
                    <button
                      type="button"
                      onClick={() => setOpenPopover(null)}
                    >
                      关闭
                    </button>
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => {
                        onAnchorChange(today);
                        setOpenPopover(null);
                      }}
                    >
                      回到今天
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="cal-navigation">
              <button
                className="cal-today-button"
                onClick={() => {
                  onAnchorChange(today);
                  setOpenPopover(null);
                }}
              >
                今天
              </button>
              <button
                className="cal-icon-button"
                aria-label="上一个日历周期"
                onClick={() => move(-1)}
              >
                <ChevronLeft size={19} />
              </button>
              <button
                className="cal-icon-button"
                aria-label="下一个日历周期"
                onClick={() => move(1)}
              >
                <ChevronRight size={19} />
              </button>
            </div>
          </div>
          <div className="cal-toolbar-right">
            <div className="cal-mode-switch" role="group" aria-label="日历视图">
              {(["day", "week", "month", "agenda"] as CalendarMode[]).map(
                (value) => (
                  <button
                    key={value}
                    className={mode === value ? "active" : ""}
                    aria-pressed={mode === value}
                    onClick={() => {
                      setOpenPopover(null);
                      onModeChange(value);
                    }}
                  >
                    {MODE_NAMES[value]}
                  </button>
                ),
              )}
            </div>
            <div className="cal-list-picker" ref={listPickerRef}>
              <button
                className={`cal-toolbar-button ${openPopover === "lists" || selectedLists !== null ? "active" : ""}`}
                aria-label="筛选日历清单"
                aria-expanded={openPopover === "lists"}
                aria-haspopup="dialog"
                onClick={() => setOpenPopover((value) => value === "lists" ? null : "lists")}
              >
                <ListFilter size={16} />
                <span>清单</span>
                {selectedLists !== null && <small>{lists.filter((list) => selectedLists.has(list.id)).length}/{lists.length}</small>}
              </button>
              {openPopover === "lists" && (
                <div className="cal-list-menu" role="dialog" aria-label="显示清单">
                  <div className="cal-filter-heading">
                    <span>显示清单</span>
                    <button onClick={() => setSelectedLists(selectedLists === null ? new Set() : null)}>
                      {selectedLists === null ? "取消全选" : "全选"}
                    </button>
                  </div>
                  <div className="cal-list-filters">
                    {lists.map((list) => (
                      <button
                        className="cal-list-filter"
                        key={list.id}
                        onClick={() => toggleList(list.id)}
                        aria-pressed={selectedLists === null || selectedLists.has(list.id)}
                      >
                        <span
                          className={`cal-filter-checkbox ${selectedLists === null || selectedLists.has(list.id) ? "is-checked" : ""}`}
                          style={{ "--list-color": list.color } as CSSProperties}
                        >
                          {(selectedLists === null || selectedLists.has(list.id)) && <Check size={11} />}
                        </span>
                        {list.id === "inbox"
                          ? <Inbox size={16} style={{ color: list.color }} />
                          : <ListTodo size={16} style={{ color: list.color }} />}
                        <span>{list.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              className={`cal-toolbar-button cal-arrange-button ${showBacklog ? "active" : ""}`}
              aria-label="安排未设日期的任务"
              aria-pressed={showBacklog}
              aria-expanded={showBacklog}
              onClick={() => {
                setOpenPopover(null);
                onBacklogChange(!showBacklog);
              }}
            >
              <Inbox size={16} />
              <span>待安排</span>
              <small>{backlog.length}</small>
            </button>
            <div className="cal-options" ref={optionsRef}>
              <button
                className="cal-icon-button"
                aria-label="日历显示设置"
                aria-expanded={openPopover === "options"}
                onClick={() => setOpenPopover((value) => value === "options" ? null : "options")}
              >
                <MoreHorizontal size={20} />
              </button>
              {openPopover === "options" && (
                <div className="cal-options-menu">
                  <label>
                    <span>显示已完成</span>
                    <input
                      type="checkbox"
                      checked={showCompleted}
                      onChange={(event) =>
                        setShowCompleted(event.target.checked)
                      }
                    />
                  </label>
                  <label>
                    <span>显示农历</span>
                    <input
                      type="checkbox"
                      checked={showLunar}
                      onChange={(event) => setShowLunar(event.target.checked)}
                    />
                  </label>
                  <button
                    onClick={() => {
                      onCreateTask(anchor);
                      setOpenPopover(null);
                    }}
                  >
                    <span>添加任务</span>
                    <Plus size={15} />
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="cal-workspace">
          {mode === "month" && (
            <div className="cal-month">
              <div className="cal-weekday-header">
                {weekdays.map((day) => (
                  <div
                    className={day === 0 || day === 6 ? "cal-weekend-name" : ""}
                    key={day}
                  >
                    周{DAY_NAMES[day]}
                  </div>
                ))}
              </div>
              <div
                className={`cal-month-body ${range ? "cal-selecting-range" : ""}`}
                ref={monthViewport}
                style={{ "--week-count": weekCount } as CSSProperties}
              >
                {weeks.map((start) => {
                  const events = weekEvents(tasks, start);
                  return (
                    <div
                      className="cal-week"
                      key={start}
                      onDragOver={(event) =>
                        allowDrop(event, weekDropDate(event, start))
                      }
                      onDrop={(event) =>
                        drop(event, weekDropDate(event, start))
                      }
                    >
                      <div className="cal-week-cells">
                        {Array.from({ length: 7 }, (_, i) =>
                          addDays(start, i),
                        ).map((date, i) => {
                          const hidden = events.filter(
                            (event) =>
                              event.lane >= maxRows &&
                              i >= event.start &&
                              i <= event.end,
                          ).length;
                          const selectedRange =
                            !!range &&
                            inRange(
                              date,
                              range.start <= range.end
                                ? range.start
                                : range.end,
                              range.start <= range.end
                                ? range.end
                                : range.start,
                            );
                          return (
                            <div
                              key={date}
                              data-date={date}
                              className={`cal-day ${date.slice(0, 7) !== anchor.slice(0, 7) ? "cal-day--outside" : ""} ${date === today ? "cal-day--today" : ""} ${dragOver === date || selectedRange ? "cal-day--drop" : ""}`}
                              onDoubleClick={() => {
                                if (!rangeRef.current) onCreateTask(date);
                              }}
                              onPointerDown={(event) => startRange(event, date)}
                              onDragOver={(event) => allowDrop(event, date)}
                              onDragLeave={(event) => {
                                if (
                                  !event.currentTarget.contains(
                                    event.relatedTarget as Node,
                                  )
                                )
                                  setDragOver(null);
                              }}
                              onDrop={(event) => drop(event, date)}
                            >
                              <div className="cal-date-heading">
                                <button
                                  className="cal-date-number"
                                  aria-label={`查看${dateTitle(date)}`}
                                  onDoubleClick={(event) => {
                                    event.stopPropagation();
                                    onCreateTask(date);
                                  }}
                                  onClick={() => onAnchorChange(date)}
                                >
                                  {parseDate(date).getDate()}
                                </button>
                                {showLunar && (
                                  <span className="cal-lunar">
                                    {lunarLabel(date)}
                                  </span>
                                )}
                              </div>
                              {hidden > 0 && (
                                <button
                                  className="cal-overflow"
                                  onDoubleClick={(event) =>
                                    event.stopPropagation()
                                  }
                                  onClick={() => {
                                    onAnchorChange(date);
                                    onModeChange("day");
                                  }}
                                >
                                  还有 {hidden} 项
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div
                        className="cal-week-events"
                        style={{ "--event-rows": maxRows } as CSSProperties}
                      >
                        {events
                          .filter((event) => event.lane < maxRows)
                          .map((event) => (
                            <div
                              key={event.task.id}
                              className="cal-span-event"
                              style={{
                                gridColumn: `${event.start + 1} / span ${event.end - event.start + 1}`,
                                gridRow: event.lane + 1,
                              }}
                              onDragOver={(e) => {
                                if (
                                  e.dataTransfer.types.includes(
                                    "text/dida-task",
                                  )
                                )
                                  e.preventDefault();
                              }}
                            >
                              {taskBar(
                                event.task,
                                `${event.continuesBefore ? "cal-event--continues-before" : ""} ${event.continuesAfter ? "cal-event--continues-after" : ""}`,
                                eventStyle(
                                  event.task,
                                  event.start !== event.end ||
                                    event.continuesBefore ||
                                    event.continuesAfter,
                                ),
                              )}
                            </div>
                          ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(mode === "week" || mode === "day") && (
            <div
              className={`cal-time-view ${mode === "day" ? "cal-time-view--day" : ""}`}
            >
              <div
                className="cal-time-head"
                style={{ "--time-days": timeDates.length } as CSSProperties}
              >
                <span className="cal-time-gutter" />
                {timeDates.map((date) => (
                  <button
                    className={`cal-time-dayhead ${date === today ? "is-today" : ""}`}
                    key={date}
                    onClick={() => {
                      onAnchorChange(date);
                      onModeChange("day");
                    }}
                  >
                    <span>周{DAY_NAMES[parseDate(date).getDay()]}</span>
                    <strong>{parseDate(date).getDate()}</strong>
                    {showLunar && <small>{lunarLabel(date)}</small>}
                  </button>
                ))}
              </div>
              <div
                className="cal-all-day"
                style={{ "--time-days": timeDates.length } as CSSProperties}
              >
                <span className="cal-time-gutter">全天</span>
                {timeDates.map((date) => (
                  <div
                    key={date}
                    className={
                      dragOver === date && !timeDropPreview
                        ? "cal-time-allday-cell is-drop"
                        : "cal-time-allday-cell"
                    }
                    onDoubleClick={() => onCreateTask(date)}
                    onDragOver={(event) => allowDrop(event, date)}
                    onDragLeave={leaveDropTarget}
                    onDrop={(event) => drop(event, date, null)}
                  >
                    {tasks
                      .filter((task) => onDay(task, date) && !task.time)
                      .sort(taskOrder)
                      .map((task) => taskBar(task))}
                  </div>
                ))}
              </div>
              <div
                className="cal-time-scroll"
                ref={timeViewport}
                onScroll={updateTimeDropPreview}
              >
                <div
                  className="cal-time-canvas"
                  style={
                    {
                      "--time-days": timeDates.length,
                      "--hour-height": `${HOUR_HEIGHT}px`,
                      height: HOUR_HEIGHT * 24,
                    } as CSSProperties
                  }
                >
                  <div className="cal-hour-labels">
                    {Array.from({ length: 24 }, (_, hour) => (
                      <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>
                        {String(hour).padStart(2, "0")}:00
                      </span>
                    ))}
                  </div>
                  {timeDates.map((date) => (
                    <div
                      key={date}
                      className={`cal-time-column ${date === today ? "is-today" : ""} ${timeDropPreview?.date === date ? "is-drop" : ""}`}
                      onDragOver={(event) => allowDrop(event, date, true)}
                      onDragLeave={leaveDropTarget}
                      onDrop={(event) =>
                        drop(
                          event,
                          date,
                          timeAtOffset(
                            event.clientY -
                              event.currentTarget.getBoundingClientRect().top,
                          ),
                        )
                      }
                    >
                      {Array.from({ length: 24 }, (_, hour) => (
                        <div
                          key={hour}
                          className="cal-hour-cell"
                          style={{
                            top: hour * HOUR_HEIGHT,
                            height: HOUR_HEIGHT,
                          }}
                          onDoubleClick={() =>
                            onCreateTask(
                              date,
                              undefined,
                              `${String(hour).padStart(2, "0")}:00`,
                            )
                          }
                        />
                      ))}
                      {timeEvents(tasks, date).map((event) => (
                        <div
                          key={event.task.id}
                          className="cal-timed-event"
                          style={{
                            top: (event.start / 60) * HOUR_HEIGHT,
                            height:
                              ((event.end - event.start) / 60) * HOUR_HEIGHT,
                            left: `calc(${(event.column / event.columns) * 100}% + 2px)`,
                            width: `calc(${100 / event.columns}% - 5px)`,
                          }}
                        >
                          {taskBar(
                            event.task,
                            "cal-event--timed",
                            eventStyle(event.task),
                          )}
                        </div>
                      ))}
                      {timeDropPreview?.date === date && (
                        <div
                          className={`cal-drop-marker ${timeDropPreview.time >= "23:30" ? "is-near-end" : ""}`}
                          style={{
                            top: (minutes(timeDropPreview.time, 0) / 60) * HOUR_HEIGHT,
                          }}
                        >
                          <div
                            className="cal-drop-caption"
                            role="status"
                            aria-label={`开始时间 ${timeDropPreview.time}`}
                          >
                            <strong>{timeDropPreview.time}</strong>
                            <span>{draggedTask?.title || "安排任务"}</span>
                          </div>
                        </div>
                      )}
                      {date === today && (
                        <div
                          className="cal-now-line"
                          style={{
                            top:
                              (clock.getHours() + clock.getMinutes() / 60) *
                              HOUR_HEIGHT,
                          }}
                        >
                          <i />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {mode === "agenda" && (
            <div className="cal-agenda">
              {agendaDates.length === 0 ? (
                <div className="cal-agenda-empty">
                  <CalendarDays size={44} strokeWidth={1} />
                  <h2>这个月还没有安排</h2>
                  <p>添加一项任务，开始规划你的时间。</p>
                  <button onClick={() => onCreateTask(anchor)}>
                    <Plus size={16} />
                    添加任务
                  </button>
                </div>
              ) : (
                agendaDates.map((date) => (
                  <section
                    className={`cal-agenda-group ${date === today ? "is-today" : ""}`}
                    key={date}
                  >
                    <div className="cal-agenda-date">
                      <strong>{parseDate(date).getDate()}</strong>
                      <span>
                        {parseDate(date).getMonth() + 1}月 · 周
                        {DAY_NAMES[parseDate(date).getDay()]}
                      </span>
                      {date === today && <small>今天</small>}
                    </div>
                    <div
                      className="cal-agenda-tasks"
                      onDragOver={(event) => allowDrop(event, date)}
                      onDrop={(event) => drop(event, date)}
                    >
                      {tasks
                        .filter((task) => onDay(task, date))
                        .sort(taskOrder)
                        .map((task) => (
                          <div
                            className={`cal-agenda-task ${task.completedAt ? "is-completed" : ""}`}
                            key={task.id}
                            draggable
                            onDragStart={(event) => dragStart(event, task)}
                          >
                            <button
                              className={`cal-agenda-check cal-priority-${task.priority}`}
                              aria-label={`${task.completedAt ? "取消完成" : "完成"}：${task.title}`}
                              onClick={() => onToggleTask(task.id)}
                            >
                              {task.completedAt && <Check size={12} />}
                            </button>
                            <button
                              className="cal-agenda-task-content"
                              onClick={() => onSelectTask(task.id)}
                            >
                              <span>{task.title}</span>
                              <small>
                                {task.time || "全天"}
                                {task.repeat !== "none" && (
                                  <Repeat2 size={12} />
                                )}
                              </small>
                            </button>
                            <span className="cal-agenda-list">
                              <i style={{ background: taskColor(task) }} />
                              {listMap.get(task.listId)?.name || "收集箱"}
                            </span>
                          </div>
                        ))}
                    </div>
                  </section>
                ))
              )}
            </div>
          )}

          {showBacklog && !detailPanel && (
            <aside className={`cal-backlog ${draggingBacklog ? "is-dragging" : ""}`} aria-label="待安排任务">
              <div className="cal-backlog-heading">
                <strong>待安排</strong>
                <span>{backlog.length}</span>
                <button
                  aria-label="关闭待安排"
                  onClick={() => onBacklogChange(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <p>拖动任务到日历，为它安排日期。</p>
              {backlog.length === 0 ? (
                <div className="cal-backlog-empty">
                  <Inbox size={30} strokeWidth={1} />
                  <span>所有任务都安排好了</span>
                </div>
              ) : (
                backlog.map((task) => (
                  <div
                    className="cal-backlog-task"
                    key={task.id}
                    draggable
                    onDragStart={(event) => {
                      dragStart(event, task);
                      setDraggingBacklog(true);
                    }}
                    onDragEnd={() => setDraggingBacklog(false)}
                  >
                    <button
                      className={`cal-agenda-check cal-priority-${task.priority}`}
                      aria-label={`完成：${task.title}`}
                      onClick={() => onToggleTask(task.id)}
                    >
                      {task.completedAt && <Check size={11} />}
                    </button>
                    <button onClick={() => onSelectTask(task.id)}>
                      <span>{task.title}</span>
                      <small>
                        <i style={{ background: taskColor(task) }} />
                        {listMap.get(task.listId)?.name || "收集箱"}
                      </small>
                    </button>
                  </div>
                ))
              )}
            </aside>
          )}
          {detailPanel && <div className="cal-detail-panel">{detailPanel}</div>}
        </div>
      </section>
    </div>
  );
}

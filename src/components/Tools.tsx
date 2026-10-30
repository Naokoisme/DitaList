import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Coffee,
  Flag,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Target,
  Trash2,
  X,
} from "lucide-react";
import type { AppData, Habit, Priority } from "../model";
import { CustomSelect } from "../App";

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
import type { CommandReceipt, FocusState, Operation } from "../generated/contracts";
type Command = (operation: Operation) => Promise<CommandReceipt | null>;

export function MatrixView({
  data,
  onSelectTask,
  onToggleTask,
  onCommand,
}: {
  data: AppData;
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => void;
  onCommand: Command;
}) {
  const quadrants: {
    priority: Priority;
    title: string;
    subtitle: string;
    color: string;
  }[] = [
    {
      priority: 1,
      title: "重要且紧急",
      subtitle: "优先处理",
      color: "#e13e39",
    },
    {
      priority: 2,
      title: "重要不紧急",
      subtitle: "安排时间",
      color: "#faa80c",
    },
    {
      priority: 3,
      title: "不重要但紧急",
      subtitle: "尽快处理",
      color: "#4772fa",
    },
    {
      priority: 0,
      title: "不重要不紧急",
      subtitle: "有空再做",
      color: "#8b8d91",
    },
  ];
  return (
    <div className="tool-view">
      <header className="view-header">
        <h1>四象限</h1>
        <span className="muted">按优先级安排任务</span>
      </header>
      <div className="matrix-grid">
        {quadrants.map((q) => {
          const tasks = data.tasks.filter(
            (t) => !t.deletedAt && !t.completedAt && t.agentStatus !== "pending" && t.priority === q.priority,
          );
          return (
            <section
              key={q.priority}
              className="matrix-quadrant"
              style={{ "--quadrant": q.color } as React.CSSProperties}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/dida-task");
                if (id) void onCommand({type: "taskUpdate", id, patch: {priority: q.priority}, expectedVersion: null});
              }}
            >
              <div className="quadrant-heading">
                <Flag size={16} />
                <h2>{q.title}</h2>
                <span>{tasks.length}</span>
              </div>
              <p className="quadrant-subtitle">{q.subtitle}</p>
              <div className="quadrant-tasks">
                {tasks.map((t) => (
                  <div
                    key={t.id}
                    className="matrix-task"
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData("text/dida-task", t.id)
                    }
                    onClick={() => onSelectTask(t.id)}
                  >
                    <button
                      className={`task-check p${t.priority}`}
                      aria-label={`完成 ${t.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleTask(t.id);
                      }}
                    />
                    <span>{t.title}</span>
                    {t.dueDate && <small>{t.dueDate.slice(5)}</small>}
                  </div>
                ))}
                {!tasks.length && (
                  <div className="quadrant-empty">拖动任务到这里</div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function FocusView({data, focus, visible, onCommand}: {data: AppData; focus: FocusState; visible: boolean; onCommand: Command}) {
  const {mode, running, targetSeconds} = focus;
  const [displayTime, setDisplayTime] = useState(Date.now);
  const deadline = focus.deadline ? Date.parse(focus.deadline) : null;
  const remaining = Math.min(targetSeconds, Math.max(0,
    running && deadline !== null ? Math.ceil((deadline - displayTime) / 1000) : focus.remainingSeconds));
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => { if (timer !== undefined) window.clearInterval(timer); timer = undefined; };
    const sync = () => {
      stop();
      if (!visible || document.hidden || !running || deadline === null) return;
      setDisplayTime(Date.now());
      timer = window.setInterval(() => setDisplayTime(Date.now()), 1000);
    };
    // This timer only paints time. The Rust deadline owns completion and saved history.
    sync(); document.addEventListener("visibilitychange", sync);
    return () => { stop(); document.removeEventListener("visibilitychange", sync); };
  }, [visible, running, deadline]);
  const [taskId, setTaskId] = useState(focus.taskId || "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const sessionLocked = running || Boolean(focus.startedAt);
  const selectedTaskId = sessionLocked ? focus.taskId || "" : taskId;
  const activeTasks = data.tasks.filter((task) => !task.deletedAt && !task.completedAt && task.agentStatus !== "pending");
  const taskOptions = sessionLocked
    ? [{value: selectedTaskId, label: focus.title || "自由专注"}]
    : [{value: "", label: "自由专注"}, ...activeTasks.map((task) => ({value: task.id, label: task.title}))];
  useEffect(() => { setTaskId(focus.taskId || ""); }, [focus.taskId]);
  useEffect(() => {
    if (!sessionLocked && taskId && !activeTasks.some((task) => task.id === taskId)) setTaskId("");
  }, [sessionLocked, taskId, data.tasks]);
  async function control(action: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    if (!await onCommand({type: "focus", action, taskId: selectedTaskId || null})) setMessage("专注操作未保存，请重试。");
    setBusy(false);
  }
  function changeMode(next: "focus" | "break") { if (next !== mode) void control(next); }
  const todaySessions = data.focusSessions.filter(
    (s) => dayKey(new Date(s.startedAt)) === dayKey(),
  );
  const minutes = Math.floor(
    todaySessions.reduce((sum, s) => sum + s.durationSeconds, 0) / 60,
  );
  return (
    <div className="tool-view focus-view">
      <header className="view-header">
        <h1>专注</h1>
        <span className="muted">为当下留一段完整的时间</span>
      </header>
      <div className="focus-main">
        <div className="segmented focus-tabs">
          <button
            className={mode === "focus" ? "active" : ""}
            disabled={running}
            onClick={() => changeMode("focus")}
          >
            <Target size={15} />
            番茄专注
          </button>
          <button
            className={mode === "break" ? "active" : ""}
            disabled={running}
            onClick={() => changeMode("break")}
          >
            <Coffee size={15} />
            休息
          </button>
        </div>
        <CustomSelect
          className="focus-task-select"
          ariaLabel="选择专注任务"
          value={selectedTaskId}
          disabled={sessionLocked}
          options={taskOptions}
          onChange={(val) => setTaskId(String(val))}
        />
        <div
          className={`timer-dial ${running ? "running" : ""}`}
          style={
            {
              "--progress": `${(1 - remaining / Math.max(1, targetSeconds)) * 360}deg`,
            } as React.CSSProperties
          }
        >
          <div>
            <strong>
              {String(Math.floor(remaining / 60)).padStart(2, "0")}:
              {String(remaining % 60).padStart(2, "0")}
            </strong>
            <span>
              {running
                ? "保持专注，慢慢来"
                : mode === "focus"
                  ? "准备开始专注"
                  : "放松片刻"}
            </span>
          </div>
        </div>
        <div className="focus-actions">
          <button
            className="icon-button"
            title="重置计时"
            disabled={busy}
            onClick={() => void control("reset")}
          >
            <RotateCcw size={19} />
          </button>
          <button
            className="primary-button timer-start"
            disabled={busy}
            onClick={() => void control(running ? "pause" : focus.startedAt ? "resume" : "start")}
          >
            {running ? <Pause size={18} /> : <Play size={18} />}{" "}
            {running ? "暂停" : "开始"}
          </button>
        </div>
        {message && (
          <p className="focus-message" role="status">
            {message}
          </p>
        )}
        <div className="focus-summary">
          <div>
            <strong>{todaySessions.filter((s) => s.completed).length}</strong>
            <span>今日番茄</span>
          </div>
          <div>
            <strong>
              {minutes}
              <small> 分钟</small>
            </strong>
            <span>今日专注</span>
          </div>
          <div>
            <strong>
              {data.focusSessions.filter((s) => s.completed).length}
            </strong>
            <span>累计番茄</span>
          </div>
        </div>
      </div>
      <section className="focus-history">
        <h2>专注记录</h2>
        {todaySessions
          .slice()
          .reverse()
          .slice(0, 8)
          .map((s) => (
            <div key={s.id}>
              <span className="focus-history-dot" />
              <span>{s.title}</span>
              <small>
                {new Date(s.startedAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </small>
              <b>{Math.floor(s.durationSeconds / 60)} 分钟</b>
              {s.completed && <Check size={13} />}
            </div>
          ))}
        {!todaySessions.length && (
          <p className="muted">完成一次专注后，记录会出现在这里。</p>
        )}
      </section>
    </div>
  );
}

export function HabitsView({
  data,
  onCommand,
  onDraftChange,
}: {
  data: AppData;
  onCommand: Command;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🌱");
  const [goal, setGoal] = useState(1);
  const [offset, setOffset] = useState(0);
  const [menu, setMenu] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draftId = useRef("");
  const submitting = useRef(false);
  useEffect(() => { onDraftChange(creating); if (creating) draftId.current = crypto.randomUUID(); return () => onDraftChange(false); }, [creating, onDraftChange]);
  const today = dayKey();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + offset - 6 + i);
    return {
      key: dayKey(d),
      weekday: "日一二三四五六"[d.getDay()],
      day: d.getDate(),
    };
  });
  function toggle(h: Habit, date: string) {
    if (date > today) return;
    void onCommand({type: "habitRecord", id: h.id, date, value: (h.records[date] || 0) >= h.goal ? 0 : Math.min(h.goal, (h.records[date] || 0) + 1)});
  }
  function streak(h: Habit) {
    let n = 0;
    const d = new Date();
    if (!(h.records[dayKey(d)] >= h.goal)) d.setDate(d.getDate() - 1);
    for (let i = 0; i < 3660; i++) {
      if (!h.days.includes(d.getDay())) {
        d.setDate(d.getDate() - 1);
        continue;
      }
      if ((h.records[dayKey(d)] || 0) < h.goal) break;
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }
  return (
    <div className="tool-view habit-view">
      <header className="view-header">
        <h1>习惯</h1>
        <div className="header-actions">
          <button
            className="icon-button"
            title="上一周"
            onClick={() => setOffset((x) => x - 7)}
          >
            <ChevronLeft size={18} />
          </button>
          <button className="text-button" onClick={() => setOffset(0)}>
            今天
          </button>
          <button
            className="icon-button"
            title="下一周"
            disabled={offset >= 0}
            onClick={() => setOffset((x) => Math.min(0, x + 7))}
          >
            <ChevronRight size={18} />
          </button>
          <button
            className="icon-button"
            title="添加习惯"
            onClick={() => setCreating(true)}
          >
            <Plus size={20} />
          </button>
        </div>
      </header>
      <div className="habit-week-header">
        <span>日积月累，慢慢变好</span>
        {days.map((d) => (
          <div key={d.key} className={d.key === today ? "today" : ""}>
            <small>周{d.weekday}</small>
            <b>{d.day}</b>
          </div>
        ))}
      </div>
      {data.habits.map((h) => (
        <div className="habit-row" key={h.id}>
          <div className="habit-info">
            <span className="habit-emoji">{h.icon}</span>
            <div>
              <strong>{h.name}</strong>
              <small>
                连续 {streak(h)} 天 · 累计{" "}
                {Object.values(h.records).filter((n) => n >= h.goal).length} 天
              </small>
            </div>
            <div className="habit-menu">
              <button
                className="icon-button"
                title={`管理 ${h.name}`}
                onClick={() => setMenu(menu === h.id ? null : h.id)}
              >
                <MoreHorizontal size={17} />
              </button>
              {menu === h.id && (
                <div className="popover small-menu">
                  <button
                    onClick={() => {
                      void onCommand({type: "collectionDelete", collection: "habits", id: h.id});
                      setMenu(null);
                    }}
                  >
                    <Trash2 size={14} />
                    删除习惯
                  </button>
                </div>
              )}
            </div>
          </div>
          {days.map((d) => (
            <button
              key={d.key}
              className={`habit-check ${(h.records[d.key] || 0) >= h.goal ? "done" : ""}`}
              disabled={
                d.key > today ||
                !h.days.includes(new Date(d.key + "T12:00:00").getDay())
              }
              style={{ "--habit": h.color } as React.CSSProperties}
              aria-label={`${h.name} ${d.key} ${(h.records[d.key] || 0) >= h.goal ? "已完成" : "打卡"}`}
              onClick={() => toggle(h, d.key)}
            >
              {(h.records[d.key] || 0) >= h.goal ? (
                <Check size={19} />
              ) : h.goal > 1 && h.records[d.key] ? (
                `${h.records[d.key]}/${h.goal}`
              ) : (
                <span />
              )}
            </button>
          ))}
        </div>
      ))}
      {!data.habits.length && (
        <div className="large-empty">
          <div className="empty-plant">🌱</div>
          <h2>每一天，进步一点点</h2>
          <p>养成一个小习惯，让改变自然发生。</p>
          <button className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={16} />
            添加习惯
          </button>
        </div>
      )}
      {creating && (
        <div className="modal-backdrop" onMouseDown={() => setCreating(false)}>
          <form
            className="dialog habit-dialog"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim() || submitting.current) return;
              submitting.current = true; setSaving(true);
              const h: Habit = {
                id: draftId.current,
                name: name.trim(),
                icon,
                color: "#4772fa",
                goal,
                days: [0, 1, 2, 3, 4, 5, 6],
                records: {},
                createdAt: new Date().toISOString(),
              };
              try {
                if (await onCommand({type: "collectionUpsert", collection: "habits", value: h})) { setName(""); setCreating(false); }
              } finally { submitting.current = false; setSaving(false); }
            }}
          >
            <div className="dialog-header">
              <h2>添加习惯</h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setCreating(false)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              习惯名称
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="例如：读书、喝水、散步"
                required
              />
            </label>
            <div className="habit-icons">
              {["🌱", "📖", "💧", "🏃", "🧘", "✍️", "🌙", "💪"].map((i) => (
                <button
                  type="button"
                  key={i}
                  className={i === icon ? "selected" : ""}
                  onClick={() => setIcon(i)}
                >
                  {i}
                </button>
              ))}
            </div>
            <label>
              每日目标次数
              <input
                type="number"
                min={1}
                max={100}
                value={goal}
                onChange={(e) =>
                  setGoal(Math.max(1, Math.min(100, Number(e.target.value))))
                }
              />
            </label>
            <div className="dialog-footer">
              <button
                className="text-button"
                type="button"
                onClick={() => setCreating(false)}
              >
                取消
              </button>
              <button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "创建"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

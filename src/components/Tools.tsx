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
import type { AppData, Habit, Priority, Task } from "../model";
import { CustomSelect } from "../App";

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
type Update = (fn: (data: AppData) => AppData) => void;

export function MatrixView({
  data,
  onSelectTask,
  onToggleTask,
  onUpdate,
}: {
  data: AppData;
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => void;
  onUpdate: Update;
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
            (t) => !t.deletedAt && !t.completedAt && t.priority === q.priority,
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
                if (id)
                  onUpdate((s) => ({
                    ...s,
                    tasks: s.tasks.map((t) =>
                      t.id === id
                        ? {
                            ...t,
                            priority: q.priority,
                            updatedAt: new Date().toISOString(),
                          }
                        : t,
                    ),
                  }));
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

export function FocusView({
  data,
  onUpdate,
}: {
  data: AppData;
  onUpdate: Update;
}) {
  const [mode, setMode] = useState<"focus" | "break">("focus");
  const duration = () =>
    60 *
    (mode === "focus"
      ? data.settings.pomodoroMinutes
      : data.settings.breakMinutes);
  const [remaining, setRemaining] = useState(duration);
  const [running, setRunning] = useState(false);
  const sessionDuration = useRef(duration());
  const [taskId, setTaskId] = useState("");
  const [message, setMessage] = useState("");
  const deadline = useRef(0);
  const start = useRef<Date | null>(null);
  const elapsed = useRef(0);
  const activeTasks = data.tasks.filter((t) => !t.deletedAt && !t.completedAt);
  function saveSession(completed: boolean, seconds: number) {
    if (mode !== "focus" || seconds < 1) return;
    const endedAt = new Date();
    onUpdate((s) => ({
      ...s,
      focusSessions: [
        ...s.focusSessions,
        {
          id: crypto.randomUUID(),
          taskId: taskId || null,
          title: s.tasks.find((t) => t.id === taskId)?.title || "自由专注",
          startedAt: (
            start.current || new Date(endedAt.getTime() - seconds * 1000)
          ).toISOString(),
          endedAt: endedAt.toISOString(),
          durationSeconds: Math.round(seconds),
          completed,
        },
      ],
    }));
  }
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      const left = Math.max(
        0,
        Math.ceil((deadline.current - Date.now()) / 1000),
      );
      setRemaining(left);
      if (left === 0) {
        setRunning(false);
        saveSession(true, sessionDuration.current);
        elapsed.current = 0;
        start.current = null;
        setMessage(
          mode === "focus"
            ? "本次专注已完成，休息一下吧。"
            : "休息结束，准备好开始了吗？",
        );
        if (data.settings.sound) {
          try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            gain.gain.setValueAtTime(0.08, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(
              0.001,
              ctx.currentTime + 0.7,
            );
            osc.frequency.value = 660;
            osc.start();
            osc.stop(ctx.currentTime + 0.7);
            osc.onended = () => void ctx.close();
          } catch {
            /* A notification remains visible if audio is unavailable. */
          }
        }
        if (data.settings.notifications && window.didaLocal)
          void window.didaLocal.notify(
            "DitaList",
            mode === "focus" ? "专注已完成，休息一下吧。" : "休息结束。",
          );
      }
    }, 200);
    return () => clearInterval(interval);
  }, [
    running,
    mode,
    data.settings.pomodoroMinutes,
    data.settings.breakMinutes,
    data.settings.sound,
    data.settings.notifications,
    taskId,
  ]);
  useEffect(() => {
    if (!running && !start.current) {
      sessionDuration.current = duration();
      setRemaining(sessionDuration.current);
      elapsed.current = 0;
    }
  }, [mode, data.settings.pomodoroMinutes, data.settings.breakMinutes]);
  function changeMode(next: "focus" | "break") {
    if (next === mode) return;
    if (start.current && remaining < sessionDuration.current)
      saveSession(false, sessionDuration.current - remaining);
    setRunning(false);
    elapsed.current = 0;
    start.current = null;
    setMode(next);
  }
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
          value={taskId}
          disabled={running}
          options={[
            { value: "", label: "自由专注" },
            ...activeTasks.map((t) => ({ value: t.id, label: t.title })),
          ]}
          onChange={(val) => setTaskId(String(val))}
        />
        <div
          className={`timer-dial ${running ? "running" : ""}`}
          style={
            {
              "--progress": `${(1 - remaining / sessionDuration.current) * 360}deg`,
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
            onClick={() => {
              if (running || elapsed.current) {
                saveSession(false, sessionDuration.current - remaining);
              }
              setRunning(false);
              sessionDuration.current = duration();
              setRemaining(sessionDuration.current);
              elapsed.current = 0;
              start.current = null;
              setMessage("");
            }}
          >
            <RotateCcw size={19} />
          </button>
          <button
            className="primary-button timer-start"
            onClick={() => {
              if (running) {
                elapsed.current = sessionDuration.current - remaining;
                setRunning(false);
              } else {
                if (!start.current) {
                  sessionDuration.current = duration();
                  setRemaining(sessionDuration.current);
                }
                const secs = start.current
                  ? remaining
                  : sessionDuration.current;
                deadline.current = Date.now() + secs * 1000;
                if (!start.current) start.current = new Date();
                setRunning(true);
                setMessage("");
              }
            }}
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
  onUpdate,
}: {
  data: AppData;
  onUpdate: Update;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🌱");
  const [goal, setGoal] = useState(1);
  const [offset, setOffset] = useState(0);
  const [menu, setMenu] = useState<string | null>(null);
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
    onUpdate((s) => ({
      ...s,
      habits: s.habits.map((x) =>
        x.id === h.id
          ? {
              ...x,
              records: {
                ...x.records,
                [date]:
                  (x.records[date] || 0) >= x.goal
                    ? 0
                    : Math.min(x.goal, (x.records[date] || 0) + 1),
              },
            }
          : x,
      ),
    }));
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
                      onUpdate((s) => ({
                        ...s,
                        habits: s.habits.filter((x) => x.id !== h.id),
                      }));
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
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              const h: Habit = {
                id: crypto.randomUUID(),
                name: name.trim(),
                icon,
                color: "#4772fa",
                goal,
                days: [0, 1, 2, 3, 4, 5, 6],
                records: {},
                createdAt: new Date().toISOString(),
              };
              onUpdate((s) => ({ ...s, habits: [...s.habits, h] }));
              setName("");
              setCreating(false);
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
              <button className="primary-button">创建</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

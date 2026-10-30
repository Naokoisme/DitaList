import { useEffect, useRef, useState } from "react";
import { ListFilter, X } from "lucide-react";
import { addDays, localDate } from "../core/domain";
import {
  createTaskViewFilter,
  describeTaskViewFilter,
  getTaskViewFilterError,
  hasTaskViewFilter,
  type TaskViewFilter,
} from "../core/task-filter";
import AnchoredPopover from "./AnchoredPopover";
import CustomDateInput from "./CustomDateInput";
import "../task-filter.css";

type TaskFilterControlProps = {
  value: TaskViewFilter;
  onChange: (filter: TaskViewFilter) => void;
  defaultShowCompleted: boolean;
  completedOnly?: boolean;
};

export default function TaskFilterControl({
  value,
  onChange,
  defaultShowCompleted,
  completedOnly = false,
}: TaskFilterControlProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TaskViewFilter>(value);
  const anchorRef = useRef<HTMLDivElement>(null);
  const defaults = createTaskViewFilter(defaultShowCompleted);
  const effectiveValue = completedOnly ? { ...value, status: "completed" as const } : value;
  // The completed page's required status is not an additional filter.
  const active = hasTaskViewFilter(
    completedOnly ? { ...effectiveValue, status: defaults.status } : effectiveValue,
    defaultShowCompleted,
  );
  const summary = describeTaskViewFilter(effectiveValue);
  const error = getTaskViewFilterError(draft);
  const hasRange = Boolean(draft.from || draft.to);
  const completedDate = draft.dateField === "completed";
  const statusLocked = completedOnly || completedDate;
  const today = localDate();
  const [year, month] = today.split("-").map(Number);
  const presets = [
    { label: "全部日期", from: "", to: "" },
    { label: "今天", from: today, to: today },
    {
      label: completedDate ? "近7天" : "未来7天",
      from: completedDate ? addDays(today, -6) : today,
      to: completedDate ? today : addDays(today, 6),
    },
    {
      label: "本月",
      from: localDate(new Date(year, month - 1, 1, 12)),
      to: localDate(new Date(year, month, 0, 12)),
    },
  ];

  useEffect(() => setOpen(false), [completedOnly]);

  const changeBound = (field: "from" | "to", date: string) => {
    setDraft((previous) => {
      const next = { ...previous, [field]: date };
      if (!next.from && !next.to) next.includeUndated = false;
      return next;
    });
  };
  const reset = () => {
    const next = {
      ...defaults,
      status: completedOnly ? "completed" as const : defaults.status,
    };
    setDraft(next);
    onChange(next);
  };

  return (
    <div className="task-filter-control" ref={anchorRef}>
      <button
        type="button"
        className={`icon-button task-filter-trigger ${active ? "is-active" : ""}`}
        aria-label={active ? `任务筛选，${summary}` : "任务筛选"}
        title={active ? `任务筛选 · ${summary}` : "任务筛选"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) setOpen(false);
          else {
            setDraft({ ...effectiveValue });
            setOpen(true);
          }
        }}
      >
        <ListFilter size={17} />
        {active && <span className="task-filter-indicator" aria-hidden="true" />}
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={anchorRef}
          className="task-filter-panel"
          role="dialog"
          ariaLabel="任务筛选"
          alignRight
          maxHeight={620}
          onClose={() => setOpen(false)}
        >
          <form
            className="task-filter-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (error) return;
              onChange({
                ...draft,
                status: statusLocked ? "completed" : draft.status,
                includeUndated: !completedDate && hasRange && draft.includeUndated,
              });
              setOpen(false);
            }}
          >
            <div className="task-filter-heading">
              <strong>任务筛选</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="取消筛选修改"
                title="取消"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <p className="task-filter-help">在当前视图的任务中筛选。</p>
            <fieldset className="task-filter-field">
              <legend>按哪种日期筛选</legend>
              <div className="task-filter-segments">
                {([
                  ["task", "任务日期"],
                  ["completed", "完成日期"],
                ] as const).map(([dateField, label]) => (
                  <button
                    type="button"
                    key={dateField}
                    className={draft.dateField === dateField ? "is-selected" : ""}
                    aria-pressed={draft.dateField === dateField}
                    onClick={() => setDraft((previous) => ({
                      ...previous,
                      dateField,
                      status: dateField === "completed" ? "completed" : previous.status,
                      includeUndated: dateField === "completed" ? false : previous.includeUndated,
                    }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="task-filter-presets" aria-label="快捷日期范围">
              {presets.map((preset) => (
                <button
                  type="button"
                  key={preset.label}
                  className={draft.from === preset.from && draft.to === preset.to ? "is-selected" : ""}
                  title={preset.from ? `${preset.from} 至 ${preset.to}` : "不限制日期"}
                  onClick={() => setDraft((previous) => ({
                    ...previous,
                    from: preset.from,
                    to: preset.to,
                    includeUndated: Boolean(preset.from || preset.to) && previous.includeUndated,
                  }))}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="task-filter-dates">
              <div className="task-filter-date-field">
                <span>开始日期</span>
                <CustomDateInput
                  value={draft.from}
                  onChange={(date) => changeBound("from", date)}
                  ariaLabel="筛选开始日期"
                  placeholder="不限开始"
                />
              </div>
              <span className="task-filter-date-separator" aria-hidden="true">—</span>
              <div className="task-filter-date-field">
                <span>结束日期</span>
                <CustomDateInput
                  value={draft.to}
                  onChange={(date) => changeBound("to", date)}
                  ariaLabel="筛选结束日期"
                  placeholder="不限结束"
                />
              </div>
            </div>
            {error ? (
              <p className="task-filter-error" role="alert">{error}</p>
            ) : (
              <p className="task-filter-help">
                {completedDate
                  ? "按本机日期查找完成记录，包含起止当天。"
                  : "日期范围包含起止当天，多日任务有重合即可显示。"}
              </p>
            )}
            {!completedDate && hasRange && (
              <label className="task-filter-undated">
                <input
                  type="checkbox"
                  checked={draft.includeUndated}
                  onChange={(event) => {
                    const includeUndated = event.target.checked;
                    setDraft((previous) => ({ ...previous, includeUndated }));
                  }}
                />
                <span>同时包含无日期任务</span>
              </label>
            )}
            <fieldset className="task-filter-field">
              <legend>完成状态</legend>
              <div className="task-filter-segments">
                {([
                  ["all", "全部"],
                  ["open", "未完成"],
                  ["completed", "已完成"],
                ] as const).map(([status, label]) => (
                  <button
                    type="button"
                    key={status}
                    className={draft.status === status ? "is-selected" : ""}
                    aria-pressed={draft.status === status}
                    disabled={statusLocked && status !== "completed"}
                    onClick={() => setDraft((previous) => ({ ...previous, status }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {statusLocked && (
                <p className="task-filter-help">
                  {completedDate ? "按完成日期筛选时，只显示已完成任务。" : "此视图只显示已完成任务。"}
                </p>
              )}
            </fieldset>
            <div className="task-filter-actions">
              <button type="button" className="text-button" onClick={reset}>
                清除筛选
              </button>
              <button type="submit" className="primary-button" disabled={Boolean(error)}>
                应用
              </button>
            </div>
          </form>
        </AnchoredPopover>
      )}
    </div>
  );
}

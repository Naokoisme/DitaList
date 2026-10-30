import type { Task } from "../model";
import { isDate, localDate } from "./domain";

export type TaskViewFilter = {
  dateField: "task" | "completed";
  from: string;
  to: string;
  status: "all" | "open" | "completed";
  includeUndated: boolean;
};

export function createTaskViewFilter(showCompleted: boolean): TaskViewFilter {
  return {
    dateField: "task",
    from: "",
    to: "",
    status: showCompleted ? "all" : "open",
    includeUndated: false,
  };
}

export function getTaskViewFilterError(filter: TaskViewFilter): string | null {
  if (filter.from && !isDate(filter.from))
    return "请输入有效的开始日期（YYYY-MM-DD）。";
  if (filter.to && !isDate(filter.to))
    return "请输入有效的结束日期（YYYY-MM-DD）。";
  if (filter.from && filter.to && filter.from > filter.to)
    return "开始日期不能晚于结束日期。";
  return null;
}

export function matchesTaskViewFilter(
  task: Task,
  filter: TaskViewFilter,
): boolean {
  // Tasks are validated by domain; the control validates the filter before applying it.
  const completed = Boolean(task.completedAt);
  if (filter.status === "open" && completed) return false;
  if (filter.status === "completed" && !completed) return false;

  let start: string | null;
  let end: string | null;
  if (filter.dateField === "completed") {
    if (!task.completedAt) return false;
    const completedAt = new Date(task.completedAt);
    start = end = localDate(completedAt);
  } else {
    start = task.startDate || task.dueDate;
    end = task.dueDate || task.startDate;
  }

  if (!filter.from && !filter.to) return true;
  if (!start || !end)
    return filter.dateField === "task" && filter.includeUndated;

  // Dates are inclusive; a multi-day task matches any overlapping selected day.
  return (!filter.from || end >= filter.from) &&
    (!filter.to || start <= filter.to);
}

export function hasTaskViewFilter(
  filter: TaskViewFilter,
  defaultShowCompleted: boolean,
): boolean {
  const defaults = createTaskViewFilter(defaultShowCompleted);
  return filter.dateField !== defaults.dateField ||
    filter.from !== defaults.from ||
    filter.to !== defaults.to ||
    filter.status !== defaults.status ||
    filter.includeUndated !== defaults.includeUndated;
}

export function describeTaskViewFilter(filter: TaskViewFilter): string {
  const error = getTaskViewFilterError(filter);
  if (error) return error;
  const field = filter.dateField === "completed" ? "完成日期" : "任务日期";
  const range = filter.from && filter.to
    ? filter.from === filter.to ? filter.from : `${filter.from} 至 ${filter.to}`
    : filter.from ? `${filter.from} 起`
      : filter.to ? `截至 ${filter.to}` : "全部日期";
  const status = filter.dateField === "completed" || filter.status === "completed"
    ? "已完成" : filter.status === "open" ? "未完成" : "全部状态";
  const undated = filter.dateField === "task" &&
    (filter.from || filter.to) && filter.includeUndated
    ? "；含无日期任务" : "";
  return `${field}：${range}；${status}${undated}`;
}

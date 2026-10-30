import { addDays, isDate, isInDateView, localDate } from "../core/domain";

export default function TaskDateHint({ date }: { date: string | null }) {
  if (!date)
    return <p className="task-date-hint">未设日期，可在所属清单查看</p>;
  if (!isDate(date)) return null;

  const today = localDate();
  const inToday = isInDateView(date, "today", today);
  const inNext7 = isInDateView(date, "next7", today);
  if (!inNext7)
    return (
      <p className="task-date-hint">较晚的任务，可在清单和日历查看</p>
    );

  const relative =
    date < today ? "已过期" : date === addDays(today, 1) ? "明天" : null;

  return (
    <p className="task-date-hint" aria-live="polite">
      {relative && <span className="task-date-relative">{relative}</span>}
      <span>将显示在</span>
      {inToday && <span className="task-date-view">今天</span>}
      <span className="task-date-view">最近7天</span>
    </p>
  );
}

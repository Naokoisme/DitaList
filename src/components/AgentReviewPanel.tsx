import { useState } from "react";
import { Bot, Check, X } from "lucide-react";
import type { CommandReceipt, Operation } from "../generated/contracts";
import type { Snapshot } from "../core/client";

const fieldLabels: Record<string, string> = {title: "标题", content: "描述", listId: "清单", startDate: "开始日期", dueDate: "截止日期", time: "开始时间", endTime: "结束时间", priority: "优先级", tags: "标签", pinned: "置顶", repeat: "重复", reminder: "提醒"};
function display(value: unknown, field: string, snapshot: Snapshot): string {
  if (value == null) return "未设置";
  if (field === "priority") return ["无优先级", "高优先级", "中优先级", "低优先级"][Number(value)] || String(value);
  if (field === "listId") return snapshot.data.lists.find((list) => list.id === value)?.name || String(value);
  if (field === "subtasks" && Array.isArray(value)) return value.map((item) => `${item.completed ? "已完成" : "未完成"}：${item.title}`).join("；") || "无";
  return Array.isArray(value) ? value.join("、") || "无" : typeof value === "boolean" ? value ? "是" : "否" : String(value);
}

export default function AgentReviewPanel({snapshot, onClose, onCommand}: {
  snapshot: Snapshot; onClose: () => void; onCommand: (operation: Operation) => Promise<CommandReceipt | null>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const creates = snapshot.data.tasks.filter((task) => task.createdBy === "agent" && task.agentStatus === "pending" && !task.deletedAt);
  const changes = snapshot.approvals.filter((approval) => approval.status === "pending");
  const ids = [...creates.map((task) => task.id), ...changes.map((approval) => approval.id)];
  const toggle = (id: string) => setSelected((before) => { const next = new Set(before); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  async function review(targets: string[], approved: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    for (const id of targets) {
      if (!await onCommand({type: approved ? "agentApprove" : "agentReject", id})) {
        setError("这项申请未能处理。目标任务可能已变化或删除，请核对内容后重试。"); break;
      }
      setSelected((before) => { const next = new Set(before); next.delete(id); return next; });
    }
    setBusy(false);
  }
  const actions = (id: string) => <div className="agent-review-actions"><button disabled={busy} className="agent-review-approve" onClick={() => void review([id], true)}><Check size={15}/>批准</button><button disabled={busy} className="agent-review-reject" onClick={() => void review([id], false)}><X size={15}/>拒绝</button></div>;
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="dialog agent-review-dialog" role="dialog" aria-modal="true" aria-label="Agent 待确认" onMouseDown={(event) => event.stopPropagation()}>
    <div className="dialog-header"><div><h2><Bot size={20}/>Agent 待确认 <span className="agent-review-count">{ids.length}</span></h2><p className="agent-review-note">新增和修改在批准后生效；查看不会自动批准。</p></div><button className="icon-button" aria-label="关闭审核" onClick={onClose}><X size={19}/></button></div>
    <div className="agent-review-list">
      {creates.map((task) => <article className="agent-review-item" key={task.id}><input type="checkbox" aria-label={`选择 ${task.title}`} checked={selected.has(task.id)} onChange={() => toggle(task.id)}/><div className="agent-review-body"><small>新增任务</small><h3>{task.title}</h3>{task.content && <p className="agent-review-desc">{task.content}</p>}<p className="agent-review-note">{snapshot.data.lists.find((list) => list.id === task.listId)?.name} · {task.dueDate || "无日期"} {task.time || ""}</p></div>{actions(task.id)}</article>)}
      {changes.map((approval) => {
        const task = snapshot.data.tasks.find((item) => item.id === approval.taskId);
        const conflict = !task || !!task.deletedAt || snapshot.entityVersions[approval.taskId] !== approval.baseVersion;
        const patch = approval.patch as Record<string, unknown>;
        return <article className="agent-review-item" key={approval.id}><input type="checkbox" aria-label={`选择修改 ${task?.title || approval.taskId}`} checked={selected.has(approval.id)} onChange={() => toggle(approval.id)}/><div className="agent-review-body"><small>修改任务</small><h3>{task?.title || "任务已不存在"}</h3>{conflict && <p className="inline-error">原任务已变化，请核对并让 Agent 重新提交修改。</p>}<dl className="approval-diff">{Object.entries(patch).map(([field, value]) => <div key={field}><dt>{fieldLabels[field] || field}</dt><dd><del>{display(task ? (task as unknown as Record<string, unknown>)[field] : null, field, snapshot)}</del><span>→</span><ins>{display(value, field, snapshot)}</ins></dd></div>)}</dl></div>{actions(approval.id)}</article>;
      })}
      {!ids.length && <p className="large-empty">没有待确认事项。</p>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="dialog-footer"><label><input type="checkbox" checked={ids.length > 0 && ids.every((id) => selected.has(id))} onChange={(event) => setSelected(new Set(event.target.checked ? ids : []))}/>全选</label><button className="text-button" onClick={onClose}>关闭</button><button className="primary-button" disabled={busy || !ids.some((id) => selected.has(id))} onClick={() => void review(ids.filter((id) => selected.has(id)), true)}>批准选中</button></div>
  </section></div>;
}

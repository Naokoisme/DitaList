import { useEffect, useState } from "react";
import { Bot, Copy, RefreshCw } from "lucide-react";
import type { CommandReceipt, McpInfo, Operation } from "../generated/contracts";
import { errorMessage, getMcpInfo, mcpConfiguration, watchMcp, type Snapshot } from "../core/client";

export default function McpSettings({ snapshot, onCommand }: {
  snapshot: Snapshot;
  onCommand: (operation: Operation) => Promise<CommandReceipt | null>;
}) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let changed = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const unsubscribe = await watchMcp((next) => { changed = true; if (active) setInfo(next); });
      if (!active) { unsubscribe(); return; }
      cleanup = unsubscribe;
      const next = await getMcpInfo();
      if (active && !changed) setInfo(next);
    })().catch((error) => { if (active) setNotice(errorMessage(error)); });
    return () => { active = false; cleanup?.(); };
  }, []);
  const closing = info?.state === "closing";
  const closingFailed = info?.state === "closing_failed";
  const stateLabel = closing ? "正在关闭" : closingFailed ? "关闭失败，等待重试" : info?.state === "open" ? "已开启" : info?.state === "error" ? "连接异常" : "已关闭";
  async function setChannel(enabled: boolean) {
    setBusy(true);
    try {
      const receipt = await onCommand({type: "preferencesUpdate", patch: {mcpEnabled: enabled}});
      if (!receipt) setNotice("通道设置未保存，请重试。");
      else setNotice("");
      setInfo(await getMcpInfo());
    } catch (error) { setNotice(errorMessage(error)); }
    finally { setBusy(false); }
  }
  const config = info ? mcpConfiguration(info) : "正在读取连接程序位置…";
  const instructions = `# DitaList MCP 配置\n\n将下面配置添加到支持本机 stdio 的 Agent 客户端。连接程序会自动找到正在运行的 DitaList，不需要固定端口。\n\n${config}\n\n- 在 DitaList 中开启 MCP 后才可读写；关闭后已保存的申请继续保留。\n- 创建和修改先进入待确认，只有用户在 DitaList 中批准才生效。\n- 删除进入回收站，Agent 无权永久删除或批准申请。\n- 写入时提供业务 requestId；同一操作重试必须复用原号。\n- 结果不明确时用 dida_list_get_request 查询原请求，不能更换编号重复创建。`;
  return <>
    <div className="data-status"><Bot size={23}/><div><strong>Agent / MCP</strong><p>按需开启，连接程序自动寻找 DitaList。</p></div></div>
    <label className="setting-row"><span><strong>MCP 通道</strong><small>{stateLabel} · 首次默认关闭，记住你的选择</small></span><input type="checkbox" checked={snapshot.preferences.mcpEnabled} disabled={busy || closing || closingFailed} onChange={(event) => void setChannel(event.target.checked)}/></label>
    {closing && <p className="setting-caption" role="status">正在保存已受理的请求和回执，完成后关闭连接。</p>}
    {closingFailed && <div className="inline-error" role="alert"><p>关闭时未能保存，通道继续阻止新请求。请重试完成关闭。</p><button className="text-button" disabled={busy} onClick={() => void setChannel(false)}>重试关闭</button></div>}
    <div className="agent-doc-header"><div className="setting-subheading">本机 stdio 配置</div><button className="agent-doc-copy-btn" disabled={!info} onClick={async () => {
      try { await navigator.clipboard.writeText(config); setNotice("配置已复制。"); } catch (error) { setNotice(errorMessage(error)); }
    }}><Copy size={14}/>复制配置</button></div>
    <pre className="mcp-config">{config}</pre>
    <div className="backup-actions"><button disabled={!info} onClick={async () => {
      try { await navigator.clipboard.writeText(instructions); setNotice("完整配置说明已复制，可粘贴给 Agent。"); } catch (error) { setNotice(errorMessage(error)); }
    }}><Copy size={18}/><span><strong>复制给 Agent 的完整说明</strong><small>包含配置、权限和请求重试规则</small></span></button><button onClick={async () => {
      try { setInfo(await getMcpInfo()); setNotice("已刷新连接状态。"); } catch (error) { setNotice(errorMessage(error)); }
    }}><RefreshCw size={18}/><span><strong>刷新状态</strong><small>核对本机连接程序与通道状态</small></span></button></div>
    {notice && <p className="setting-caption" role="status">{notice}</p>}
    <details className="mcp-diagnostics"><summary>连接诊断</summary><p>联系文件：{info?.contactPath || "尚未加载"}</p><p>当前本地地址：{info?.address || "未监听"}</p></details>
  </>;
}

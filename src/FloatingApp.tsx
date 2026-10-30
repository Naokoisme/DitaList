import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, GripVertical, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import type { QuickDraft } from "./generated/contracts";
import { desktopAction, errorMessage, executeOperation, getDraft, getRequest, setDraft, watchCore, type Snapshot } from "./core/client";

export default function FloatingApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const [sending, setSending] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [width, setWidth] = useState(420);
  const [height, setHeight] = useState(24);
  const [exitPending, setExitPending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const current = useRef<QuickDraft>({text: "", requestId: null});
  const writes = useRef<Promise<void>>(Promise.resolve());
  const composing = useRef(false);
  const deferredClose = useRef(false);
  const closing = useRef(false);
  const submission = useRef<Promise<unknown> | null>(null);
  const exitRequested = useRef(false);
  const exitSequence = useRef(0);
  const gripStart = useRef<{pointerId: number; x: number; y: number} | null>(null);

  function saveDraft(draft = current.current) {
    const copy = {...draft};
    writes.current = writes.current.catch(() => {}).then(() => setDraft(copy));
    return writes.current;
  }
  async function collapse(view?: string) {
    if (exitRequested.current) return;
    if (composing.current) { deferredClose.current = true; return; }
    if (closing.current) return;
    closing.current = true;
    try {
      await saveDraft();
      if (submission.current) await submission.current.catch(() => {});
      await writes.current;
      await desktopAction("closeQuick");
      if (view) await desktopAction("openMain", {view});
    } catch (error) { setHint(errorMessage(error)); closing.current = false; }
  }
  async function prepareExit() {
    exitRequested.current = true;
    if (composing.current) return;
    const sequence = ++exitSequence.current;
    setExitPending(true);
    try {
      if (submission.current) await submission.current;
      if (current.current.requestId) {
        const receipt = await getRequest(current.current.requestId);
        if (!receipt) throw new Error("上次提交尚未确认，请先重试，再退出应用。");
        current.current = {text: "", requestId: null}; setText(""); setUnresolved(false);
      }
      await saveDraft();
      await writes.current;
      if (sequence !== exitSequence.current) return;
      await desktopAction("exitReady", {window: "quick", ready: true});
    } catch (error) {
      if (sequence !== exitSequence.current) return;
      exitRequested.current = false; setExitPending(false); setHint(errorMessage(error));
      await desktopAction("exitReady", {window: "quick", ready: false}).catch(() => {});
    }
  }
  useEffect(() => {
    let active = true;
    const cleanups: (() => void)[] = [];
    const keep = (cleanup: () => void) => active ? cleanups.push(cleanup) : cleanup();
    void (async () => {
      keep(await listen<{window: string}>("desktop://prepare-close", ({payload}) => {
        if (payload.window === "quick") void collapse();
      }));
      keep(await listen<{window: string}>("desktop://prepare-exit", ({payload}) => {
        if (payload.window === "quick") void prepareExit();
      }));
      keep(await listen("desktop://exit-cancelled", () => {
        exitSequence.current += 1; exitRequested.current = false; setExitPending(false);
      }));
      keep(await watchCore((next) => { if (active) setSnapshot(next); }, (error) => { if (active) setHint(errorMessage(error)); }));
      const draft = await getDraft();
      if (!active) return;
      current.current = draft;
      setText(draft.text);
      if (draft.requestId) {
        const receipt = await getRequest(draft.requestId);
        if (receipt) {
          current.current = {text: "", requestId: null}; setText(""); await saveDraft();
          setHint("上次提交已保存。");
        } else { setUnresolved(true); setHint("上次提交尚未确认，请用原请求重试。"); }
      }
      await desktopAction("ready", {window: "quick"});
      if (active) input.current?.focus();
    })().catch((error) => { if (active) setHint(errorMessage(error)); });
    return () => { active = false; cleanups.forEach((cleanup) => cleanup()); };
  }, []);
  useEffect(() => {
    document.body.inert = exitPending;
    return () => { document.body.inert = false; };
  }, [exitPending]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const theme = snapshot?.data.settings.theme || "system";
      document.documentElement.dataset.theme = theme === "dark" || (theme === "system" && media.matches) ? "dark" : "light";
      document.documentElement.style.setProperty("--accent", snapshot?.data.settings.accent || "#4772fa");
    };
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [snapshot?.data.settings.theme, snapshot?.data.settings.accent]);
  useLayoutEffect(() => {
    if (measure.current) setWidth(Math.min(560, Math.max(420, measure.current.getBoundingClientRect().width + 180)));
  }, [text]);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = "0px";
    const next = Math.min(144, Math.max(24, input.current.scrollHeight));
    input.current.style.height = `${next}px`; setHeight(next);
  }, [text, width]);
  useLayoutEffect(() => {
    void desktopAction("quickResize", {width: width + 20, height: Math.max(40, height + 16) + (hint ? 40 : 0) + 20}).catch((error) => setHint(errorMessage(error)));
  }, [width, height, hint]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (exitRequested.current || sending || submission.current || composing.current || !current.current.text.trim()) return;
    setSending(true); setHint("");
    current.current = {...current.current, requestId: current.current.requestId || crypto.randomUUID()};
    const draft = {...current.current};
    const request = (async () => {
      await saveDraft(draft);
      await executeOperation({type: "quickAdd", text: draft.text, listId: null, date: null, overrides: null}, draft.requestId!);
      current.current = {text: "", requestId: null};
      await saveDraft();
      setText(""); setUnresolved(false);
    })();
    submission.current = request;
    try {
      await request;
      setHint("已保存。");
      if (!closing.current && !exitRequested.current) await desktopAction("closeQuick");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
      if (code === "invalid_input" || code === "not_found") {
        current.current.requestId = null;
        await saveDraft().catch(() => {});
        setUnresolved(false);
      } else setUnresolved(true);
      setHint(errorMessage(error));
    } finally { submission.current = null; setSending(false); }
  }
  return <main className="floating-shell" style={{width}} onKeyDown={(event) => {
    if (event.key === "Escape" && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); void collapse(); }
  }}>
    <form className="floating-form" onSubmit={submit}>
      <button type="button" className="floating-grip" aria-label="拖动悬浮栏" title="拖动悬浮栏" onPointerDown={(event) => {
        if (event.button !== 0 || composing.current || submission.current || exitRequested.current) return;
        // Keep a click on the grip from taking the input focus or ending editing.
        event.preventDefault();
        gripStart.current = {pointerId: event.pointerId, x: event.clientX, y: event.clientY};
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={(event) => {
        const start = gripStart.current;
        if (!start || start.pointerId !== event.pointerId || (Math.abs(event.clientX - start.x) < 4 && Math.abs(event.clientY - start.y) < 4)) return;
        gripStart.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        void (async () => {
          try { await saveDraft(); await desktopAction("quickDrag"); } catch (error) { setHint(errorMessage(error)); }
        })();
      }} onPointerUp={() => { gripStart.current = null; }} onPointerCancel={() => { gripStart.current = null; }} onLostPointerCapture={() => {
        gripStart.current = null;
      }}><GripVertical size={16}/></button>
      <button type="button" className="floating-today" title="查看今天待办（含逾期）" onClick={() => void collapse("today")}>今天 <b>{(snapshot?.todayCount || 0) > 99 ? "99+" : snapshot?.todayCount || 0}</b></button>
      <textarea ref={input} value={text} rows={1} maxLength={10000} style={{height}} aria-label="快速添加任务" placeholder="记下一件事…" readOnly={sending || unresolved}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => {
          composing.current = false;
          if (exitRequested.current) setTimeout(() => { if (exitRequested.current) void prepareExit(); }, 0);
          else if (deferredClose.current) { deferredClose.current = false; setTimeout(() => void collapse(), 0); }
        }}
        onChange={(event) => {
          const value = event.target.value;
          current.current = {text: value, requestId: null}; setText(value); setHint("");
          void saveDraft().catch((error) => setHint(errorMessage(error)));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }}/>
      <button className="floating-add" type="submit" aria-label={unresolved ? "重试上次提交" : "添加任务"} title={unresolved ? "使用原请求号重试" : "添加任务（Enter）"} disabled={sending || !text.trim()}><ArrowUp size={18}/></button>
      <button type="button" className="floating-close" aria-label="收起输入" title="收起，保留草稿" onClick={() => void collapse()}><X size={15}/></button>
    </form>
    {hint && <div className="floating-hint" role="status">{sending ? "正在保存…" : hint}</div>}
    <span className="floating-measure" ref={measure} aria-hidden="true">{text.split("\n").reduce((longest, line) => line.length > longest.length ? line : longest, "") || "记下一件事…"}</span>
  </main>;
}

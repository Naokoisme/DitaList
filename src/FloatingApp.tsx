import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ArrowUpRight, Check } from "lucide-react";
import type { FloatingState } from "./model";

const initialState: FloatingState = {
  theme: "light", accent: "#4772fa", todayCount: 0, hasReminder: false, expanded: false, anchorX: "right", anchorY: "bottom",
};
const motionDuration = 220;

export default function FloatingApp() {
  const [state, setState] = useState(initialState);
  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const [sending, setSending] = useState(false);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [saved, setSaved] = useState(false);
  const [panelWidth, setPanelWidth] = useState(320);
  const [inputHeight, setInputHeight] = useState(24);
  const input = useRef<HTMLTextAreaElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const nativeSize = useRef({ width: 68, height: 68 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const successTimer = useRef<number | undefined>(undefined);
  const { expanded } = state;
  const panelHeight = Math.max(48, inputHeight + 24) + (hint ? 42 : 0);

  useEffect(() => {
    const bridge = window.didaLocal;
    if (!bridge?.getFloatingState) return;
    let canceled = false;
    let received = false;
    const unsubscribe = bridge.onFloatingStateChanged((next) => {
      received = true;
      if (!canceled) setState(next);
    });
    void bridge.getFloatingState().then((next) => {
      if (!canceled && !received) setState(next);
    }).catch(() => { if (!canceled) setHint("无法读取悬浮球状态，请重新打开。"); });
    return () => { canceled = true; unsubscribe(); window.clearTimeout(successTimer.current); };
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      document.documentElement.dataset.theme = state.theme === "dark" ||
        (state.theme === "system" && media.matches) ? "dark" : "light";
      document.documentElement.style.setProperty("--accent", state.accent);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [state.theme, state.accent]);

  useLayoutEffect(() => {
    if (!expanded || !measure.current) return;
    setPanelWidth(Math.min(560, Math.max(320, Math.ceil(measure.current.getBoundingClientRect().width) + 112)));
  }, [text, expanded]);

  useLayoutEffect(() => {
    if (!expanded || !input.current) return;
    input.current.style.height = "0px";
    const height = Math.max(24, Math.min(144, input.current.scrollHeight));
    input.current.style.height = `${height}px`;
    setInputHeight(height);
  }, [text, panelWidth, expanded]);

  useLayoutEffect(() => {
    const width = expanded ? panelWidth + 20 : 68;
    const height = expanded ? panelHeight + 20 : 68;
    const resize = () => {
      window.didaLocal?.resizeFloating(width, height);
      nativeSize.current = { width, height };
    };
    // Grow the transparent host before the CSS transition, then shrink it after the content settles.
    if (width >= nativeSize.current.width && height >= nativeSize.current.height) resize();
    else {
      window.didaLocal?.resizeFloating(Math.max(width, nativeSize.current.width), Math.max(height, nativeSize.current.height));
      const timer = window.setTimeout(resize, motionDuration);
      return () => window.clearTimeout(timer);
    }
  }, [expanded, panelWidth, panelHeight]);

  useEffect(() => {
    if (!expanded) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [expanded]);

  function expand(value: boolean) {
    setState((current) => ({ ...current, expanded: value }));
    window.didaLocal?.setFloatingExpanded(value);
    if (!needsCheck) setHint("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending || needsCheck) return;
    const value = text.trim();
    if (!value) { input.current?.focus(); return; }
    if (!window.didaLocal) { setHint("请从 DitaList 桌面程序添加任务。"); return; }
    setSending(true);
    setHint("");
    try {
      await window.didaLocal.submitQuickAdd(value);
      setText("");
      setSaved(true);
      expand(false);
      window.clearTimeout(successTimer.current);
      successTimer.current = window.setTimeout(() => setSaved(false), 1100);
    } catch (error) {
      setNeedsCheck(true);
      setHint(error instanceof Error ? error.message : String(error));
    } finally { setSending(false); }
  }

  const count = state.todayCount > 99 ? "99+" : String(state.todayCount);
  const label = saved ? "已保存任务" : state.todayCount ? `今天还有 ${state.todayCount} 项待办（含逾期）` : "今天的待办已完成";

  return (
    <main
      className={`floating-shell ${expanded ? "expanded" : "collapsed"} ${state.hasReminder ? "has-reminder" : ""}`}
      data-anchor-x={state.anchorX}
      data-anchor-y={state.anchorY}
      style={{ width: expanded ? panelWidth : 48, height: expanded ? panelHeight : 48 }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          expand(false);
        }
      }}
    >
      <button
        type="button"
        className={`floating-orb ${saved ? "saved" : ""}`}
        aria-label={`${label}，${expanded ? "收起输入框" : "点击添加任务"}`}
        aria-expanded={expanded}
        title={`${label}\n点击${expanded ? "收起" : "添加"} · 拖动调整位置`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          suppressClick.current = false;
          drag.current = { x: event.screenX, y: event.screenY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const dx = event.screenX - current.x, dy = event.screenY - current.y;
          if (!current.moved && Math.hypot(dx, dy) < 4) return;
          current.moved = true;
          suppressClick.current = true;
          window.didaLocal?.moveFloating(dx, dy);
          current.x = event.screenX;
          current.y = event.screenY;
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; suppressClick.current = true; }}
        onClick={() => { if (!suppressClick.current) expand(!expanded); }}
      >
        {saved || state.todayCount === 0 ? <Check size={22} strokeWidth={1.8} /> :
          <span className={state.todayCount > 99 ? "count-overflow" : ""}>{count}</span>}
      </button>
      <form className="floating-form" onSubmit={submit} aria-hidden={!expanded} inert={!expanded}>
        <div className="floating-input-row" style={{ width: panelWidth - 64 }}>
          <textarea
            ref={input}
            value={text}
            rows={1}
            maxLength={2000}
            style={{ width: panelWidth - 108, height: inputHeight }}
            placeholder="记下一件事…"
            aria-label="快速添加任务"
            title="Enter 添加 · Shift + Enter 换行 · Esc 收起 · 支持输入法语音转写"
            disabled={sending}
            onChange={(event) => { setText(event.target.value); setHint(""); setNeedsCheck(false); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" className="floating-add" aria-label="添加任务" title="添加任务（Enter）" disabled={!text.trim() || sending || needsCheck}>
            <ArrowUp size={18} strokeWidth={2} />
          </button>
        </div>
        {hint && <div className="floating-hint" style={{ width: panelWidth - 64 }} role="status">
          <span title={hint}>{hint}</span>
          <button type="button" aria-label="打开 DitaList" title="打开 DitaList" onClick={() => window.didaLocal?.openMain()}><ArrowUpRight size={16} /></button>
        </div>}
      </form>
      <span className="floating-measure" ref={measure} aria-hidden="true">{text || "记下一件事…"}</span>
    </main>
  );
}

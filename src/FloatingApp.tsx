import { useState } from "react";
import { ArrowUpRight, Plus, X } from "lucide-react";

export default function FloatingApp() {
  const [text, setText] = useState("");
  const [hint, setHint] = useState("回车添加任务");
  const desktop = Boolean(window.didaLocal);

  function close() {
    window.didaLocal?.closeFloating();
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) {
      setHint("先写下要做的事情");
      return;
    }
    if (!desktop) {
      setHint("请从 DitaList 桌面程序使用");
      return;
    }
    window.didaLocal?.submitQuickAdd(value);
    setText("");
    setHint("已添加");
    window.setTimeout(close, 180);
  }

  return (
    <main className="floating-shell">
      <header className="floating-header">
        <div className="floating-brand">
          <img src="./icon.svg" alt="" />
          <strong>DitaList</strong>
          <span>快速添加</span>
        </div>
        <button
          type="button"
          className="floating-close"
          aria-label="关闭悬浮窗"
          title="关闭悬浮窗"
          onClick={close}
        >
          <X size={16} />
        </button>
      </header>
      <form className="floating-form" onSubmit={submit}>
        <input
          autoFocus
          value={text}
          maxLength={2000}
          placeholder="准备做些什么？支持“明天 9:00”"
          aria-label="快速添加任务"
          onChange={(event) => {
            setText(event.target.value);
            if (hint !== "回车添加任务") setHint("回车添加任务");
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        <button type="submit" className="floating-add" aria-label="添加任务">
          <Plus size={18} />
        </button>
      </form>
      <footer className="floating-footer">
        <span>{hint}</span>
        <button
          type="button"
          className="floating-open-main"
          onClick={() => window.didaLocal?.openMain()}
        >
          打开 DitaList
          <ArrowUpRight size={13} />
        </button>
      </footer>
    </main>
  );
}

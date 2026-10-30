import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { desktopAction } from "../core/client";

const coordinate = z.number().finite().min(-65536).max(65536);
const extent = z.number().finite().positive().max(32768);
const rect = z.object({ x: coordinate, y: coordinate, width: extent, height: extent });
const id = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative();
const motionEvent = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("prepare"), id, from: rect, to: rect, maximized: z.boolean(),
    bar: z.object({ today: count, pending: count, reminders: count }) }),
  z.object({ phase: z.literal("start"), id }),
  z.object({ phase: z.literal("settled"), id }),
]);
type Prepare = Extract<z.infer<typeof motionEvent>, { phase: "prepare" }>;

const duration = 520;
const smooth = (t: number) => { const v = Math.min(1, Math.max(0, t)); return v * v * (3 - 2 * v); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// Both the clip and content follow the same spring. The content uses a uniform
// scale, so letters never stretch while the bar changes its aspect ratio.
export function mainMotionFrames(from: Prepare["from"], to: Prepare["to"], maximized: boolean, colors: {native: string; app: string}) {
  const surface: Keyframe[] = [], content: Keyframe[] = [], bar: Keyframe[] = [];
  const spring = (t: number) => 1 - (1 + 9.36 * t) * Math.exp(-9.36 * t);
  const initialScale = Math.max(from.width / to.width, from.height / to.height);
  for (let i = 0; i <= 52; i++) {
    const offset = i / 52, p = spring(offset) / spring(1);
    const width = mix(from.width, to.width, p), height = mix(from.height, to.height, p);
    const scale = mix(initialScale, 1, p);
    const radius = mix(8, maximized ? 0 : 8, p) + 16 * Math.sin(Math.PI * p);
    surface.push({ offset, left: `${mix(from.x, to.x, p)}px`, top: `${mix(from.y, to.y, p)}px`,
      width: `${width}px`, height: `${height}px`, borderRadius: `${Math.min(radius, width / 2, height / 2)}px`,
      backgroundColor: `color-mix(in srgb, ${colors.native} ${(1 - p) * 100}%, ${colors.app})` });
    content.push({ offset, transform: `translate(${(width - to.width * scale) / 2}px, ${(height - to.height * scale) / 2}px) scale(${scale})`,
      opacity: smooth((p - .035) / .5) });
    bar.push({ offset, opacity: 1 - smooth(p / .27) });
  }
  return { surface, content, bar };
}

export async function installMainMotion(onError: (error: unknown) => void): Promise<() => void> {
  const surface = document.getElementById("main-window-surface");
  const content = document.getElementById("main-window-content");
  const bar = document.getElementById("main-window-bar-origin");
  if (!surface || !content || !bar) throw new Error("主窗口转场容器不可用");
  let current: { intent: Prepare; colors: {native: string; app: string}; animations: Animation[]; finishing: boolean; frame: number } | null = null;
  const clearStyles = () => {
    surface.removeAttribute("style"); content.removeAttribute("style"); bar.removeAttribute("style");
    surface.inert = false;
    delete document.documentElement.dataset.mainMotion;
  };
  const reset = () => {
    const old = current; current = null;
    if (old) { cancelAnimationFrame(old.frame); old.animations.forEach((animation) => animation.cancel()); }
    clearStyles();
  };
  const finish = async () => {
    const active = current;
    if (!active || active.finishing) return;
    active.finishing = true;
    document.documentElement.dataset.mainMotion = "settling";
    try { await desktopAction("mainMotionFinished", { id: active.intent.id }); }
    catch (error) { reset(); onError(error); }
  };
  const observer = new ResizeObserver(() => {
    if (!current?.finishing) return;
    const { to } = current.intent;
    // Native SetWindowPos changes the canvas and its origin together. Resize
    // observers run before paint, so the final content keeps its screen position.
    if (Math.abs(innerWidth - to.width) < 2 && Math.abs(innerHeight - to.height) < 2) {
      current.animations.forEach((animation) => animation.cancel());
      clearStyles();
    }
  });
  observer.observe(document.documentElement);
  const unlistenState = await listen<unknown>("desktop://main-window-state", ({payload}) => {
    const decoded = z.object({maximized: z.boolean()}).safeParse(payload);
    if (decoded.success) document.documentElement.dataset.mainMaximized = String(decoded.data.maximized);
  });
  const unlisten = await listen<unknown>("desktop://main-motion", ({ payload }) => {
    const decoded = motionEvent.safeParse(payload);
    if (!decoded.success) { onError(new Error("主窗口转场参数无效")); return; }
    const event = decoded.data;
    if (event.phase === "settled") {
      if (current?.intent.id === event.id) reset();
      return;
    }
    if (event.phase === "prepare") {
      reset();
      const dark = document.documentElement.dataset.theme === "dark";
      const colors = {native: dark ? "#292b30" : "#ffffff", app: getComputedStyle(surface).backgroundColor};
      current = { intent: event, colors, animations: [], finishing: false, frame: 0 };
      document.documentElement.dataset.mainMaximized = String(event.maximized);
      document.documentElement.dataset.mainMotion = "prepared";
      surface.inert = true;
      Object.assign(surface.style, { position: "absolute", left: `${event.from.x}px`, top: `${event.from.y}px`,
        width: `${event.from.width}px`, height: `${event.from.height}px`, borderRadius: "8px", backgroundColor: colors.native });
      Object.assign(content.style, { position: "absolute", width: `${event.to.width}px`, height: `${event.to.height}px`,
        transformOrigin: "0 0", opacity: "0" });
      Object.assign(bar.style, { display: "flex", width: `${event.from.width}px`, height: `${event.from.height}px`, opacity: "1",
        color: dark ? "#e7e8ec" : "#333741" });
      bar.replaceChildren();
      const add = (label: string, width: number, accent = false) => {
        const item = document.createElement("span"); item.textContent = label;
        item.style.width = `${width}px`; if (accent) item.className = "accent"; bar.append(item);
      };
      const number = (value: number) => value > 99 ? "99+" : String(value);
      add("⋮⋮", 40); add(`今天 ${number(event.bar.today)}`, 100);
      if (event.bar.pending) add(`待确认 ${number(event.bar.pending)}`, 104);
      if (event.bar.reminders) add(`提醒 ${number(event.bar.reminders)}`, 80);
      add("＋", 40, true);
      // Hidden WebViews throttle requestAnimationFrame. Force the prepared
      // layout here; the visible frame loop starts only after the host shows it.
      void surface.getBoundingClientRect();
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) { void finish(); return; }
      void desktopAction("mainMotionPrepared", { id: event.id }).catch((error) => { reset(); onError(error); });
      return;
    }
    if (!current || current.intent.id !== event.id || current.animations.length || current.finishing) return;
    const active = current;
    active.frame = requestAnimationFrame(() => {
      active.frame = requestAnimationFrame(() => {
        if (current !== active) return;
        document.documentElement.dataset.mainMotion = "running";
        const frames = mainMotionFrames(active.intent.from, active.intent.to, active.intent.maximized, active.colors);
        const options: KeyframeAnimationOptions = { duration, easing: "linear", fill: "forwards" };
        active.animations = [surface.animate(frames.surface, options), content.animate(frames.content, options), bar.animate(frames.bar, options)];
        void active.animations[0].finished.then(finish).catch(() => {});
      });
    });
  });
  return () => { unlisten(); unlistenState(); observer.disconnect(); reset(); };
}

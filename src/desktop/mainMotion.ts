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
    bar: z.object({ today: count, pending: count, reminders: count,
      theme: z.enum(["light", "dark", "system"]).optional(), accent: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }) }),
  z.object({ phase: z.literal("paint"), id }),
  z.object({ phase: z.literal("start"), id }),
  z.object({ phase: z.literal("settled"), id }),
]);
type Prepare = Extract<z.infer<typeof motionEvent>, { phase: "prepare" }>;

const duration = 820;
const smooth = (t: number) => { const v = Math.min(1, Math.max(0, t)); return v * v * (3 - 2 * v); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// A rounded head grows out of a narrow, curved neck at the source bar. The neck
// widens into the final rectangle; only the outline deforms, never the letters.
export function mainMotionFrames(from: Prepare["from"], to: Prepare["to"], maximized: boolean, colors: {native: string; app: string}) {
  const surface: Keyframe[] = [], content: Keyframe[] = [], bar: Keyframe[] = [];
  const spring = (t: number, rate: number) => {
    const sample = (v: number) => 1 - (1 + rate * v) * Math.exp(-rate * v);
    return sample(t) / sample(1);
  };
  const origin = {x: from.x + from.width / 2, y: from.y + from.height / 2};
  const dx = to.x + to.width / 2 - origin.x;
  const dy = to.y + to.height / 2 - origin.y;
  const distance = Math.hypot(dx, dy) || 1;
  const direction = {x: dx / distance, y: dy / distance};
  const horizontal = Math.abs(dx / to.width) >= Math.abs(dy / to.height);
  const initialScale = Math.max(from.width / to.width, from.height / to.height);
  for (let i = 0; i <= 82; i++) {
    const offset = i / 82, p = spring(offset, 4.6);
    const lead = spring(offset, 6.2), trail = spring(offset, 3.4);
    const edge = (start: number, end: number, facing: number) => mix(start, end,
      mix(trail, lead, (facing + 1) / 2));
    const left = edge(from.x, to.x, -direction.x);
    const top = edge(from.y, to.y, -direction.y);
    const right = edge(from.x + from.width, to.x + to.width, direction.x);
    const bottom = edge(from.y + from.height, to.y + to.height, direction.y);
    const width = right - left, height = bottom - top;
    const scale = mix(initialScale, 1, p);
    const swell = Math.sin(Math.PI * p);
    // Work in a horizontal coordinate system whose right edge touches the bar,
    // then rotate/reflect the same contour for any source edge of the window.
    const w = horizontal ? width : height, h = horizontal ? height : width;
    const r = Math.min(mix(8, maximized ? 0 : 8, p), w / 2, h / 2);
    const throat = Math.min(h * .16, (horizontal ? from.height : from.width) * .6);
    const cross = horizontal ? origin.y - top : origin.x - left;
    const neckCenter = Math.min(h - throat / 2, Math.max(throat / 2, cross));
    const neckTop = mix(0, neckCenter - throat / 2, swell);
    const neckBottom = mix(h, neckCenter + throat / 2, swell);
    const neckLength = w * .52 * swell;
    const shoulder = w - r - neckLength;
    const headRadius = Math.min(mix(r, Math.min(w * .28, h / 2), swell), shoulder * .8);
    const point = (x: number, y: number) => {
      const px = horizontal ? (dx < 0 ? x : width - x) : y;
      const py = horizontal ? y : (dy < 0 ? x : height - x);
      return `${px.toFixed(3)} ${py.toFixed(3)}`;
    };
    const outline = `M ${point(headRadius, 0)} L ${point(shoulder, 0)} ` +
      `C ${point(shoulder + neckLength * .3, 0)} ${point(w - r - neckLength * .75, neckTop)} ${point(w - r, neckTop)} ` +
      `Q ${point(w, neckTop)} ${point(w, neckTop + r)} L ${point(w, neckBottom - r)} ` +
      `Q ${point(w, neckBottom)} ${point(w - r, neckBottom)} ` +
      `C ${point(w - r - neckLength * .75, neckBottom)} ${point(shoulder + neckLength * .3, h)} ${point(shoulder, h)} ` +
      `L ${point(headRadius, h)} Q ${point(0, h)} ${point(0, h - headRadius)} ` +
      `L ${point(0, headRadius)} Q ${point(0, 0)} ${point(headRadius, 0)} Z`;
    surface.push({ offset, left: `${left}px`, top: `${top}px`,
      width: `${width}px`, height: `${height}px`, borderRadius: "0px", clipPath: `path("${outline}")`,
      backgroundColor: `color-mix(in srgb, ${colors.native} ${(1 - p) * 100}%, ${colors.app})` });
    content.push({ offset, transform: `translate(${(width - to.width * scale) / 2}px, ${(height - to.height * scale) / 2}px) scale(${scale})`,
      opacity: smooth((p - .16) / .65) });
    bar.push({ offset, left: `${origin.x - left}px`, top: `${origin.y - top}px`,
      opacity: 1 - smooth(p / .3) });
  }
  return { surface, content, bar };
}

export async function installMainMotion(onError: (error: unknown) => void, isActive = () => true): Promise<() => void> {
  const surface = document.getElementById("main-window-surface");
  const content = document.getElementById("main-window-content");
  const bar = document.getElementById("main-window-bar-origin");
  if (!surface || !content || !bar) throw new Error("主窗口转场容器不可用");
  type ActiveMotion = { intent: Prepare; colors: {native: string; app: string}; animations: Animation[];
    finishing: boolean; frame: number; stage: "prepared" | "painting" | "source-ready" | "starting" | "running";
    preparedAtMs: number; sourceFrameAtMs: number; startedAtMs: number; seenVisible: boolean };
  let current: ActiveMotion | null = null;
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
  const finish = async (show = true) => {
    const active = current;
    if (!active || active.finishing) return;
    active.finishing = true;
    document.documentElement.dataset.mainMotion = "settling";
    try { await desktopAction(show ? "mainMotionFinished" : "mainMotionCancelled", {
      id: active.intent.id, startedAtMs: active.startedAtMs, finishedAtMs: performance.now(),
    }); }
    catch (error) { reset(); onError(error); }
  };
  const paintSource = (active: ActiveMotion) => {
    if (current !== active || active.stage !== "painting" || active.frame || document.hidden) return;
    active.seenVisible = true;
    active.frame = requestAnimationFrame(() => {
      active.frame = requestAnimationFrame(() => {
        active.frame = 0;
        if (current !== active || active.finishing) return;
        if (document.hidden) return;
        active.stage = "source-ready";
        active.sourceFrameAtMs = performance.now();
        document.documentElement.dataset.mainMotion = "source-ready";
        // The first visible frame has replaced the retained WebView surface.
        // The host can now remove the source-sized region and hand over the bar.
        void desktopAction("mainMotionSourceFrame", {id: active.intent.id,
          preparedAtMs: active.preparedAtMs, sourceFrameAtMs: active.sourceFrameAtMs})
          .catch((error) => { reset(); onError(error); });
      });
    });
  };
  const startMotion = (active: ActiveMotion) => {
    if (current !== active || active.stage !== "starting" || document.hidden) return;
    active.stage = "running";
    active.startedAtMs = performance.now();
    document.documentElement.dataset.mainMotion = "running";
    const frames = mainMotionFrames(active.intent.from, active.intent.to, active.intent.maximized, active.colors);
    const options: KeyframeAnimationOptions = { duration, easing: "linear", fill: "forwards" };
    active.animations = [surface.animate(frames.surface, options), content.animate(frames.content, options), bar.animate(frames.bar, options)];
    // Start immediately from the acknowledged source frame. This rAF only
    // measures the first animated frame; it does not postpone the animation.
    active.frame = requestAnimationFrame(() => {
      active.frame = 0;
      if (current !== active || active.finishing) return;
      void desktopAction("mainMotionFrame", {id: active.intent.id, preparedAtMs: active.preparedAtMs,
        sourceFrameAtMs: active.sourceFrameAtMs, startedAtMs: active.startedAtMs, firstFrameAtMs: performance.now()})
        .catch(onError);
    });
    void active.animations[0].finished.then(() => finish()).catch(() => {});
  };
  const visibilityChanged = () => {
    if (!current || current.finishing) return;
    if (document.hidden) {
      if (current.seenVisible) void finish(false);
    } else if (current.stage === "painting") paintSource(current);
    else if (current.stage === "starting") startMotion(current);
  };
  document.addEventListener("visibilitychange", visibilityChanged);
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
      if (event.bar.theme) {
        document.documentElement.dataset.theme = event.bar.theme === "dark" ||
          (event.bar.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
      }
      if (event.bar.accent) document.documentElement.style.setProperty("--accent", event.bar.accent);
      const dark = document.documentElement.dataset.theme === "dark";
      const colors = {native: dark ? "#292b30" : "#ffffff", app: getComputedStyle(surface).backgroundColor};
      current = { intent: event, colors, animations: [], finishing: false, frame: 0, stage: "prepared",
        preparedAtMs: performance.now(), sourceFrameAtMs: 0, startedAtMs: 0, seenVisible: false };
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
    if (event.phase === "paint" && active.stage === "prepared") {
      active.stage = "painting";
      paintSource(active);
    } else if (event.phase === "start" && active.stage === "source-ready") {
      active.stage = "starting";
      startMotion(active);
    }
  });
  // The actual App can subscribe and load its snapshot while the shell opens.
  // A cancelled StrictMode effect must never open a window on its own.
  if (isActive()) void desktopAction("mainShellReady", {window: "main"}).catch(onError);
  return () => { unlisten(); unlistenState(); observer.disconnect();
    document.removeEventListener("visibilitychange", visibilityChanged); reset(); };
}

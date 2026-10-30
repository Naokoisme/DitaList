import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { NavigationPreferences } from "../model";
import { orderNavigationItems } from "../core/navigation";

type Target = { group: string; id: string; after: boolean };
type Gesture = {
  group: string; id: string; pointer: number; x: number; y: number;
  element: HTMLElement; active: boolean;
};

export default function useNavigationEditing(
  saved: NavigationPreferences,
  groups: Record<string, string[]>,
  onSave: (preferences: NavigationPreferences) => Promise<boolean>,
  onEditingChange?: (editing: boolean) => void,
) {
  const [draft, setDraft] = useState<NavigationPreferences | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current = useRef({ saved, groups, draft, saving, onSave, onEditingChange });
  current.current = { saved, groups, draft, saving, onSave, onEditingChange };
  const gesture = useRef<Gesture | null>(null);
  const destination = useRef<Target | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickUntil = useRef(0);

  const begin = () => {
    if (current.current.draft) return;
    const value = structuredClone(current.current.saved);
    // Settings is now a fixed exit from navigation and cannot be hidden.
    value.hidden = value.hidden.filter((id) => id !== "rail:settings");
    value.orders.rail = (value.orders.rail || []).filter((id) => id !== "rail:settings");
    current.current.draft = value;
    setDraft(value);
    setError("");
    current.current.onEditingChange?.(true);
  };
  const clearGesture = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const old = gesture.current;
    gesture.current = null;
    if (old?.element.hasPointerCapture(old.pointer)) old.element.releasePointerCapture(old.pointer);
    destination.current = null;
    setDragging(null);
    setTarget(null);
  };
  const replaceDraft = (value: NavigationPreferences) => {
    current.current.draft = value;
    setDraft(value);
    setError("");
  };
  const move = (group: string, id: string, anchor: string, after: boolean) => {
    if (current.current.saving) return;
    const value = current.current.draft;
    const ids = value ? orderNavigationItems((current.current.groups[group] || []).map((key) => ({ id: key })), value, group).map((item) => item.id) : [];
    if (!value || id === anchor || !ids.includes(id) || !ids.includes(anchor)) return;
    const remaining = ids.filter((key) => key !== id);
    remaining.splice(remaining.indexOf(anchor) + Number(after), 0, id);
    replaceDraft({ ...value, orders: { ...value.orders, [group]: remaining } });
  };
  const cancel = () => {
    if (current.current.saving) return;
    suppressClickUntil.current = gesture.current?.active ? Infinity : 0;
    clearGesture();
    current.current.draft = null;
    setDraft(null);
    setError("");
    current.current.onEditingChange?.(false);
  };

  useEffect(() => {
    const pointerMove = (event: PointerEvent) => {
      const drag = gesture.current;
      if (!drag || event.pointerId !== drag.pointer) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) clearGesture();
        return;
      }
      event.preventDefault();
      let item = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-navigation-id]");
      while (item && item.dataset.navigationGroup !== drag.group) {
        item = item.parentElement?.closest<HTMLElement>("[data-navigation-id]") || null;
      }
      const rect = item?.getBoundingClientRect();
      const horizontal = drag.group === "rail" && window.matchMedia("(max-width: 700px)").matches;
      const next = item && rect && item.dataset.navigationId !== drag.id
        ? { group: drag.group, id: item.dataset.navigationId!, after: horizontal ? event.clientX > rect.x + rect.width / 2 : event.clientY > rect.y + rect.height / 2 }
        : null;
      destination.current = next;
      setTarget(next);
      const scroll = item?.closest<HTMLElement>(".navigation-sidebar-scroll, .navigation-rail-scroll");
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        if (event.clientY < bounds.top + 24) scroll.scrollBy(0, -12);
        else if (event.clientY > bounds.bottom - 24) scroll.scrollBy(0, 12);
      }
    };
    const pointerEnd = (event: PointerEvent) => {
      const drag = gesture.current;
      if (!drag || drag.pointer !== event.pointerId) return;
      if (drag.active) {
        suppressClickUntil.current = Date.now() + 400;
        const drop = destination.current;
        if (event.type === "pointerup" && drop) move(drag.group, drag.id, drop.id, drop.after);
      }
      clearGesture();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && current.current.draft) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const lostFocus = () => {
      if (gesture.current?.active) suppressClickUntil.current = Infinity;
      clearGesture();
    };
    window.addEventListener("pointermove", pointerMove, { passive: false });
    window.addEventListener("pointerup", pointerEnd);
    window.addEventListener("pointercancel", pointerEnd);
    window.addEventListener("blur", lostFocus);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerEnd);
      window.removeEventListener("pointercancel", pointerEnd);
      window.removeEventListener("blur", lostFocus);
      window.removeEventListener("keydown", escape, true);
      if (timer.current) clearTimeout(timer.current);
      const drag = gesture.current;
      if (drag?.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer);
      current.current.onEditingChange?.(false);
    };
  }, []);

  function start(event: ReactPointerEvent<HTMLElement>, group: string, id: string) {
    if (event.button !== 0 || !event.isPrimary || current.current.saving) return;
    if ((event.target as Element).closest("[data-navigation-control], input, textarea, select")) return;
    if ((event.target as Element).closest("[data-navigation-id]") !== event.currentTarget) return;
    // A fresh press must not inherit suppression from the previous long press.
    suppressClickUntil.current = 0;
    clearGesture();
    const element = event.currentTarget;
    const value: Gesture = { group, id, pointer: event.pointerId, x: event.clientX, y: event.clientY, element, active: false };
    gesture.current = value;
    const activate = () => {
      if (gesture.current !== value) return;
      begin();
      value.active = true;
      setDragging(id);
      element.setPointerCapture(value.pointer);
    };
    if (current.current.draft) { event.preventDefault(); activate(); }
    else timer.current = setTimeout(activate, 500);
  }
  function captureClick(event: MouseEvent<HTMLElement>) {
    if ((event.target as Element).closest("[data-navigation-control]")) return;
    if (current.current.draft || (event.detail > 0 && Date.now() < suppressClickUntil.current)) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntil.current = 0;
    }
  }
  async function finish() {
    const value = current.current.draft;
    if (!value || current.current.saving) return;
    clearGesture();
    current.current.saving = true;
    setSaving(true);
    setError("");
    try {
      if (!await current.current.onSave(value)) throw new Error("导航尚未保存，请重试或取消此次整理。");
      current.current.draft = null;
      setDraft(null);
      current.current.onEditingChange?.(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导航尚未保存，请重试。");
    } finally {
      current.current.saving = false;
      setSaving(false);
    }
  }
  return {
    preferences: draft || saved, editing: draft !== null, dragging, target, saving, error,
    begin, cancel, finish, start, captureClick, clearGesture, move,
    toggle(id: string) {
      const value = current.current.draft;
      if (!value || current.current.saving) return;
      replaceDraft({ ...value, hidden: value.hidden.includes(id) ? value.hidden.filter((key) => key !== id) : [...value.hidden, id] });
    },
  };
}

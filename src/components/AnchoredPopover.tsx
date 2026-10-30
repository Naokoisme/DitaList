import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
const PopoverPath = createContext<string[]>([]);
const openPopovers: HTMLElement[] = [];

export default function AnchoredPopover({
  anchorRef,
  onClose,
  className,
  children,
  role,
  ariaLabel,
  alignRight = false,
  preferAbove = false,
  maxHeight = 360,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: (reason?: "escape") => void;
  className: string;
  children: React.ReactNode;
  role?: React.AriaRole;
  ariaLabel?: string;
  alignRight?: boolean;
  preferAbove?: boolean;
  maxHeight?: number;
}) {
  const parentPath = useContext(PopoverPath);
  const id = useId();
  const popoverPath = useMemo(() => [...parentPath, id], [parentPath, id]);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const reposition = () => {
      const bounds = anchor.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const margin = 12;
      const gap = 6;
      const above = Math.max(0, bounds.top - margin - gap);
      const below = Math.max(0, viewportHeight - bounds.bottom - margin - gap);
      const contentHeight =
        popover.scrollHeight + popover.offsetHeight - popover.clientHeight;
      const desiredHeight = Math.min(maxHeight, contentHeight);
      const useAbove = preferAbove
        ? above >= desiredHeight || above > below
        : below < desiredHeight && above > below;
      const availableHeight = Math.min(maxHeight, useAbove ? above : below);
      const height = Math.min(contentHeight, availableHeight);
      const width = popover.getBoundingClientRect().width;
      const next = {
        top: Math.max(
          margin,
          Math.min(
            useAbove ? bounds.top - gap - height : bounds.bottom + gap,
            viewportHeight - margin - height,
          ),
        ),
        left: Math.max(
          margin,
          Math.min(
            alignRight ? bounds.right - width : bounds.left,
            viewportWidth - margin - width,
          ),
        ),
        maxHeight: availableHeight,
      };
      setPosition((previous) =>
        previous &&
        previous.top === next.top &&
        previous.left === next.left &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next,
      );
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(anchor);
    observer.observe(popover);
    window.addEventListener("resize", reposition);
    // Capture also observes scrolling inside a task dialog or details panel.
    window.addEventListener("scroll", reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef, alignRight, preferAbove, maxHeight, children]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    openPopovers.push(popover);
    return () => {
      const index = openPopovers.indexOf(popover);
      if (index >= 0) openPopovers.splice(index, 1);
    };
  }, []);

  useEffect(() => {
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      // A nested date picker lives in its own portal, but still belongs to this popover.
      const element = target instanceof Element ? target : target.parentElement;
      const targetPath = element?.closest("[data-popover-path]")
        ?.getAttribute("data-popover-path")?.split(" ");
      if (targetPath?.includes(id)) return;
      if (
        !anchorRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" ||
        openPopovers.at(-1) !== popoverRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // A picker closes first; the task dialog and its draft stay open.
      onClose("escape");
      anchorRef.current
        ?.querySelector<HTMLElement>("button, input")
        ?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", handlePointer, true);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointer, true);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [anchorRef, onClose, id]);

  return createPortal(
    <PopoverPath.Provider value={popoverPath}>
    <div
      ref={popoverRef}
      data-popover-path={popoverPath.join(" ")}
      className={`${className} viewport-popover`}
      role={role}
      aria-label={ariaLabel}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        maxHeight: position?.maxHeight ?? maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
    </PopoverPath.Provider>,
    document.body,
  );
}

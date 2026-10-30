import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, isDate, localDate } from "../core/domain";
import AnchoredPopover from "./AnchoredPopover";
export default function CustomDateInput({
  value,
  onChange,
  ariaLabel,
  placeholder = "选择日期",
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const today = localDate();
  const initial = isDate(value) ? value : today;
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => `${initial.slice(0, 7)}-01`);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const restoringFocus = useRef(false);

  useEffect(() => {
    if (isDate(value)) {
      setViewMonth(`${value.slice(0, 7)}-01`);
    }
  }, [value]);

  const [y, m] = viewMonth.split("-").map(Number);
  const firstOfMonth = new Date(y, m - 1, 1, 12);
  const offset = (firstOfMonth.getDay() + 6) % 7;
  const startCell = addDays(viewMonth, -offset);
  const days = Array.from({ length: 42 }, (_, idx) => addDays(startCell, idx));
  const shiftMonth = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1, 12);
    setViewMonth(localDate(d));
  };

  return (
    <div className="custom-picker" ref={wrapperRef}>
      <input
        type="text"
        value={value}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        placeholder={placeholder}
        onFocus={() => {
          if (!restoringFocus.current) setOpen(true);
          restoringFocus.current = false;
        }}
        onClick={() => setOpen(true)}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && (
        <AnchoredPopover
          anchorRef={wrapperRef}
          className="custom-picker-popover custom-date-popover"
          role="dialog"
          ariaLabel={ariaLabel}
          onClose={(reason) => {
            restoringFocus.current = reason === "escape" &&
              document.activeElement !== wrapperRef.current?.querySelector("input");
            setOpen(false);
          }}
        >
          <div className="custom-date-presets">
            {[
              { label: "今天", date: today },
              { label: "明天", date: addDays(today, 1) },
              { label: "7天后", date: addDays(today, 7) },
            ].map((preset) => (
              <button
                type="button"
                key={preset.date}
                className={value === preset.date ? "is-selected" : ""}
                onClick={() => {
                  onChange(preset.date);
                  setOpen(false);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="custom-picker-header">
            <button
              type="button"
              className="icon-button"
              aria-label="上个月"
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft size={15} />
            </button>
            <strong>
              {y}年{m}月
            </strong>
            <button
              type="button"
              className="icon-button"
              aria-label="下个月"
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="custom-picker-weekdays">
            {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="custom-picker-days">
            {days.map((d) => {
              const dayNum = Number(d.slice(8, 10));
              const inMonth = Number(d.slice(5, 7)) === m;
              const isSelected = d === value;
              const isToday = d === today;
              return (
                <button
                  type="button"
                  key={d}
                  className={`custom-day-cell ${inMonth ? "" : "is-outside"} ${isSelected ? "is-selected" : ""} ${isToday ? "is-today" : ""}`}
                  onClick={() => {
                    onChange(d);
                    setOpen(false);
                  }}
                >
                  {dayNum}
                </button>
              );
            })}
          </div>
          <div className="custom-picker-footer">
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              不设日期
            </button>
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
}


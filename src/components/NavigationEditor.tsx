import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, X } from "lucide-react";
import type { AppData, NavigationPreferences } from "../model";
import {
  isNavigationItemVisible,
  orderNavigationItems,
  RAIL_NAV_ITEMS,
  SIDEBAR_NAV_ITEMS,
} from "../core/navigation";
import "../navigation.css";

interface EditorItem {
  id: string;
  label: string;
  editable?: boolean;
}
interface EditorGroup {
  id: string;
  label: string;
  parentId?: string;
  items: EditorItem[];
}

function sidebarGroups(data: AppData): EditorGroup[] {
  const lists = data.lists
    .filter((list) => !list.archived && list.id !== "inbox")
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const folders = [...data.folders].sort((a, b) => a.sortOrder - b.sortOrder);
  const listItem = (list: AppData["lists"][number]): EditorItem => ({
    id: `list:${list.id}`, label: list.name, editable: true,
  });
  const tags = [...new Set([
    ...(data.settings.customTags || []),
    ...data.tasks.filter((task) => !task.deletedAt).flatMap((task) => task.tags),
  ])].sort((a, b) => a.localeCompare(b, "zh-CN"));
  return [
    { id: "sidebar", label: "区域与系统入口", items: [...SIDEBAR_NAV_ITEMS] },
    {
      id: "lists", label: "清单与分组", parentId: "section:lists",
      items: [
        ...lists.filter((list) => !list.folderId).map(listItem),
        ...folders.map((folder) => ({
          id: `folder:${folder.id}`, label: folder.name, editable: true,
        })),
      ],
    },
    ...folders.map((folder) => ({
      id: `folder:${folder.id}`, label: folder.name, parentId: `folder:${folder.id}`,
      items: lists.filter((list) => list.folderId === folder.id).map(listItem),
    })),
    {
      id: "tags", label: "标签", parentId: "section:tags",
      items: tags.map((tag) => ({ id: `tag:${tag}`, label: tag, editable: true })),
    },
    {
      id: "filters", label: "过滤器", parentId: "section:filters",
      items: data.filters.map((filter) => ({
        id: `filter:${filter.id}`, label: filter.name, editable: true,
      })),
    },
  ];
}

export default function NavigationEditor({
  data,
  onClose,
  onSave,
}: {
  data: AppData;
  onClose: () => void;
  onSave: (preferences: NavigationPreferences, renames: Record<string, string>) => Promise<void>;
}) {
  const [tab, setTab] = useState<"rail" | "sidebar">("sidebar");
  const [preferences, setPreferences] = useState<NavigationPreferences>(() => ({
    orders: { ...(data.settings.navigation?.orders || {}) },
    hidden: [...(data.settings.navigation?.hidden || [])],
  }));
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<{ group: string; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    group: string; id: string; position: "before" | "after";
  } | null>(null);
  const classificationGroups = useMemo(() => sidebarGroups(data), [data]);
  const groups: EditorGroup[] = tab === "rail"
    ? [{ id: "rail", label: "功能入口", items: [...RAIL_NAV_ITEMS] }]
    : classificationGroups;

  useEffect(() => {
    const clear = () => {
      setDragging(null);
      setDropTarget(null);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  function move(group: EditorGroup, sourceId: string, anchorId: string, position: "before" | "after") {
    if (sourceId === anchorId) return;
    setPreferences((current) => {
      const ids = orderNavigationItems(group.items, current, group.id).map((item) => item.id);
      if (!ids.includes(sourceId) || !ids.includes(anchorId)) return current;
      const remaining = ids.filter((id) => id !== sourceId);
      const index = remaining.indexOf(anchorId) + (position === "after" ? 1 : 0);
      remaining.splice(index, 0, sourceId);
      return { ...current, orders: { ...current.orders, [group.id]: remaining } };
    });
  }

  function toggleVisibility(id: string) {
    setPreferences((current) => ({
      ...current,
      hidden: current.hidden.includes(id)
        ? current.hidden.filter((key) => key !== id)
        : [...current.hidden, id],
    }));
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="dialog navigation-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="navigation-editor-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          const editableItems = classificationGroups.flatMap((group) => group.items)
            .filter((item) => item.editable);
          const changedNames: Record<string, string> = {};
          for (const item of editableItems) {
            if (!(item.id in renames)) continue;
            const name = renames[item.id].trim();
            if (!name) {
              setError(`“${item.label}”的名称不能为空。`);
              return;
            }
            if (name !== item.label) changedNames[item.id] = name;
          }
          try {
            setSaving(true); setError("");
            await onSave(preferences, changedNames);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally { setSaving(false); }
        }}
      >
        <div className="dialog-header">
          <h2 id="navigation-editor-title">编辑导航</h2>
          <button type="button" className="icon-button" aria-label="关闭导航编辑" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="navigation-editor-tabs" role="tablist" aria-label="导航栏">
          {([{ id: "rail", label: "图标栏" }, { id: "sidebar", label: "分类栏" }] as const).map((item) => (
            <button
              type="button"
              role="tab"
              id={`navigation-tab-${item.id}`}
              aria-controls="navigation-editor-panel"
              aria-selected={tab === item.id}
              key={item.id}
              className={tab === item.id ? "selected" : ""}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="navigation-editor-help">
          拖动或用箭头调整顺序，点击眼睛控制显示。自建项可改名，系统项名称固定。
        </p>
        <div
          className="navigation-editor-body"
          id="navigation-editor-panel"
          role="tabpanel"
          aria-labelledby={`navigation-tab-${tab}`}
        >
          {groups.map((group) => {
            const items = orderNavigationItems(group.items, preferences, group.id);
            const parentHidden = (group.parentId && !isNavigationItemVisible(preferences, group.parentId)) ||
              (group.id.startsWith("folder:") && !isNavigationItemVisible(preferences, "section:lists"));
            return (
              <section className="navigation-editor-group" key={group.id}>
                <div className="navigation-editor-group-heading">
                  <h3>{renames[group.id]?.trim() || group.label}</h3>
                  {parentHidden && <span>所属区域已隐藏</span>}
                </div>
                {items.length === 0 && <p className="navigation-editor-empty">暂无项目</p>}
                {items.map((item, index) => {
                  const visible = isNavigationItemVisible(preferences, item.id);
                  const label = renames[item.id] ?? item.label;
                  const position = dropTarget?.group === group.id && dropTarget.id === item.id
                    ? dropTarget.position : "";
                  return (
                    <div
                      className={`navigation-editor-row ${visible ? "" : "is-hidden"} ${dragging?.id === item.id ? "is-dragging" : ""} ${position ? `drop-${position}` : ""}`}
                      key={item.id}
                      onDragOver={(event) => {
                        if (!dragging || dragging.group !== group.id || dragging.id === item.id ||
                          !event.dataTransfer.types.includes("text/ditalist-navigation")) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setDropTarget({ group: group.id, id: item.id,
                          position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" });
                      }}
                      onDragLeave={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                        setDropTarget((target) => target?.group === group.id && target.id === item.id ? null : target);
                      }}
                      onDrop={(event) => {
                        if (!dragging || dragging.group !== group.id ||
                          event.dataTransfer.getData("text/ditalist-navigation") !== dragging.id) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        move(group, dragging.id, item.id,
                          event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
                        setDragging(null);
                        setDropTarget(null);
                      }}
                    >
                      <button
                        type="button"
                        className="navigation-drag-handle"
                        draggable
                        aria-label={`拖动 ${label}`}
                        title="拖动调整顺序，也可使用右侧上下箭头"
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/ditalist-navigation", item.id);
                          event.dataTransfer.effectAllowed = "move";
                          const row = event.currentTarget.closest(".navigation-editor-row");
                          if (row) event.dataTransfer.setDragImage(row, 16, row.getBoundingClientRect().height / 2);
                          setDragging({ group: group.id, id: item.id });
                        }}
                        onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                      >
                        <GripVertical size={15} />
                      </button>
                      {item.editable ? (
                        <input
                          className="navigation-name-input"
                          value={label}
                          aria-label={`${item.label} 名称`}
                          maxLength={item.id.startsWith("tag:") ? 200 : 500}
                          onChange={(event) => {
                            setRenames((current) => ({ ...current, [item.id]: event.target.value }));
                            setError("");
                          }}
                        />
                      ) : <span className="navigation-system-name">{item.label}</span>}
                      <div className="navigation-row-actions">
                        <button type="button" className="icon-button" aria-label={`上移 ${label}`}
                          disabled={index === 0} onClick={() => move(group, item.id, items[index - 1].id, "before")}>
                          <ArrowUp size={15} />
                        </button>
                        <button type="button" className="icon-button" aria-label={`下移 ${label}`}
                          disabled={index === items.length - 1} onClick={() => move(group, item.id, items[index + 1].id, "after")}>
                          <ArrowDown size={15} />
                        </button>
                        <button type="button" className="icon-button" aria-label={`${visible ? "隐藏" : "显示"} ${label}`}
                          aria-pressed={visible} title={visible ? "显示中，点击隐藏" : "已隐藏，点击显示"}
                          onClick={() => toggleVisibility(item.id)}>
                          {visible ? <Eye size={16} /> : <EyeOff size={16} />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
        <p className="navigation-editor-help">
          隐藏只影响导航入口。两栏的“编辑导航”入口始终保留，可随时恢复布局。
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-footer">
          <button type="button" className="text-button" onClick={() => {
            setPreferences({ orders: {}, hidden: [] });
            setError("");
          }}>恢复默认布局</button>
          <button type="button" className="text-button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存"}</button>
        </div>
      </form>
    </div>
  );
}

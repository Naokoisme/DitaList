import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import {
  CalendarCheck2,
  CalendarDays,
  CalendarRange,
  ChevronRight,
  CircleHelp,
  Clock3,
  Folder,
  FolderPlus,
  Inbox,
  LayoutGrid,
  List,
  ListFilter,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  SquareCheck,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AppData, Folder as TaskFolder, Task, TaskList, ViewId } from "../model";
import { addDays, localDate } from "../core/domain";
import type { ListMoveTarget } from "../core/list-organization";
import {
  RAIL_NAV_ITEMS,
  SIDEBAR_NAV_ITEMS,
  isNavigationItemVisible,
  orderNavigationItems,
} from "../core/navigation";
import "../app-navigation.css";

interface AppNavigationProps {
  data: AppData;
  view: ViewId;
  active: Task[];
  tags: string[];
  saveStatus: "saved" | "saving" | "error";
  saveStatusLabel: string;
  sidebarOpen: boolean;
  draggingListId: string | null;
  listDropTarget: ListMoveTarget | null;
  onGo: (id: ViewId) => void;
  onSettings: (section: "general" | "data") => void;
  onSearch: () => void;
  onHelp: () => void;
  onEditNavigation: () => void;
  onCloseSidebar: () => void;
  onAddList: () => void;
  onAddFolder: () => void;
  onAddTag: () => void;
  onAddFilter: () => void;
  renderSidebarItem: (id: ViewId, label: string, Icon: LucideIcon, count?: number) => ReactNode;
  renderListItem: (list: TaskList) => ReactNode;
  renderTagItem: (tag: string) => ReactNode;
  listGroupDropProps: (folderId: string | null) => HTMLAttributes<HTMLElement>;
}

type RootListEntry = { id: string; list?: TaskList; folder?: TaskFolder };

export default function AppNavigation({
  data,
  view,
  active,
  tags,
  saveStatus,
  saveStatusLabel,
  sidebarOpen,
  draggingListId,
  listDropTarget,
  onGo,
  onSettings,
  onSearch,
  onHelp,
  onEditNavigation,
  onCloseSidebar,
  onAddList,
  onAddFolder,
  onAddTag,
  onAddFilter,
  renderSidebarItem,
  renderListItem,
  renderTagItem,
  listGroupDropProps,
}: AppNavigationProps) {
  const preferences = data.settings.navigation;
  const visible = (id: string) => isNavigationItemVisible(preferences, id);
  const today = localDate();
  const fullView = ["calendar", "matrix", "focus", "habits"].includes(view);
  const orderedRail = orderNavigationItems(RAIL_NAV_ITEMS, preferences, "rail");
  const sidebarEntries = orderNavigationItems(SIDEBAR_NAV_ITEMS, preferences, "sidebar")
    .filter((item) => visible(item.id));
  const lists = data.lists
    .filter((list) => list.id !== "inbox" && !list.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const rootListEntries: RootListEntry[] = [
    ...lists.filter((list) => !list.folderId).map((list) => ({ id: `list:${list.id}`, list })),
    ...data.folders.slice().sort((a, b) => a.sortOrder - b.sortOrder)
      .map((folder) => ({ id: `folder:${folder.id}`, folder })),
  ];
  const rootLists = orderNavigationItems(rootListEntries, preferences, "lists")
    .filter((item) => visible(item.id));
  const visibleTags = orderNavigationItems(
    tags.map((tag) => ({ id: `tag:${tag}`, tag })), preferences, "tags",
  ).filter((item) => visible(item.id));
  const visibleFilters = orderNavigationItems(
    data.filters.map((filter) => ({ id: `filter:${filter.id}`, filter })), preferences, "filters",
  ).filter((item) => visible(item.id));

  const openEditorFromContext = (event: MouseEvent<HTMLElement>) => {
    // A list or tag may already own this context-menu action.
    if (event.defaultPrevented) return;
    event.preventDefault();
    onEditNavigation();
  };
  const hiddenNotice = (label: string) => (
    <button type="button" className="navigation-hidden-entry" onClick={onEditNavigation}>
      {label}已隐藏 · 编辑导航
    </button>
  );
  const groupHighlighted = (folderId: string | null) =>
    listDropTarget?.kind === "group" && listDropTarget.folderId === folderId;

  const railActions: Record<string, { Icon: LucideIcon; run: () => void; selected?: boolean }> = {
    "rail:tasks": { Icon: SquareCheck, run: () => onGo("today"), selected: !fullView },
    "rail:calendar": { Icon: CalendarDays, run: () => onGo("calendar"), selected: view === "calendar" },
    "rail:matrix": { Icon: LayoutGrid, run: () => onGo("matrix"), selected: view === "matrix" },
    "rail:focus": { Icon: Clock3, run: () => onGo("focus"), selected: view === "focus" },
    "rail:habits": { Icon: CalendarCheck2, run: () => onGo("habits"), selected: view === "habits" },
    "rail:search": { Icon: Search, run: onSearch },
    "rail:data": { Icon: ShieldCheck, run: () => onSettings("data") },
    "rail:settings": { Icon: Settings2, run: () => onSettings("general") },
    "rail:help": { Icon: CircleHelp, run: onHelp },
  };
  const renderRailItem = (item: (typeof RAIL_NAV_ITEMS)[number]) => {
    if (!visible(item.id)) return null;
    const { Icon, run, selected } = railActions[item.id];
    const label = item.id === "rail:data" ? `${saveStatusLabel}，查看数据与备份` :
      item.id === "rail:search" ? "搜索 Ctrl+K" : item.label;
    return (
      <button
        type="button"
        key={item.id}
        title={label}
        aria-label={label}
        className={`rail-button ${selected ? "active" : ""} ${item.id === "rail:data" ? `save-indicator ${saveStatus}` : ""}`}
        onClick={run}
      >
        <Icon size={21} />
      </button>
    );
  };

  const renderLists = () => (
    <section className="navigation-section" key="section:lists" aria-label="清单">
      <div
        className={`sidebar-section-heading list-root-heading ${groupHighlighted(null) ? "list-group-drag-over" : ""}`}
        {...listGroupDropProps(null)}
      >
        <span>{draggingListId ? "清单 · 不分组" : "清单"}</span>
        <div>
          <button type="button" title="新建清单分组" aria-label="新建清单分组" onClick={onAddFolder}>
            <FolderPlus size={14} />
          </button>
          <button type="button" title="添加清单" aria-label="添加清单" onClick={onAddList}>
            <Plus size={15} />
          </button>
        </div>
      </div>
      {rootLists.map((entry) => {
        if (entry.list) return renderListItem(entry.list);
        const folder = entry.folder!;
        const folderLists = lists.filter((list) => list.folderId === folder.id);
        const children = orderNavigationItems(
          folderLists.map((list) => ({ id: `list:${list.id}`, list })),
          preferences, `folder:${folder.id}`,
        ).filter((item) => visible(item.id));
        return (
          <details className="sidebar-folder" key={entry.id} open>
            <summary
              className={`${draggingListId ? "list-group-drop-candidate" : ""} ${groupHighlighted(folder.id) ? "list-group-drag-over" : ""}`}
              title="可将清单拖到这里归入分组"
              {...listGroupDropProps(folder.id)}
            >
              <ChevronRight size={12} />
              <Folder size={16} />
              <span>{folder.name}</span>
              {groupHighlighted(folder.id) && <small>移入</small>}
            </summary>
            {children.map((item) => renderListItem(item.list))}
            {folderLists.length > 0 && children.length === 0 && hiddenNotice("分组内的清单")}
          </details>
        );
      })}
      {draggingListId && (
        <div
          className={`list-root-drop ${groupHighlighted(null) ? "list-group-drag-over" : ""}`}
          {...listGroupDropProps(null)}
        >
          放到清单顶层（不分组）
        </div>
      )}
      {rootListEntries.length > 0 && rootLists.length === 0 && hiddenNotice("清单与分组")}
      {lists.length === 0 && (rootListEntries.length === 0 || rootLists.length > 0) && (
        <button type="button" className="sidebar-empty-add" onClick={onAddList}>
          <Plus size={13} />添加你的第一个清单
        </button>
      )}
    </section>
  );
  const renderTags = () => (
    <section className="navigation-section" key="section:tags" aria-label="标签">
      <div className="sidebar-section-heading">
        <span>标签</span>
        <button type="button" title="添加标签" aria-label="新建标签" onClick={onAddTag}>
          <Plus size={14} />
        </button>
      </div>
      {visibleTags.map((item) => renderTagItem(item.tag))}
      {tags.length > 0 && visibleTags.length === 0 && hiddenNotice("标签")}
      {tags.length === 0 && (
        <button type="button" className="sidebar-empty-add" onClick={onAddTag}>
          <Plus size={13} />添加你的第一个标签
        </button>
      )}
    </section>
  );
  const renderFilters = () => (
    <section className="navigation-section" key="section:filters" aria-label="过滤器">
      <div className="sidebar-section-heading">
        <span>过滤器</span>
        <button type="button" title="添加过滤器" aria-label="添加过滤器" onClick={onAddFilter}>
          <Plus size={14} />
        </button>
      </div>
      {visibleFilters.map(({ filter }) => renderSidebarItem(`filter:${filter.id}`, filter.name, ListFilter))}
      {data.filters.length > 0 && visibleFilters.length === 0 && hiddenNotice("过滤器")}
      {data.filters.length === 0 && (
        <p className="sidebar-hint">按日期、优先级和标签，<br />快速找到你关心的任务。</p>
      )}
    </section>
  );
  const sidebarIcons: Record<string, LucideIcon> = {
    today: CalendarDays, next7: CalendarRange, inbox: Inbox,
    all: List, completed: SquareCheck, trash: Trash2,
  };
  const sidebarCounts: Record<string, number | undefined> = {
    today: active.filter((task) => task.dueDate === today).length,
    next7: active.filter((task) => task.dueDate && task.dueDate >= today && task.dueDate <= addDays(today, 6)).length,
    inbox: active.filter((task) => task.listId === "inbox").length,
    all: active.length,
    trash: data.tasks.filter((task) => task.deletedAt).length,
  };
  const renderSidebarEntry = (entry: (typeof SIDEBAR_NAV_ITEMS)[number]) => {
    if (entry.id === "section:lists") return renderLists();
    if (entry.id === "section:tags") return renderTags();
    if (entry.id === "section:filters") return renderFilters();
    return (
      <div className="navigation-system-entry" key={entry.id}>
        {renderSidebarItem(entry.id, entry.label, sidebarIcons[entry.id], sidebarCounts[entry.id])}
      </div>
    );
  };

  return (
    <>
      <nav className="icon-rail customizable-icon-rail" aria-label="主导航" onContextMenu={openEditorFromContext}>
        <button type="button" className="local-avatar" aria-label="设置" title="DitaList · 设置" onClick={() => onSettings("general")}>
          <img src="./icon.svg" alt="" />
        </button>
        <div className="navigation-rail-scroll">
          <div className="rail-primary">{orderedRail.slice(0, 6).map(renderRailItem)}</div>
          <div className="rail-bottom">{orderedRail.slice(6).map(renderRailItem)}</div>
        </div>
        <button type="button" className="rail-button navigation-editor-trigger" title="编辑导航" aria-label="编辑导航" onClick={onEditNavigation}>
          <SlidersHorizontal size={18} />
        </button>
      </nav>
      {!fullView && (
        <>
          <aside className={`app-sidebar customizable-sidebar ${sidebarOpen ? "mobile-open" : ""}`} aria-label="任务分类" onContextMenu={openEditorFromContext}>
            <div className="sidebar-scroll navigation-sidebar-scroll">
              {sidebarEntries.map(renderSidebarEntry)}
              {sidebarEntries.length === 0 && (
                <button type="button" className="navigation-hidden-entry" onClick={onEditNavigation}>
                  导航已隐藏 · 选择显示的入口
                </button>
              )}
            </div>
            <div className="sidebar-lower navigation-sidebar-footer">
              <button type="button" className="navigation-customize-button" onClick={onEditNavigation}>
                <SlidersHorizontal size={14} />编辑导航
              </button>
              <div className="sidebar-local-note">
                <span className={`status-dot ${saveStatus === "error" ? "error" : ""}`} />
                {saveStatus === "saved" ? "仅本机 · 已保存" : saveStatus === "saving" ? "正在保存…" : "保存失败，请检查"}
              </div>
            </div>
          </aside>
          {sidebarOpen && <div className="sidebar-scrim" onClick={onCloseSidebar} />}
        </>
      )}
    </>
  );
}

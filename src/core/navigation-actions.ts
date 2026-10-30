import type { AppData, NavigationPreferences } from "../model";
import { moveTaskList, type ListMoveTarget } from "./list-organization";
import { orderNavigationItems } from "./navigation";

function listNavigationGroups(data: AppData): Map<string, { id: string }[]> {
  const folders = [...data.folders].sort((a, b) => a.sortOrder - b.sortOrder);
  const groups = new Map<string, { id: string }[]>([["lists", []]]);
  for (const folder of folders) groups.set(`folder:${folder.id}`, []);
  const lists = data.lists
    .filter((list) => list.id !== "inbox" && !list.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const list of lists) {
    const group = list.folderId ? `folder:${list.folderId}` : "lists";
    groups.get(group)?.push({ id: `list:${list.id}` });
  }
  groups.get("lists")!.push(...folders.map((folder) => ({ id: `folder:${folder.id}` })));
  return groups;
}

function syncListSortOrders(data: AppData): AppData {
  const listPositions = new Map<string, number>();
  const folderPositions = new Map<string, number>();
  for (const [group, items] of listNavigationGroups(data)) {
    orderNavigationItems(items, data.settings.navigation, group).forEach((item, index) => {
      if (item.id.startsWith("list:")) listPositions.set(item.id.slice(5), index);
      else folderPositions.set(item.id.slice(7), index);
    });
  }
  let changed = false;
  const lists = data.lists.map((list) => {
    const sortOrder = listPositions.get(list.id);
    if (sortOrder === undefined || sortOrder === list.sortOrder) return list;
    changed = true;
    return { ...list, sortOrder };
  });
  const folders = data.folders.map((folder) => {
    const sortOrder = folderPositions.get(folder.id);
    if (sortOrder === undefined || sortOrder === folder.sortOrder) return folder;
    changed = true;
    return { ...folder, sortOrder };
  });
  return changed ? { ...data, lists, folders } : data;
}

export function applyNavigationSettings(
  data: AppData,
  preferences: NavigationPreferences,
  renames: Record<string, string>,
): AppData {
  const existingNames = new Map<string, string>();
  for (const list of data.lists) {
    if (list.id !== "inbox") existingNames.set(`list:${list.id}`, list.name);
  }
  for (const folder of data.folders) existingNames.set(`folder:${folder.id}`, folder.name);
  for (const filter of data.filters) existingNames.set(`filter:${filter.id}`, filter.name);
  const tags = new Set(data.settings.customTags || []);
  for (const task of data.tasks) {
    for (const tag of task.tags) tags.add(tag);
  }
  for (const tag of tags) existingNames.set(`tag:${tag}`, tag);

  const names = new Map<string, string>();
  const tagNames = new Map<string, string>();
  for (const [key, rawName] of Object.entries(renames)) {
    const original = existingNames.get(key);
    if (original === undefined) throw new Error("部分导航项目已不存在，请重新打开编辑导航。");
    if (typeof rawName !== "string") throw new Error("导航名称必须是文字。");
    const isTag = key.startsWith("tag:");
    const name = isTag ? rawName.trim().replace(/^#+/, "").trim() : rawName.trim();
    const maxLength = isTag ? 200 : 500;
    if (!name) throw new Error(`“${original}”的名称不能为空。`);
    if (name.length > maxLength) throw new Error(`“${original}”的名称不能超过 ${maxLength} 个字符。`);
    if (name === original) continue;
    names.set(key, name);
    if (isTag) tagNames.set(original, name);
  }

  // Check final names together so swaps are valid while accidental tag merges are rejected.
  const finalTags = new Set<string>();
  for (const tag of tags) {
    const name = tagNames.get(tag) ?? tag;
    if (finalTags.has(name)) throw new Error(`标签“${name}”已存在，请使用不同的名称。`);
    finalTags.add(name);
  }
  const renameTag = (tag: string) => tagNames.get(tag) ?? tag;
  const renameKey = (key: string) => key.startsWith("tag:")
    ? `tag:${renameTag(key.slice(4))}` : key;
  const navigation: NavigationPreferences = {
    orders: Object.fromEntries(Object.entries(preferences.orders)
      .map(([group, ids]) => [group, [...new Set(ids.map(renameKey))]])),
    hidden: [...new Set(preferences.hidden.map(renameKey))],
  };
  const now = new Date().toISOString();
  const tasks = tagNames.size ? data.tasks.map((task) => {
    if (!task.tags.some((tag) => tagNames.has(tag))) return task;
    return { ...task, tags: task.tags.map(renameTag), updatedAt: now };
  }) : data.tasks;
  const filters = data.filters.map((filter) => {
    const name = names.get(`filter:${filter.id}`) ?? filter.name;
    // Saved queries use whitespace-separated terms; only a complete #tag term is a reference.
    const query = tagNames.size ? filter.query.replace(/(^|\s)#(\S+)/g,
      (term: string, space: string, tag: string) => tagNames.has(tag)
        ? `${space}#${renameTag(tag)}` : term) : filter.query;
    if (query.length > 10000) throw new Error(`更名后过滤器“${name}”的条件过长，请先缩短筛选条件。`);
    return name === filter.name && query === filter.query ? filter : { ...filter, name, query };
  });
  let defaultView = data.settings.defaultView;
  if (defaultView.startsWith("tag:")) defaultView = `tag:${renameTag(defaultView.slice(4))}`;

  return syncListSortOrders({
    ...data,
    tasks,
    lists: data.lists.map((list) => {
      const name = names.get(`list:${list.id}`);
      return name === undefined ? list : { ...list, name };
    }),
    folders: data.folders.map((folder) => {
      const name = names.get(`folder:${folder.id}`);
      return name === undefined ? folder : { ...folder, name };
    }),
    filters,
    settings: {
      ...data.settings,
      defaultView,
      customTags: data.settings.customTags?.map(renameTag),
      navigation,
    },
  });
}

export function moveSidebarList(
  data: AppData,
  listId: string,
  target: ListMoveTarget,
): AppData {
  const source = data.lists.find((list) => list.id === listId);
  if (!source || source.id === "inbox" || source.archived) return data;
  const anchor = target.kind === "list"
    ? data.lists.find((list) => list.id === target.listId) : null;
  if (target.kind === "list" &&
    (!anchor || anchor.id === listId || anchor.id === "inbox" || anchor.archived)) return data;
  const folderId = target.kind === "group" ? target.folderId : anchor!.folderId;
  if (folderId && !data.folders.some((folder) => folder.id === folderId)) return data;

  const preferences = data.settings.navigation;
  const groups = listNavigationGroups(data);
  const sourceGroup = source.folderId ? `folder:${source.folderId}` : "lists";
  const destinationGroup = folderId ? `folder:${folderId}` : "lists";
  const sourceOrder = orderNavigationItems(groups.get(sourceGroup) || [], preferences, sourceGroup)
    .map((item) => item.id);
  const destinationOrder = sourceGroup === destinationGroup ? sourceOrder
    : orderNavigationItems(groups.get(destinationGroup) || [], preferences, destinationGroup)
      .map((item) => item.id);
  const key = `list:${listId}`;
  const destination = destinationOrder.filter((id) => id !== key);
  const anchorIndex = target.kind === "list" ? destination.indexOf(`list:${target.listId}`) : -1;
  if (target.kind === "list" && anchorIndex < 0) return data;
  const index = target.kind === "list"
    ? anchorIndex + (target.position === "after" ? 1 : 0) : destination.length;
  destination.splice(index, 0, key);
  if (sourceGroup === destinationGroup &&
    destination.every((id, position) => id === destinationOrder[position])) return data;

  // The root order also contains folders, so a meaningful move can leave legacy list order unchanged.
  const moved = moveTaskList(data, listId, target);
  const navigation: NavigationPreferences = {
    orders: {
      ...(preferences?.orders || {}),
      [sourceGroup]: sourceOrder.filter((id) => id !== key),
      [destinationGroup]: destination,
    },
    hidden: [...(preferences?.hidden || [])],
  };
  return syncListSortOrders({ ...moved, settings: { ...moved.settings, navigation } });
}

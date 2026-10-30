import type { AppData } from "../model";

export type ListMoveTarget =
  | { kind: "group"; folderId: string | null }
  | { kind: "list"; listId: string; position: "before" | "after" };

export function moveTaskList(
  data: AppData,
  listId: string,
  target: ListMoveTarget,
): AppData {
  const source = data.lists.find((list) => list.id === listId);
  if (!source || source.id === "inbox" || source.archived) return data;

  const anchor = target.kind === "list"
    ? data.lists.find((list) => list.id === target.listId)
    : null;
  if (target.kind === "list" &&
    (!anchor || anchor.id === listId || anchor.id === "inbox" || anchor.archived))
    return data;

  const folderId = target.kind === "group" ? target.folderId : anchor!.folderId;
  if (folderId && !data.folders.some((folder) => folder.id === folderId))
    return data;

  const siblings = data.lists
    .filter((list) => !list.archived && list.id !== "inbox" &&
      list.id !== listId && list.folderId === folderId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const index = target.kind === "list"
    ? siblings.findIndex((list) => list.id === target.listId) +
      (target.position === "after" ? 1 : 0)
    : siblings.length;
  siblings.splice(index, 0, source);
  const positions = new Map(siblings.map((list, order) => [list.id, order]));
  let changed = false;
  const lists = data.lists.map((list) => {
    const sortOrder = positions.get(list.id);
    if (sortOrder === undefined ||
      (list.folderId === folderId && list.sortOrder === sortOrder)) return list;
    changed = true;
    return { ...list, folderId, sortOrder };
  });
  // Only list placement changes; task IDs, list membership and dates stay intact.
  return changed ? { ...data, lists } : data;
}

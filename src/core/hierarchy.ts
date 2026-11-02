import type { AppData, Task } from "../model";
import type { ListInfo, TagInfo } from "../generated/contracts";

export function displayListIndex(data: AppData | null, index?: readonly ListInfo[]): ListInfo[] {
  const result = new Map((index || []).map((list) => [list.id, list]));
  for (const list of data?.lists || []) if (!result.has(list.id)) result.set(list.id, {id: list.id, name: list.name, parentId: null, path: [list.name], rootId: list.id, subtreeIds: [list.id], folderId: list.folderId});
  return [...result.values()];
}
export const listPath = (index: readonly ListInfo[], id: string) => index.find((list) => list.id === id)?.path.join(" › ") || id;
export const taskInList = (task: Pick<Task, "listId">, id: string, index: readonly ListInfo[]) => (index.find((list) => list.id === id)?.subtreeIds || [id]).includes(task.listId);
export function hierarchyDropPosition(y: number, bounds: {top: number; height: number}): "before" | "inside" | "after" {
  return y < bounds.top + bounds.height * .25 ? "before" : y > bounds.top + bounds.height * .75 ? "after" : "inside";
}
// 这里只控制可用落点；持久化前仍由 Rust 校验实际树。
export function canDropHierarchy(index: readonly (ListInfo | TagInfo)[], sourceId: string, targetId: string, position: string): boolean {
  const source = index.find((node) => node.id === sourceId), target = index.find((node) => node.id === targetId);
  if (!source || !target || source.subtreeIds.includes(targetId)) return false;
  const height = Math.max(1, ...index.filter((node) => source.subtreeIds.includes(node.id)).map((node) => node.path.length - source.path.length + 1));
  return (position === "inside" ? target.path.length : target.path.length - 1) + height <= 3;
}

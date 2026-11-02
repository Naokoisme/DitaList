import type { AppData, Task } from "../model";
import type { TagInfo } from "../generated/contracts";

// 层级与后代范围来自核心；缺少索引的旧快照只按一级标签显示。
export function displayTagIndex(data: AppData | null, index?: readonly TagInfo[]): TagInfo[] {
  const tags = new Map((index || []).map((tag) => [tag.id, tag]));
  for (const id of [...(data?.settings.customTags || []), ...(data?.tasks.flatMap((task) => task.tags) || [])]) {
    if (!tags.has(id)) tags.set(id, {id, name: id, parentId: null, path: [id], rootId: id, subtreeIds: [id]});
  }
  return [...tags.values()].sort((a, b) => a.path.join("\u0000").localeCompare(b.path.join("\u0000"), "zh-CN"));
}

export const tagPath = (index: readonly TagInfo[], id: string) => index.find((tag) => tag.id === id)?.path.join(" › ") || id;
export const tagName = (index: readonly TagInfo[], id: string) => index.find((tag) => tag.id === id)?.name || id;
export function taskHasTag(task: Pick<Task, "tags">, id: string, index: readonly TagInfo[]): boolean {
  const members = index.find((tag) => tag.id === id)?.subtreeIds || [id];
  return task.tags.some((tag) => members.includes(tag));
}
export function taskMatchesTagSearch(task: Pick<Task, "tags">, query: string, index: readonly TagInfo[]): boolean {
  const value = query.toLocaleLowerCase();
  return index.some((tag) => [tag.id, tag.name, tag.path.join("/")].some((name) => name.toLocaleLowerCase().includes(value)) && taskHasTag(task, tag.id, index));
}
export function compactTaskTags(ids: readonly string[], index: readonly TagInfo[]) {
  const roots = new Map<string, {id: string; name: string; paths: string[]}>();
  for (const id of ids) {
    const tag = index.find((tag) => tag.id === id);
    const rootId = tag?.rootId || id;
    const root = roots.get(rootId) || {id: rootId, name: tagName(index, rootId), paths: []};
    const path = tagPath(index, id);
    if (!root.paths.includes(path)) root.paths.push(path);
    roots.set(rootId, root);
  }
  return [...roots.values()];
}

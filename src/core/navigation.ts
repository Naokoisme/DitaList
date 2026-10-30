import type { NavigationPreferences } from "../model";

export const RAIL_NAV_ITEMS = [
  { id: "rail:tasks", label: "任务" },
  { id: "rail:calendar", label: "日历" },
  { id: "rail:matrix", label: "四象限" },
  { id: "rail:focus", label: "专注" },
  { id: "rail:habits", label: "习惯" },
  { id: "rail:search", label: "搜索" },
  { id: "rail:data", label: "数据与备份" },
  { id: "rail:settings", label: "设置" },
  { id: "rail:help", label: "快捷键与帮助" },
] as const;

export const SIDEBAR_NAV_ITEMS = [
  { id: "today", label: "今天" },
  { id: "next7", label: "最近7天" },
  { id: "inbox", label: "收集箱" },
  { id: "all", label: "所有任务" },
  { id: "section:lists", label: "清单区域" },
  { id: "section:tags", label: "标签区域" },
  { id: "section:filters", label: "过滤器区域" },
  { id: "completed", label: "已完成" },
  { id: "trash", label: "垃圾桶" },
] as const;

export function orderNavigationItems<T extends { id: string }>(
  items: readonly T[],
  preferences: NavigationPreferences | undefined,
  group: string,
): T[] {
  const order = [...new Set(preferences?.orders[group] || [])];
  const positions = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      (positions.get(a.item.id) ?? order.length + a.index) -
      (positions.get(b.item.id) ?? order.length + b.index),
    )
    .map(({ item }) => item);
}

export function isNavigationItemVisible(
  preferences: NavigationPreferences | undefined,
  id: string,
): boolean {
  return !preferences?.hidden.includes(id);
}


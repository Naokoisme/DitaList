import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CommandReceipt, CoreSnapshot, McpInfo, Operation, QuickDraft } from "../generated/contracts";
import type { AppData } from "../model";
import { validateData } from "./domain";

export type Snapshot = Omit<CoreSnapshot, "data"> & { data: AppData };
export type DesktopStatus = { floatingVisible: boolean; shortcutExists: boolean; dataPath: string; backupPath: string };
export type NavigateIntent = { view: string; taskId?: string };

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

function decodeSnapshot(value: CoreSnapshot): Snapshot {
  if (!value || !Number.isSafeInteger(value.revision) || !Array.isArray(value.approvals) ||
      !Array.isArray(value.reminders) || !value.preferences || !value.focus ||
      (value.focus.deadline !== null && (typeof value.focus.deadline !== "string" || !Number.isFinite(Date.parse(value.focus.deadline))))) {
    throw new Error("核心返回了无效状态，请重新打开窗口。");
  }
  return { ...value, data: validateData(value.data) };
}

export async function getSnapshot(): Promise<Snapshot> {
  return decodeSnapshot(await invoke<CoreSnapshot>("core_snapshot"));
}

// Subscribe before reading. A slow snapshot response must never replace a newer event.
export async function watchCore(onSnapshot: (snapshot: Snapshot) => void, onError: (error: unknown) => void): Promise<() => void> {
  let revision = -1;
  let active = true;
  const accept = (value: CoreSnapshot) => {
    try {
      const snapshot = decodeSnapshot(value);
      if (!active || snapshot.revision < revision) return;
      revision = snapshot.revision;
      onSnapshot(snapshot);
    } catch (error) { onError(error); }
  };
  const unlisten = await listen<CoreSnapshot>("core://changed", ({ payload }) => accept(payload));
  try { accept(await invoke<CoreSnapshot>("core_snapshot")); }
  catch (error) { onError(error); }
  return () => { active = false; unlisten(); };
}

const uncertain = new Map<string, string>();
export async function executeOperation(operation: Operation, requestId?: string): Promise<CommandReceipt> {
  const key = JSON.stringify(operation);
  const id = requestId || uncertain.get(key) || crypto.randomUUID();
  uncertain.set(key, id);
  try {
    const receipt = await invoke<CommandReceipt>("core_execute", { command: { requestId: id, operation } });
    uncertain.delete(key);
    return receipt;
  } catch (error) {
    // A lost IPC reply does not mean the operation was rolled back. Keep its business id.
    try {
      const receipt = await getRequest(id);
      if (receipt) { uncertain.delete(key); return receipt; }
    } catch { /* Keep the original error and identifier for an explicit retry. */ }
    throw error;
  }
}

export const getRequest = (requestId: string) => invoke<CommandReceipt | null>("core_get_request", { requestId });
export const desktopAction = (action: string, payload?: unknown) => invoke<void>("desktop_action", { action, payload });
export const desktopStatus = () => invoke<DesktopStatus>("desktop_status");
export const getDraft = () => invoke<QuickDraft>("draft_get");
export const setDraft = (draft: QuickDraft) => invoke<void>("draft_set", { draft });
export const getMcpInfo = () => invoke<McpInfo>("mcp_info");
export const watchMcp = (listener: (info: McpInfo) => void) => listen<McpInfo>("mcp://state", ({ payload }) => listener(payload));
export const watchNavigation = (listener: (intent: NavigateIntent) => void) => listen<NavigateIntent>("desktop://navigate", ({ payload }) => listener(payload));
export const exportBackup = () => invoke<boolean>("backup_export");
export const importBackup = () => invoke<string | null>("backup_import");

export function mcpConfiguration(info: McpInfo): string {
  return JSON.stringify({ mcpServers: { ditalist: { command: info.command, args: info.args } } }, null, 2);
}

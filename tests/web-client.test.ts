import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { createEmptyData } from "../src/core/domain.ts";
import { executeOperation, mcpConfiguration, watchCore } from "../src/core/client.ts";
import type { CoreSnapshot, CommandReceipt, Operation } from "../src/generated/contracts.ts";

(globalThis as unknown as { window: unknown }).window = { crypto: globalThis.crypto };
const snapshot = (revision: number): CoreSnapshot => ({
  data: {...createEmptyData(), settings: {...createEmptyData().settings, customTags: []}}, revision, entityVersions: {}, approvals: [], reminders: [],
  focus: {mode: "focus", running: false, taskId: null, title: "", startedAt: null, deadline: null, remainingSeconds: 1500, elapsedSeconds: 0, targetSeconds: 1500},
  preferences: {floatingVisible: true, mcpEnabled: false, quiet: false, confirmPurge: true}, todayCount: 0, pendingCount: 0, reminderCount: 0,
});
const receipt = (requestId: string): CommandReceipt => ({requestId, status: "applied", revision: 2, result: {saved: true}, createdAt: "2026-10-30T00:00:00Z"});

test("a delayed initial snapshot cannot overwrite a newer subscribed state", async () => {
  let resolveInitial!: (value: CoreSnapshot) => void;
  let started!: () => void;
  const initialRequested = new Promise<void>((resolve) => { started = resolve; });
  const initial = new Promise<CoreSnapshot>((resolve) => { resolveInitial = resolve; });
  mockIPC((command) => { if (command === "core_snapshot") { started(); return initial; } throw new Error(command); }, {shouldMockEvents: true});
  const revisions: number[] = [];
  const errors: unknown[] = [];
  const watcher = watchCore((state) => revisions.push(state.revision), (error) => errors.push(error));
  await initialRequested;
  await emit("core://changed", snapshot(3));
  resolveInitial(snapshot(1));
  const stop = await watcher;
  await emit("core://changed", snapshot(2));
  await emit("core://changed", snapshot(4));
  assert.deepEqual(revisions, [3, 4]);
  assert.deepEqual(errors, []);
  stop(); clearMocks();
});

test("an IPC reply lost after save is recovered by querying the same business request", async () => {
  let executedId = "";
  let queriedId = "";
  mockIPC((command, args: any) => {
    if (command === "core_execute") { executedId = args.command.requestId; throw new Error("reply lost"); }
    if (command === "core_get_request") { queriedId = args.requestId; return receipt(queriedId); }
    throw new Error(command);
  });
  const result = await executeOperation({type: "taskTrash", id: "task-lost-reply"});
  assert.ok(executedId);
  assert.equal(queriedId, executedId);
  assert.equal(result.requestId, executedId);
  clearMocks();
});

test("an unresolved operation keeps its id when the user explicitly retries", async () => {
  const ids: string[] = [];
  mockIPC((command, args: any) => {
    if (command === "core_get_request") return null;
    if (command === "core_execute") {
      ids.push(args.command.requestId);
      if (ids.length === 1) throw new Error("connection interrupted");
      return receipt(args.command.requestId);
    }
    throw new Error(command);
  });
  const operation: Operation = {type: "taskTrash", id: "task-retry"};
  await assert.rejects(executeOperation(operation), /interrupted/);
  await executeOperation(operation);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  clearMocks();
});

test("Agent configuration uses the provided executable and arguments without a fixed port", () => {
  const value = JSON.parse(mcpConfiguration({state: "closed", command: "D:\\DitaList Preview\\ditalist-mcp.exe", args: ["--profile", "preview"], contactPath: "private.json", address: null}));
  assert.equal(value.mcpServers.ditalist.command, "D:\\DitaList Preview\\ditalist-mcp.exe");
  assert.deepEqual(value.mcpServers.ditalist.args, ["--profile", "preview"]);
  assert.equal(value.mcpServers.ditalist.url, undefined);
});

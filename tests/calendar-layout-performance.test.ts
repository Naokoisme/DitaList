import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import test from "node:test";
import ts from "typescript";

// Extract actual pure layout declarations without loading React, CSS, IPC or user data.
const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = "src/components/CalendarView.tsx";
// 固定优化前基线，避免提交后比较退化为新算法与自身比较。
const head = "1d562fc819f1486e0ebedb245b2813a864a520e4";
const oldSource = execFileSync("git", ["show", head + ":" + sourcePath], { cwd: root, encoding: "utf8" });
const newSource = readFileSync(new URL("../" + sourcePath, import.meta.url), "utf8");
const names = ["localDate", "parseDate", "addDays", "inRange", "taskStart", "taskEnd", "onDay", "taskOrder", "minutes", "weekEvents", "timeEvents"];
type FixtureTask = {
  id: string; startDate: string | null; dueDate: string | null;
  time: string | null; endTime: string | null; pinned: boolean;
  sortOrder: number; createdAt: string;
};
type Span = { task: FixtureTask; start: number; end: number; lane: number; continuesBefore: boolean; continuesAfter: boolean };
type Timed = { task: FixtureTask; start: number; end: number; column: number; columns: number };
type Layout = { weekEvents: (tasks: FixtureTask[], date: string) => Span[]; timeEvents: (tasks: FixtureTask[], date: string) => Timed[] };
function extract(source: string): Layout {
  const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map<string, string>();
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement.getText(tree));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, "const " + declaration.getText(tree) + ";");
      }
    }
  }
  const selected = names.map((name) => {
    assert.ok(declarations.has(name), "Missing layout declaration: " + name);
    return declarations.get(name)!;
  }).join("\n");
  const js = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(js + "\nreturn {weekEvents, timeEvents};")() as Layout;
}
const oldLayout = extract(oldSource);
const newLayout = extract(newSource);
const day = "2026-11-02";
function task(id: string, patch: Partial<FixtureTask> = {}): FixtureTask {
  return { id, startDate: day, dueDate: day, time: "09:00", endTime: "10:00", pinned: false, sortOrder: 0, createdAt: "2026-01-01T00:00:00Z", ...patch };
}
const clock = (minute: number) => String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
const disjoint = [
  task("a", { time: "08:00", endTime: "09:00" }),
  task("b", { time: "08:30", endTime: "09:00" }),
  task("touching", { time: "09:00", endTime: "09:30" }),
  task("later", { time: "12:00", endTime: "13:00" }),
  task("later-overlap", { time: "12:15", endTime: "12:45" }),
  task("last", { time: "18:00", endTime: "19:00" }),
];
const crossDay = [
  task("before", { startDate: "2026-10-30", dueDate: "2026-11-03" }),
  task("after", { startDate: "2026-11-06", dueDate: "2026-11-10" }),
  task("whole", { startDate: "2026-10-30", dueDate: "2026-11-10" }),
  task("outside", { startDate: "2026-10-20", dueDate: "2026-10-21" }),
  task("undated", { startDate: null, dueDate: null }),
  task("all-day", { time: null, endTime: null }),
  task("due-only", { startDate: null }),
  task("start-only", { dueDate: null }),
];
const overlap = [task("enclosing", { time: "08:00", endTime: "16:00" }), ...Array.from({ length: 100 }, (_, i) => task("nested-" + i, { time: clock(480 + i * 3), endTime: clock(540 + i * 3) }))];
function equivalent(tasks: FixtureTask[], dates = [day]) {
  const frozen = tasks.map((value) => Object.freeze({ ...value }));
  Object.freeze(frozen);
  for (const date of dates) {
    assert.deepStrictEqual(newLayout.weekEvents(frozen, date), oldLayout.weekEvents(frozen, date), "week: " + date);
    assert.deepStrictEqual(newLayout.timeEvents(frozen, date), oldLayout.timeEvents(frozen, date), "time: " + date);
  }
}
test("HEAD and working layout agree for disjoint and touching clusters", () => {
  equivalent(disjoint);
  assert.deepStrictEqual(newLayout.timeEvents(disjoint, day).map(e => [e.task.id, e.column, e.columns]), [
    ["a", 0, 2], ["b", 1, 2], ["touching", 0, 1], ["later", 0, 2], ["later-overlap", 1, 2], ["last", 0, 1],
  ]);
});
test("HEAD and working layout agree across day/week boundaries", () => {
  equivalent(crossDay, [day, "2026-11-03", "2026-11-06", "2026-11-08"]);
  const whole = newLayout.weekEvents(crossDay, day).find(e => e.task.id === "whole")!;
  assert.deepStrictEqual([whole.start, whole.end, whole.continuesBefore, whole.continuesAfter], [0, 6, true, true]);
  const timed = newLayout.timeEvents(crossDay, day).find(e => e.task.id === "whole")!;
  assert.deepStrictEqual([timed.start, timed.end], [0, 1440]);
});
test("HEAD and working layout agree for nested overlap, empty and fallback intervals", () => {
  equivalent(overlap);
  equivalent([]);
  equivalent([task("missing-end", { endTime: null }), task("reversed", { endTime: "08:00" }), task("midnight", { time: "23:50", endTime: "23:50" })]);
});
test("HEAD and working layout agree for seeded synthetic mixtures", () => {
  let seed = 0x12345678;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let round = 0; round < 25; round++) {
    const tasks = Array.from({ length: 120 }, (_, i) => {
      const start = 1 + random(12);
      const minute = random(1400);
      return task("random-" + i, { startDate: "2026-11-" + String(start).padStart(2, "0"), dueDate: "2026-11-" + String(start + random(5)).padStart(2, "0"), time: random(5) ? clock(minute) : null, endTime: clock(Math.min(1439, minute + random(180))), pinned: !!random(2), sortOrder: random(4) });
    });
    equivalent(tasks, [day, "2026-11-05", "2026-11-09"]);
  }
});
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[14] + sorted[15]) / 2; };
test("30-run median benchmarks of actual HEAD and working algorithms", (t) => {
  const cases: { name: string; method: keyof Layout; tasks: FixtureTask[] }[] = [
    { name: "week / 3000 mixed spans", method: "weekEvents", tasks: Array.from({ length: 3000 }, (_, i) => task("week-" + i, { startDate: "2026-11-0" + (2 + i % 7), dueDate: "2026-11-0" + (2 + i % 7) })) },
    { name: "time / 2000 overlapping", method: "timeEvents", tasks: Array.from({ length: 2000 }, (_, i) => task("dense-" + i)) },
    { name: "time / 2000 disjoint-group members", method: "timeEvents", tasks: Array.from({ length: 2000 }, (_, i) => task("groups-" + i, { time: clock((i % 20) * 60), endTime: clock((i % 20) * 60 + 30) })) },
  ];
  t.diagnostic("Baseline HEAD=" + head + "; 5 warmups; 30 samples each; alternating order; ms/call. No timing pass/fail threshold.");
  for (const entry of cases) {
    equivalent(entry.tasks);
    for (let i = 0; i < 5; i++) { oldLayout[entry.method](entry.tasks, day); newLayout[entry.method](entry.tasks, day); }
    const samples = { old: [] as number[], current: [] as number[] };
    for (let i = 0; i < 30; i++) {
      for (const version of (i % 2 ? ["current", "old"] : ["old", "current"]) as (keyof typeof samples)[]) {
        const start = performance.now();
        const result = (version === "old" ? oldLayout : newLayout)[entry.method](entry.tasks, day);
        samples[version].push(performance.now() - start);
        assert.equal(result.length, entry.tasks.length);
      }
    }
    const before = median(samples.old), after = median(samples.current);
    t.diagnostic(entry.name + ": HEAD=" + before.toFixed(3) + " ms, current=" + after.toFixed(3) + " ms, speedup=" + (before / after).toFixed(2) + "x");
  }
});

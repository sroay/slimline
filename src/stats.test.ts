import { test } from "node:test";
import * as assert from "node:assert/strict";
import { summarize, formatReport, StatsEvent } from "./stats";
import { handleEvent, THRESHOLD_LINES } from "./hook";

function event(partial: Partial<StatsEvent>): StatsEvent {
  return {
    ts: "2026-09-20T10:00:00.000Z",
    tool: "Bash",
    sessionId: "s1",
    truncated: false,
    beforeChars: 100,
    afterChars: 100,
    ...partial,
  };
}

test("summarize: empty log produces a zeroed summary, not a crash", () => {
  const s = summarize([]);
  assert.equal(s.totalCalls, 0);
  assert.equal(s.hitRate, 0);
  assert.equal(s.reductionOverall, 0);
});

test("summarize: hit rate counts untouched calls in the denominator", () => {
  const s = summarize([
    event({ truncated: false, beforeChars: 100, afterChars: 100 }),
    event({ truncated: false, beforeChars: 100, afterChars: 100 }),
    event({ truncated: true, beforeChars: 1000, afterChars: 100 }),
  ]);
  assert.equal(s.totalCalls, 3);
  assert.equal(s.truncatedCalls, 1);
  assert.ok(Math.abs(s.hitRate - 1 / 3) < 1e-9);
});

test("summarize: separates reduction on truncated calls from overall reduction", () => {
  const s = summarize([
    event({ truncated: false, beforeChars: 200, afterChars: 200 }),
    event({ truncated: true, beforeChars: 1000, afterChars: 100 }),
  ]);
  // Truncated-only: 1000 -> 100 is 90%. Overall: 1200 -> 300 is 75%.
  assert.ok(Math.abs(s.reductionOnTruncated - 0.9) < 1e-9);
  assert.ok(Math.abs(s.reductionOverall - 0.75) < 1e-9);
});

test("summarize: breaks savings down per tool", () => {
  const s = summarize([
    event({ tool: "Bash", truncated: true, beforeChars: 1000, afterChars: 100 }),
    event({ tool: "Read", truncated: true, beforeChars: 500, afterChars: 200 }),
    event({ tool: "Read", truncated: false, beforeChars: 50, afterChars: 50 }),
  ]);
  assert.equal(s.byTool.Bash.charsSaved, 900);
  assert.equal(s.byTool.Read.charsSaved, 300);
  assert.equal(s.byTool.Read.calls, 2);
  assert.equal(s.byTool.Read.truncated, 1);
});

test("formatReport: labels the token figure as an estimate", () => {
  const report = formatReport(summarize([event({ truncated: true, beforeChars: 4000, afterChars: 0 })]));
  assert.ok(report.includes("ESTIMATE"), "token savings must never be presented as measured");
});

test("formatReport: empty log says so instead of printing fake zeros", () => {
  assert.ok(formatReport(summarize([])).includes("no activity recorded yet"));
});

test("handleEvent: logs a no-op event for small output so hit rate stays honest", () => {
  const logged: StatsEvent[] = [];
  handleEvent(
    {
      tool_name: "Bash",
      session_id: "s1",
      tool_response: { stdout: "small", stderr: "", interrupted: false, isImage: false },
    },
    () => {},
    (e) => logged.push(e)
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0].truncated, false);
  assert.equal(logged[0].beforeChars, logged[0].afterChars);
});

test("handleEvent: logs a truncation event with real before/after sizes", () => {
  const logged: StatsEvent[] = [];
  const big = Array.from({ length: THRESHOLD_LINES + 500 }, (_, i) => `line ${i}`).join("\n");
  handleEvent(
    {
      tool_name: "Bash",
      cwd: "/tmp/p",
      session_id: "s1",
      tool_use_id: "t1",
      tool_response: { stdout: big, stderr: "", interrupted: false, isImage: false },
    },
    () => {},
    (e) => logged.push(e)
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0].truncated, true);
  assert.equal(logged[0].beforeChars, big.length);
  assert.ok(logged[0].afterChars < logged[0].beforeChars);
});

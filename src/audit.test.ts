import { test } from "node:test";
import * as assert from "node:assert/strict";
import { analyzeOmission, uniqueRatio, parseCacheFile, formatAudit } from "./audit";
import { computeOmission, truncateText, THRESHOLD_LINES, MAX_SIGNAL_LINES } from "./hook";

function lines(count: number, fn: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => fn(i)).join("\n");
}

// Guards against the audit drifting away from what truncation actually does.
test("computeOmission agrees with truncateText about what was surfaced", () => {
  const text = lines(THRESHOLD_LINES + 400, (i) => (i === 500 ? "ERROR: boom" : `line ${i}`));
  const truncated = truncateText(text)!;
  const omission = computeOmission(text);
  assert.equal(omission.mode, "lines");
  for (const surfaced of omission.surfacedSignals) {
    assert.ok(truncated.text.includes(surfaced), "a surfaced signal must appear in the shown output");
  }
  for (const line of omission.omitted) {
    if (!omission.surfacedSignals.includes(line)) {
      // Dropped filler should genuinely be absent from what Claude saw.
      if (line === "ERROR: boom") assert.fail("signal line should have been surfaced");
    }
  }
});

test("uniqueRatio: repetitive progress lines score low despite differing numbers", () => {
  const ratio = uniqueRatio(Array.from({ length: 500 }, (_, i) => `compiling module_${i} ... ok`));
  assert.ok(ratio < 0.05, `expected near-zero, got ${ratio}`);
});

test("uniqueRatio: genuinely varied content scores high", () => {
  const ratio = uniqueRatio(["alpha config", "beta handler", "gamma route", "delta parser"]);
  assert.equal(ratio, 1);
});

test("analyzeOmission: repetitive filler is not flagged", () => {
  const text = lines(THRESHOLD_LINES + 400, (i) => `compiling module_${i} ... ok (12ms)`);
  assert.equal(analyzeOmission("c.txt", "stdout", text), null);
});

test("analyzeOmission: flags HIGH when error lines exceed the surfacing cap", () => {
  const text = lines(THRESHOLD_LINES + 400, (i) =>
    i > 60 && i < 400 ? `ERROR: failure number ${i}` : `line ${i}`
  );
  const finding = analyzeOmission("c.txt", "stdout", text)!;
  assert.ok(finding, "should flag");
  assert.equal(finding.severity, "high");
  assert.ok(finding.hiddenSignalCount > 0);
  assert.ok(finding.reasons.some((r) => r.includes("without being surfaced")));
});

test("analyzeOmission: flags a nonzero exit code the live regex would miss", () => {
  const text = lines(THRESHOLD_LINES + 400, (i) =>
    i === 500 ? "process exited with code 3" : `step ${i} done`
  );
  const finding = analyzeOmission("c.txt", "stdout", text)!;
  assert.ok(finding, "a hidden nonzero exit must be flagged");
  assert.equal(finding.severity, "high");
});

test("analyzeOmission: flags hidden stack frames", () => {
  const text = lines(THRESHOLD_LINES + 400, (i) =>
    i === 500 ? "    at parseModule (/src/saturn/parser.ts:412:19)" : `ok ${i}`
  );
  const finding = analyzeOmission("c.txt", "stdout", text)!;
  assert.ok(finding.reasons.some((r) => r.includes("stack frame")));
});

test("analyzeOmission: content under threshold yields nothing", () => {
  assert.equal(analyzeOmission("c.txt", "stdout", "small\noutput"), null);
});

test("parseCacheFile: splits the hook's section markers", () => {
  const parsed = parseCacheFile("=== stdout ===\nhello\nthere\n\n=== stderr ===\noops");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].key, "stdout");
  assert.ok(parsed[0].text.includes("hello"));
  assert.equal(parsed[1].key, "stderr");
  assert.ok(parsed[1].text.includes("oops"));
});

test("formatAudit: says so plainly when there is nothing cached", () => {
  assert.ok(formatAudit([], 0).includes("Nothing to audit yet"));
});

test("formatAudit: distinguishes clean results from an empty scan", () => {
  const report = formatAudit([], 5);
  assert.ok(report.includes("No omissions look risky"));
  assert.ok(!report.includes("Nothing to audit yet"));
});

test("formatAudit: states that findings are suspicion rather than proof", () => {
  const text = lines(THRESHOLD_LINES + 400, (i) => (i === 500 ? "exit code 2" : `x ${i}`));
  const finding = analyzeOmission("c.txt", "stdout", text)!;
  assert.ok(formatAudit([finding], 1).includes("suspicion, not proof"));
});

test("MAX_SIGNAL_LINES cap is what creates hidden signals", () => {
  const text = lines(THRESHOLD_LINES + 400, (i) =>
    i > 60 && i < 400 ? `ERROR ${i}` : `line ${i}`
  );
  const omission = computeOmission(text);
  assert.equal(omission.surfacedSignals.length, MAX_SIGNAL_LINES);
  assert.ok(omission.hiddenSignals.length > 0);
});

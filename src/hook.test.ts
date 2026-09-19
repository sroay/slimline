import { test } from "node:test";
import * as assert from "node:assert/strict";
import { handleEvent, truncateText, THRESHOLD_LINES } from "./hook";

function makeLines(count: number, fill = "line"): string {
  return Array.from({ length: count }, (_, i) => `${fill} ${i}`).join("\n");
}

test("truncateText: under threshold returns null (true no-op)", () => {
  const text = makeLines(THRESHOLD_LINES - 1);
  assert.equal(truncateText(text), null);
});

test("truncateText: over threshold truncates and reports omitted count", () => {
  const text = makeLines(THRESHOLD_LINES + 500);
  const result = truncateText(text);
  assert.ok(result);
  assert.ok(result!.omittedLines > 0);
  assert.ok(result!.text.includes("lines omitted"));
});

test("truncateText: preserves an error line buried in the omitted middle", () => {
  const lines = makeLines(THRESHOLD_LINES + 500).split("\n");
  const middleIndex = Math.floor(lines.length / 2);
  lines[middleIndex] = "FATAL: something exploded at line 42";
  const result = truncateText(lines.join("\n"));
  assert.ok(result);
  assert.ok(
    result!.text.includes("FATAL: something exploded at line 42"),
    "buried error line must survive truncation"
  );
});

test("handleEvent: non-Bash tool is a no-op regardless of size", () => {
  const output = handleEvent(
    { tool_name: "Grep", tool_response: { stdout: makeLines(THRESHOLD_LINES + 500) } as any },
    () => assert.fail("cache should not be written for non-Bash tools")
  );
  assert.equal(output, null);
});

test("handleEvent: small Bash output is a true no-op (no cache write, no output)", () => {
  let cacheWritten = false;
  const output = handleEvent(
    {
      tool_name: "Bash",
      cwd: "/tmp/project",
      session_id: "s1",
      tool_use_id: "t1",
      tool_response: { stdout: makeLines(10), stderr: "", interrupted: false, isImage: false },
    },
    () => {
      cacheWritten = true;
    }
  );
  assert.equal(output, null);
  assert.equal(cacheWritten, false);
});

test("handleEvent: oversized Bash output caches original and returns matching updatedToolOutput shape", () => {
  let cachedPath = "";
  let cachedContent = "";
  const bigOutput = makeLines(THRESHOLD_LINES + 500);
  const result = handleEvent(
    {
      tool_name: "Bash",
      cwd: "/tmp/project",
      session_id: "s1",
      tool_use_id: "t1",
      tool_response: { stdout: bigOutput, stderr: "", interrupted: false, isImage: false },
    },
    (p, c) => {
      cachedPath = p;
      cachedContent = c;
    }
  ) as any;

  assert.ok(result);
  assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
  const updated = result.hookSpecificOutput.updatedToolOutput;
  // Must match Bash's own tool_response shape exactly, per Claude Code docs, or
  // Claude Code silently ignores the replacement and shows the original instead.
  assert.equal(typeof updated.stdout, "string");
  assert.equal(typeof updated.stderr, "string");
  assert.equal(typeof updated.interrupted, "boolean");
  assert.equal(typeof updated.isImage, "boolean");
  assert.ok(updated.stdout.length < bigOutput.length, "output should actually shrink");
  assert.ok(cachedContent.includes(bigOutput), "full original must be recoverable from cache");
  assert.ok(cachedPath.includes("s1") && cachedPath.includes("t1"));
});

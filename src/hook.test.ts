import { test } from "node:test";
import * as assert from "node:assert/strict";
import { handleEvent, truncateText, THRESHOLD_LINES, READ_THRESHOLD_LINES } from "./hook";

function makeLines(count: number, fill = "line"): string {
  return Array.from({ length: count }, (_, i) => `${fill} ${i}`).join("\n");
}

function noCache(): never {
  throw new Error("cache should not have been written");
}

test("truncateText: under threshold returns null (true no-op)", () => {
  assert.equal(truncateText(makeLines(THRESHOLD_LINES - 1)), null);
});

test("truncateText: over threshold truncates and reports omitted count", () => {
  const result = truncateText(makeLines(THRESHOLD_LINES + 500));
  assert.ok(result);
  assert.ok(result!.omittedLines > 0);
  assert.ok(result!.text.includes("lines omitted"));
});

test("truncateText: preserves an error line buried in the omitted middle", () => {
  const lines = makeLines(THRESHOLD_LINES + 500).split("\n");
  lines[Math.floor(lines.length / 2)] = "FATAL: something exploded at line 42";
  const result = truncateText(lines.join("\n"));
  assert.ok(result!.text.includes("FATAL: something exploded at line 42"));
});

test("truncateText: honours a custom threshold", () => {
  const text = makeLines(500);
  assert.equal(truncateText(text, 800), null, "under the higher threshold, untouched");
  assert.ok(truncateText(text, 300), "over the lower threshold, truncated");
});

// Regression: adversarial testing found a 5MB single-line payload passing
// through untouched, because the threshold only counted lines.
test("truncateText: catches a huge payload with no newlines at all", () => {
  const oneHugeLine = "x".repeat(5 * 1024 * 1024);
  const result = truncateText(oneHugeLine);
  assert.ok(result, "a 5MB one-liner must not pass through untouched");
  assert.ok(result!.text.length < 20000, "must actually shrink, drastically");
  assert.ok(result!.text.includes("characters omitted"));
});

test("truncateText: catches few-but-enormous lines", () => {
  const result = truncateText(Array.from({ length: 10 }, () => "y".repeat(500 * 1024)).join("\n"));
  assert.ok(result, "10 lines of 500KB each must not pass through untouched");
  assert.ok(result!.text.length < 20000);
});

test("truncateText: surfaces error lines even on the character-based path", () => {
  const text = "a".repeat(30000) + "\nFATAL: buried in a giant blob\n" + "b".repeat(30000);
  const result = truncateText(text);
  assert.ok(result!.text.includes("FATAL: buried in a giant blob"));
});

test("truncateText: a modest payload under both thresholds is still untouched", () => {
  assert.equal(truncateText("short output\nsecond line"), null);
});

test("handleEvent: unsupported tool is a no-op regardless of size", () => {
  const output = handleEvent(
    { tool_name: "Write", tool_response: { content: makeLines(THRESHOLD_LINES + 500) } },
    noCache
  );
  assert.equal(output, null);
});

test("handleEvent: small Bash output is a true no-op (no cache write, no output)", () => {
  const output = handleEvent(
    {
      tool_name: "Bash",
      cwd: "/tmp/project",
      session_id: "s1",
      tool_use_id: "t1",
      tool_response: { stdout: makeLines(10), stderr: "", interrupted: false, isImage: false },
    },
    noCache
  );
  assert.equal(output, null);
});

test("handleEvent: oversized Bash output caches original and matches Bash's shape", () => {
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
    (_p, c) => {
      cachedContent = c;
    }
  ) as any;

  const updated = result.hookSpecificOutput.updatedToolOutput;
  assert.deepEqual(Object.keys(updated).sort(), ["interrupted", "isImage", "stderr", "stdout"]);
  assert.ok(updated.stdout.length < bigOutput.length);
  assert.ok(cachedContent.includes(bigOutput), "full original must be recoverable");
});

test("handleEvent: Grep content mode truncates content and preserves sibling fields", () => {
  const bigContent = makeLines(THRESHOLD_LINES + 500);
  const result = handleEvent(
    {
      tool_name: "Grep",
      cwd: "/tmp/project",
      session_id: "s1",
      tool_use_id: "t2",
      tool_response: {
        mode: "content",
        numFiles: 3,
        filenames: [],
        content: bigContent,
        numLines: 800,
        totalLines: 800,
      },
    },
    () => {}
  ) as any;

  const updated = result.hookSpecificOutput.updatedToolOutput;
  assert.ok(updated.content.length < bigContent.length, "content should shrink");
  assert.equal(updated.mode, "content", "sibling fields must survive untouched");
  assert.equal(updated.numFiles, 3);
  assert.equal(updated.totalLines, 800);
});

test("handleEvent: Grep files_with_matches mode is left alone (filename arrays are not truncated)", () => {
  const output = handleEvent(
    {
      tool_name: "Grep",
      tool_response: {
        mode: "files_with_matches",
        filenames: Array.from({ length: 5000 }, (_, i) => `file${i}.ts`),
        numFiles: 5000,
        totalFiles: 5000,
      },
    },
    noCache
  );
  assert.equal(output, null);
});

test("handleEvent: WebFetch truncates result and preserves metadata fields", () => {
  const bigResult = makeLines(THRESHOLD_LINES + 500);
  const result = handleEvent(
    {
      tool_name: "WebFetch",
      cwd: "/tmp/project",
      session_id: "s1",
      tool_use_id: "t3",
      tool_response: {
        bytes: 12345,
        code: 200,
        codeText: "OK",
        result: bigResult,
        durationMs: 500,
        url: "https://example.com",
      },
    },
    () => {}
  ) as any;

  const updated = result.hookSpecificOutput.updatedToolOutput;
  assert.ok(updated.result.length < bigResult.length);
  assert.equal(updated.code, 200);
  assert.equal(updated.url, "https://example.com");
});

test("handleEvent: Read truncates the NESTED file.content and keeps the wrapper intact", () => {
  const bigFile = makeLines(READ_THRESHOLD_LINES + 500);
  const result = handleEvent(
    {
      tool_name: "Read",
      cwd: "/tmp/project",
      session_id: "s1",
      tool_use_id: "t4",
      tool_response: {
        type: "text",
        file: {
          filePath: "/tmp/project/big.txt",
          content: bigFile,
          numLines: 1300,
          startLine: 1,
          totalLines: 1300,
        },
      },
    },
    () => {}
  ) as any;

  const updated = result.hookSpecificOutput.updatedToolOutput;
  // The payload is nested — truncating a top-level `content` would be silently
  // ignored by Claude Code, so the nesting must be reproduced exactly.
  assert.equal(updated.type, "text");
  assert.ok(updated.file.content.length < bigFile.length);
  assert.equal(updated.file.filePath, "/tmp/project/big.txt");
  assert.equal(updated.file.totalLines, 1300);
});

test("handleEvent: Read uses its higher threshold (a 500-line read is untouched)", () => {
  const output = handleEvent(
    {
      tool_name: "Read",
      tool_response: {
        type: "text",
        file: { filePath: "/x.txt", content: makeLines(500), numLines: 500, startLine: 1, totalLines: 500 },
      },
    },
    noCache
  );
  assert.equal(output, null, "500 lines is over Bash's threshold but under Read's");
});

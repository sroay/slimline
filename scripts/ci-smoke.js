#!/usr/bin/env node
/**
 * Cross-platform smoke test: drives the BUILT hook the way Claude Code does —
 * a child process fed one JSON event on stdin — and asserts on what comes back.
 *
 * The unit suite covers the truncation logic. This covers the things that only
 * break on a real OS: path separators, directories with spaces in them, line
 * endings, process exit behaviour, and cache files actually landing on disk.
 *
 * Run: node scripts/ci-smoke.js
 */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.join(__dirname, "..", "dist", "hook.js");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

/** Feed one event to the hook exactly as Claude Code would. */
function runHook(input, env = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, SLIMLINE_DISABLED: "", ...env },
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function bigStdout(lines = 1000) {
  return Array.from({ length: lines }, (_, i) =>
    i === 500
      ? "ERROR: build failed at module 417"
      : `line ${i} of ordinary build chatter that is long enough to add up to real bytes`,
  ).join("\n");
}

function updatedOutput(stdout) {
  assert.ok(stdout.trim(), "hook produced no output");
  const parsed = JSON.parse(stdout);
  const updated = parsed?.hookSpecificOutput?.updatedToolOutput;
  assert.ok(updated, "reply carried no hookSpecificOutput.updatedToolOutput");
  return updated;
}

// A project directory with a space in its name: this project lives in one, and an
// unquoted path is the classic way a hook works locally and dies on someone else's box.
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline ci "));

try {
  check("oversized Bash output is replaced and shrinks", () => {
    const original = bigStdout();
    const { stdout, status } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_1",
      tool_name: "Bash",
      cwd: projectDir,
      tool_response: { stdout: original, stderr: "", interrupted: false, isImage: false },
    });

    assert.equal(status, 0, "hook should exit 0");
    const updated = updatedOutput(stdout);
    assert.ok(
      updated.stdout.length < original.length / 2,
      `expected a big reduction, got ${original.length} -> ${updated.stdout.length}`,
    );
  });

  check("the Bash reply keeps every field of the tool_response shape", () => {
    const { stdout } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_2",
      tool_name: "Bash",
      cwd: projectDir,
      tool_response: { stdout: bigStdout(), stderr: "", interrupted: false, isImage: false },
    });

    const updated = updatedOutput(stdout);
    // A shape mismatch is silently ignored by Claude Code, so every key must survive.
    assert.deepEqual(Object.keys(updated).sort(), ["interrupted", "isImage", "stderr", "stdout"]);
    assert.equal(typeof updated.stdout, "string");
    assert.equal(updated.interrupted, false);
    assert.equal(updated.isImage, false);
  });

  check("an error buried in the omitted middle is preserved", () => {
    const { stdout } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_3",
      tool_name: "Bash",
      cwd: projectDir,
      tool_response: { stdout: bigStdout(), stderr: "", interrupted: false, isImage: false },
    });

    const updated = updatedOutput(stdout);
    assert.match(updated.stdout, /ERROR: build failed at module 417/);
  });

  check("the cache file lands on disk under a path containing a space", () => {
    const original = bigStdout();
    runHook({
      session_id: "ci-session",
      tool_use_id: "call_4",
      tool_name: "Bash",
      cwd: projectDir,
      tool_response: { stdout: original, stderr: "", interrupted: false, isImage: false },
    });

    const cachePath = path.join(
      projectDir,
      ".claude",
      "slimline-cache",
      "ci-session",
      "call_4.txt",
    );
    assert.ok(fs.existsSync(cachePath), `expected a cache file at ${cachePath}`);
    const cached = fs.readFileSync(cachePath, "utf8");
    assert.ok(
      cached.includes("ERROR: build failed at module 417"),
      "cache should hold the output as received",
    );
  });

  check("the marker points at the cache path that actually exists", () => {
    const { stdout } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_5",
      tool_name: "Bash",
      cwd: projectDir,
      tool_response: { stdout: bigStdout(), stderr: "", interrupted: false, isImage: false },
    });

    const updated = updatedOutput(stdout);
    const match = updated.stdout.match(/cached at: (.+?) —/);
    assert.ok(match, "expected a cache marker in the replaced output");
    assert.ok(fs.existsSync(match[1]), `marker points at ${match[1]}, which does not exist`);
  });

  check("a large reply survives the pipe — no truncated JSON", () => {
    // Regression guard. process.stdout.write to a PIPE is synchronous on Windows but
    // asynchronous on macOS and Linux, so `write(); process.exit(0)` silently cut the
    // reply off mid-JSON there. Claude Code then discards it with no error, and the
    // hook does nothing while appearing installed. Caught by CI on macOS, invisible
    // on Windows. 50 long error lines push the reply past any pipe buffer so this
    // reproduces on the first try rather than by luck.
    const longError = "ERROR: " + "failure detail ".repeat(200);
    const lines = Array.from({ length: 2000 }, (_, i) =>
      i % 20 === 0 ? `${longError} #${i}` : `line ${i} of ordinary chatter`,
    );
    const { stdout, status } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_big",
      tool_name: "Bash",
      cwd: projectDir,
      tool_response: { stdout: lines.join("\n"), stderr: "", interrupted: false, isImage: false },
    });

    assert.equal(status, 0);
    assert.ok(stdout.length > 64 * 1024, `reply was ${stdout.length} bytes — too small to test this`);
    const updated = updatedOutput(stdout); // throws if the JSON arrived truncated
    assert.ok(updated.stdout.includes("ERROR:"), "error lines should survive");
  });

  check("small output passes through untouched", () => {
    const { stdout, status } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_6",
      tool_name: "Bash",
      cwd: projectDir,
      tool_response: { stdout: "all good\n", stderr: "", interrupted: false, isImage: false },
    });

    assert.equal(status, 0);
    assert.equal(stdout.trim(), "", "a no-op must print nothing, leaving the output alone");
  });

  check("CRLF line endings are handled, not doubled or dropped", () => {
    const crlf = bigStdout().split("\n").join("\r\n");
    const { stdout } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_7",
      tool_name: "Bash",
      cwd: projectDir,
      tool_response: { stdout: crlf, stderr: "", interrupted: false, isImage: false },
    });

    const updated = updatedOutput(stdout);
    assert.ok(updated.stdout.length < crlf.length / 2);
    assert.match(updated.stdout, /ERROR: build failed at module 417/);
  });

  check("a data-shaped Read is truncated", () => {
    const csv = Array.from({ length: 5000 }, (_, i) => `${i},alpha,beta,gamma,delta`).join("\n");
    const { stdout } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_8",
      tool_name: "Read",
      cwd: projectDir,
      tool_response: { file: { filePath: path.join(projectDir, "data.csv"), content: csv } },
    });

    const updated = updatedOutput(stdout);
    assert.ok(updated.file.content.length < csv.length / 2, "a big CSV should be cut");
  });

  check("a source-code Read is left alone at any size", () => {
    const source = Array.from(
      { length: 5000 },
      (_, i) => `export function helper${i}(): number { return ${i}; }`,
    ).join("\n");
    const { stdout } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_9",
      tool_name: "Read",
      cwd: projectDir,
      tool_response: { file: { filePath: path.join(projectDir, "registry.ts"), content: source } },
    });

    assert.equal(stdout.trim(), "", "source files must pass through whole — cutting them blinds the model");
  });

  check("SLIMLINE_DISABLED makes it an immediate no-op", () => {
    const { stdout, status } = runHook(
      {
        session_id: "ci-session",
        tool_use_id: "call_10",
        tool_name: "Bash",
        cwd: projectDir,
        tool_response: { stdout: bigStdout(), stderr: "", interrupted: false, isImage: false },
      },
      { SLIMLINE_DISABLED: "1" },
    );

    assert.equal(status, 0);
    assert.equal(stdout.trim(), "", "the kill switch must silence the hook entirely");
  });

  check("malformed stdin exits cleanly instead of breaking the tool call", () => {
    const { stdout, status } = runHook("{ not json at all");

    assert.equal(status, 0, "a hook that exits non-zero would surface an error to the user");
    assert.equal(stdout.trim(), "");
  });

  check("an unknown tool is ignored", () => {
    const { stdout, status } = runHook({
      session_id: "ci-session",
      tool_use_id: "call_11",
      tool_name: "Glob",
      cwd: projectDir,
      tool_response: { filenames: Array.from({ length: 5000 }, (_, i) => `/a/file${i}.ts`) },
    });

    assert.equal(status, 0);
    assert.equal(stdout.trim(), "", "Glob returns paths — cutting it would hide files");
  });

  check("the stats log is written next to the project", () => {
    const statsPath = path.join(projectDir, ".claude", "slimline-stats.jsonl");
    assert.ok(fs.existsSync(statsPath), `expected a stats log at ${statsPath}`);
    const lines = fs.readFileSync(statsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, "stats log should have entries");
    const first = JSON.parse(lines[0]);
    assert.equal(typeof first.truncated, "boolean");
    assert.equal(typeof first.beforeChars, "number");
  });

  console.log(`\n${passed} smoke checks passed on ${process.platform} / node ${process.version}`);
} finally {
  fs.rmSync(projectDir, { recursive: true, force: true });
}

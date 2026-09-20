import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  mergeHookIntoSettings,
  MATCHER,
  buildSelfTestInput,
  interpretSelfTest,
  runSelfTest,
} from "./install";
import { THRESHOLD_LINES, THRESHOLD_CHARS } from "./hook";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOK = "C:\\Users\\me\\node_modules\\slimline\\dist\\hook.js";

/** Pull the hooks array we care about out of a merged settings object. */
function postToolUse(settings: any): any[] {
  return settings.hooks.PostToolUse;
}

test("merge: absent settings gets a PostToolUse entry pointing at the hook", () => {
  const { settings, action } = mergeHookIntoSettings(undefined, HOOK);

  assert.equal(action, "added");
  const entries = postToolUse(settings);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, MATCHER);
  assert.deepEqual(entries[0].hooks[0], {
    type: "command",
    command: "node",
    args: [HOOK],
  });
});

test("merge: unrelated top-level settings keys survive untouched", () => {
  const existing = {
    permissions: { allow: ["mcp__whatever"] },
    model: "opus",
    env: { FOO: "bar" },
  };

  const { settings } = mergeHookIntoSettings(existing, HOOK);

  assert.deepEqual((settings as any).permissions, { allow: ["mcp__whatever"] });
  assert.equal((settings as any).model, "opus");
  assert.deepEqual((settings as any).env, { FOO: "bar" });
});

test("merge: somebody else's PostToolUse hooks are kept alongside ours", () => {
  const theirs = {
    matcher: "Write",
    hooks: [{ type: "command", command: "prettier", args: ["--write"] }],
  };

  const { settings } = mergeHookIntoSettings({ hooks: { PostToolUse: [theirs] } }, HOOK);

  const entries = postToolUse(settings);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], theirs);
});

test("merge: other hook events (PreToolUse, Stop) are kept", () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
      Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
    },
  };

  const { settings } = mergeHookIntoSettings(existing, HOOK);

  assert.equal((settings as any).hooks.PreToolUse.length, 1);
  assert.equal((settings as any).hooks.Stop.length, 1);
  assert.equal(postToolUse(settings).length, 1);
});

test("merge: running the installer twice does not duplicate the entry", () => {
  const first = mergeHookIntoSettings(undefined, HOOK);
  const second = mergeHookIntoSettings(first.settings, HOOK);

  assert.equal(second.action, "unchanged");
  assert.equal(second.changed, false);
  assert.equal(postToolUse(second.settings).length, 1);
});

test("merge: an existing slimline entry at a stale path is rewritten, not duplicated", () => {
  const stale = mergeHookIntoSettings(undefined, "/old/location/dist/hook.js");

  const { settings, action, changed } = mergeHookIntoSettings(stale.settings, HOOK);

  assert.equal(action, "updated");
  assert.equal(changed, true);
  const entries = postToolUse(settings);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].hooks[0].args, [HOOK]);
});

test("merge: statsDir is passed through as --stats-dir args", () => {
  const { settings } = mergeHookIntoSettings(undefined, HOOK, { statsDir: "D:\\stats" });

  assert.deepEqual(postToolUse(settings)[0].hooks[0].args, [HOOK, "--stats-dir", "D:\\stats"]);
});

test("merge: changing only the statsDir updates the existing entry in place", () => {
  const before = mergeHookIntoSettings(undefined, HOOK, { statsDir: "D:\\old" });

  const after = mergeHookIntoSettings(before.settings, HOOK, { statsDir: "D:\\new" });

  assert.equal(after.action, "updated");
  assert.equal(postToolUse(after.settings).length, 1);
  assert.deepEqual(postToolUse(after.settings)[0].hooks[0].args, [HOOK, "--stats-dir", "D:\\new"]);
});

test("merge: does not mutate the caller's settings object", () => {
  const existing = { hooks: { PostToolUse: [] as any[] } };

  mergeHookIntoSettings(existing, HOOK);

  assert.equal(existing.hooks.PostToolUse.length, 0);
});

test("merge: refuses to clobber a settings file that is not an object", () => {
  assert.throws(() => mergeHookIntoSettings("not json", HOOK), /settings/i);
  assert.throws(() => mergeHookIntoSettings([1, 2, 3], HOOK), /settings/i);
});

test("merge: refuses when hooks.PostToolUse is the wrong shape rather than overwriting it", () => {
  assert.throws(
    () => mergeHookIntoSettings({ hooks: { PostToolUse: "oops" } }, HOOK),
    /PostToolUse/i,
  );
});

test("merge: tolerates settings whose hooks key is absent but has other content", () => {
  const { settings, action } = mergeHookIntoSettings({ statusLine: { type: "command" } }, HOOK);

  assert.equal(action, "added");
  assert.equal(postToolUse(settings).length, 1);
  assert.deepEqual((settings as any).statusLine, { type: "command" });
});

// ---------------------------------------------------------------------------
// Self-test: proves the hook is actually honoured, rather than assuming it.
// Guards against claude-code#68951, where updatedToolOutput is silently ignored.
// ---------------------------------------------------------------------------

test("selfTest payload: is big enough to cross both truncation thresholds", () => {
  const input = buildSelfTestInput("/tmp/slimline-probe");

  assert.equal(input.tool_name, "Bash");
  const stdout = (input.tool_response as any).stdout as string;
  assert.ok(stdout.split("\n").length > THRESHOLD_LINES, "needs more lines than the line threshold");
  assert.ok(stdout.length > THRESHOLD_CHARS, "needs more chars than the char threshold");
  assert.equal(input.cwd, "/tmp/slimline-probe");
});

test("selfTest payload: carries the ids the hook needs to write a cache entry", () => {
  const input = buildSelfTestInput("/tmp/slimline-probe");

  assert.ok(input.session_id);
  assert.ok(input.tool_use_id);
});

test("interpretSelfTest: a shortened updatedToolOutput passes", () => {
  const response = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { stdout: "short", stderr: "", interrupted: false, isImage: false },
    },
  });

  const verdict = interpretSelfTest(response, "a".repeat(50000));

  assert.equal(verdict.ok, true);
});

test("interpretSelfTest: silence from the hook fails with a diagnosable reason", () => {
  const verdict = interpretSelfTest("", "a".repeat(50000));

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no output/i);
});

test("interpretSelfTest: unparseable output fails rather than being treated as success", () => {
  const verdict = interpretSelfTest("not json at all", "a".repeat(50000));

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /pars/i);
});

test("interpretSelfTest: a response without updatedToolOutput fails", () => {
  const verdict = interpretSelfTest(JSON.stringify({ suppressOutput: true }), "a".repeat(50000));

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /updatedToolOutput/);
});

test("interpretSelfTest: output that did not actually shrink fails", () => {
  const original = "a".repeat(50000);
  const response = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { stdout: original, stderr: "", interrupted: false, isImage: false },
    },
  });

  const verdict = interpretSelfTest(response, original);

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /smaller|shrink|reduc/i);
});

test("selfTest end to end: the built hook really does replace oversized output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline-selftest-"));
  try {
    const verdict = await runSelfTest(path.join(__dirname, "hook.js"), dir);
    assert.equal(verdict.ok, true, verdict.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

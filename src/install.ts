import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { THRESHOLD_CHARS, THRESHOLD_LINES } from "./hook";

/**
 * The tool names slimline hooks. Glob and Grep's files_with_matches mode are
 * deliberately absent — they return filename arrays, and cutting those hides paths.
 */
export const MATCHER = "Bash|Grep|Read|WebFetch";

/**
 * How we recognise a previously-installed slimline entry so a reinstall updates it
 * in place instead of stacking duplicates. Matches the shipped script path
 * (`.../dist/hook.js`) on either path separator.
 */
const HOOK_SCRIPT_PATTERN = /[\\/]dist[\\/]hook\.js$/i;

export interface MergeOptions {
  /** Where the savings log should be written, if not the session's own project. */
  statsDir?: string;
}

export interface MergeResult {
  settings: Record<string, unknown>;
  changed: boolean;
  action: "added" | "updated" | "unchanged";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildArgs(hookScriptPath: string, opts?: MergeOptions): string[] {
  return opts?.statsDir ? [hookScriptPath, "--stats-dir", opts.statsDir] : [hookScriptPath];
}

function isSlimlineEntry(entry: unknown): boolean {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (hook) =>
      isPlainObject(hook) &&
      Array.isArray(hook.args) &&
      typeof hook.args[0] === "string" &&
      HOOK_SCRIPT_PATTERN.test(hook.args[0]),
  );
}

/**
 * Add (or refresh) slimline's PostToolUse hook inside an existing settings object.
 *
 * This runs against a file the user already owns and may have spent real time on, so
 * the rule is: touch only our own entry, and refuse outright rather than guess when
 * the file isn't shaped the way we expect. Returns a new object; the input is never
 * mutated, so a caller that fails to write can leave the original alone.
 */
export function mergeHookIntoSettings(
  existing: unknown,
  hookScriptPath: string,
  opts?: MergeOptions,
): MergeResult {
  if (existing !== undefined && existing !== null && !isPlainObject(existing)) {
    throw new Error(
      "slimline: refusing to write — settings is not a JSON object. Fix or move the file and rerun.",
    );
  }

  const settings: Record<string, unknown> = existing ? structuredClone(existing) : {};

  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    throw new Error("slimline: refusing to write — settings.hooks is not an object.");
  }
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;

  if (hooks.PostToolUse !== undefined && !Array.isArray(hooks.PostToolUse)) {
    throw new Error("slimline: refusing to write — hooks.PostToolUse is not an array.");
  }
  const entries: unknown[] = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  hooks.PostToolUse = entries;

  const desired = {
    matcher: MATCHER,
    hooks: [{ type: "command", command: "node", args: buildArgs(hookScriptPath, opts) }],
  };

  const index = entries.findIndex(isSlimlineEntry);
  if (index === -1) {
    entries.push(desired);
    return { settings, changed: true, action: "added" };
  }
  if (isDeepStrictEqual(entries[index], desired)) {
    return { settings, changed: false, action: "unchanged" };
  }
  entries[index] = desired;
  return { settings, changed: true, action: "updated" };
}

/**
 * The shape Claude Code hands a PostToolUse hook for a Bash call. Only the fields
 * the probe needs are modelled here.
 */
export interface SelfTestInput {
  session_id: string;
  tool_use_id: string;
  tool_name: string;
  cwd: string;
  tool_response: { stdout: string; stderr: string; interrupted: boolean; isImage: boolean };
}

export interface SelfTestVerdict {
  ok: boolean;
  reason: string;
}

const PROBE_LINE =
  "slimline self-test probe line, long enough that a few hundred of these also cross the byte ceiling";

/**
 * A synthetic Bash result guaranteed to be oversized by both measures the hook uses,
 * so a no-op reply means the hook is broken rather than that the input was too small.
 */
export function buildSelfTestInput(cwd: string): SelfTestInput {
  const count = Math.max(
    THRESHOLD_LINES + 1,
    Math.ceil((THRESHOLD_CHARS + 1) / (PROBE_LINE.length + 1)),
  );
  const stdout = Array.from({ length: count }, (_, i) => `${PROBE_LINE} ${i}`).join("\n");
  return {
    session_id: "slimline-selftest",
    tool_use_id: `probe_${Date.now()}`,
    tool_name: "Bash",
    cwd,
    tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
  };
}

/**
 * Decide whether Claude Code would actually honour the hook.
 *
 * claude-code#68951 reports `updatedToolOutput` being ignored on some versions, and a
 * hook whose reply is dropped fails silently — no error anywhere. So the installer
 * checks the reply is well-formed and genuinely smaller instead of assuming success.
 */
export function interpretSelfTest(stdout: string, original: string): SelfTestVerdict {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: false, reason: "the hook produced no output for an oversized payload" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      reason: `could not parse the hook's reply as JSON: ${trimmed.slice(0, 200)}`,
    };
  }

  const updated = (parsed as any)?.hookSpecificOutput?.updatedToolOutput;
  if (!updated || typeof updated.stdout !== "string") {
    return { ok: false, reason: "the reply carried no hookSpecificOutput.updatedToolOutput.stdout" };
  }
  if (updated.stdout.length >= original.length) {
    return { ok: false, reason: "the replacement output was not smaller than the original" };
  }

  return {
    ok: true,
    reason: `${original.length} chars replaced with ${updated.stdout.length}`,
  };
}

/**
 * Run the installed hook script end to end against the probe payload.
 *
 * `SLIMLINE_DISABLED` is cleared for the child: this answers "can the hook work here",
 * which is a separate question from whether it is currently switched on.
 */
export function runSelfTest(
  hookScriptPath: string,
  cwd: string,
  extraArgs: string[] = [],
): Promise<SelfTestVerdict> {
  const input = buildSelfTestInput(cwd);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookScriptPath, ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SLIMLINE_DISABLED: "" },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", () => {});
    child.on("error", (err) =>
      resolve({ ok: false, reason: `could not run the hook script: ${err.message}` }),
    );
    child.on("close", () => resolve(interpretSelfTest(out, input.tool_response.stdout)));
    child.stdin.end(JSON.stringify(input));
  });
}

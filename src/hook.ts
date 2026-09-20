#!/usr/bin/env node
/**
 * Slimline PostToolUse hook.
 *
 * Reads a Claude Code PostToolUse event on stdin. If a supported tool's payload
 * exceeds its line threshold, replaces it with a head+tail truncation that preserves
 * error/failure-signal lines regardless of position, caches the full original to
 * disk, and points Claude at the cache file (retrievable via its own Read tool).
 * Under threshold: exits 0 with no output — a true no-op.
 *
 * Each tool's replacement must match that tool's own tool_response shape exactly,
 * or Claude Code silently ignores it. Shapes are verified empirically, not guessed —
 * see docs/tool-output-shapes.md.
 */
import * as fs from "fs";
import * as path from "path";
import { logEvent, StatsEvent } from "./stats";

export const THRESHOLD_LINES = 300;
// A file read is a deliberate request for content, not incidental noise, so it
// earns a higher bar before we interfere with it.
export const READ_THRESHOLD_LINES = 800;
export const HEAD_LINES = 40;
export const TAIL_LINES = 40;
export const MAX_SIGNAL_LINES = 50;

// Deliberately broad: false positives (an extra kept line) are harmless, false
// negatives (a missed real error) are the failure mode this exists to prevent.
export const SIGNAL_PATTERN = /\b(error|fail(?:ed|ure)?|exception|traceback|panic|fatal)\b/i;

export interface TruncationResult {
  text: string;
  omittedLines: number;
}

export function truncateText(
  text: string,
  thresholdLines: number = THRESHOLD_LINES
): TruncationResult | null {
  const lines = text.split("\n");
  if (lines.length <= thresholdLines) return null;

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES);
  const signalLines = middle.filter((line) => SIGNAL_PATTERN.test(line));

  const parts: string[] = [head.join("\n")];
  parts.push(`\n[... ${middle.length} lines omitted ...]\n`);

  if (signalLines.length > 0) {
    const shown = signalLines.slice(0, MAX_SIGNAL_LINES);
    parts.push(
      shown.length < signalLines.length
        ? `[${signalLines.length} possible error/failure line(s) found in the omitted region, showing first ${shown.length}]:`
        : `[${signalLines.length} possible error/failure line(s) found in the omitted region]:`
    );
    parts.push(shown.join("\n"));
  }

  parts.push(tail.join("\n"));

  return { text: parts.join("\n"), omittedLines: middle.length };
}

/** One payload within a tool_response that is a candidate for truncation. */
interface Payload {
  key: string;
  text: string;
}

/**
 * Per-tool adapter. Each tool stores its bulk payload in a different place —
 * Read nests it under file.content, Grep's location depends on its mode — so
 * extraction and reassembly are tool-specific by necessity.
 */
interface ToolSpec {
  thresholdLines: number;
  getPayloads(response: any): Payload[];
  withReplacements(response: any, replacements: Map<string, string>): object;
}

export const TOOL_SPECS: Record<string, ToolSpec> = {
  Bash: {
    thresholdLines: THRESHOLD_LINES,
    getPayloads(response) {
      const payloads: Payload[] = [];
      if (typeof response.stdout === "string") payloads.push({ key: "stdout", text: response.stdout });
      if (typeof response.stderr === "string") payloads.push({ key: "stderr", text: response.stderr });
      return payloads;
    },
    withReplacements(response, replacements) {
      return {
        stdout: replacements.get("stdout") ?? response.stdout,
        stderr: replacements.get("stderr") ?? response.stderr,
        interrupted: response.interrupted ?? false,
        isImage: response.isImage ?? false,
      };
    },
  },

  Grep: {
    thresholdLines: THRESHOLD_LINES,
    getPayloads(response) {
      // Only content mode carries a large string. files_with_matches/count return
      // filename arrays that are already modest, and cutting a file list risks
      // hiding a path Claude needs.
      if (response.mode !== "content" || typeof response.content !== "string") return [];
      return [{ key: "content", text: response.content }];
    },
    withReplacements(response, replacements) {
      return { ...response, content: replacements.get("content") ?? response.content };
    },
  },

  WebFetch: {
    thresholdLines: THRESHOLD_LINES,
    getPayloads(response) {
      if (typeof response.result !== "string") return [];
      return [{ key: "result", text: response.result }];
    },
    withReplacements(response, replacements) {
      return { ...response, result: replacements.get("result") ?? response.result };
    },
  },

  Read: {
    thresholdLines: READ_THRESHOLD_LINES,
    getPayloads(response) {
      if (!response.file || typeof response.file.content !== "string") return [];
      return [{ key: "file.content", text: response.file.content }];
    },
    withReplacements(response, replacements) {
      return {
        ...response,
        file: {
          ...response.file,
          content: replacements.get("file.content") ?? response.file.content,
        },
      };
    },
  },
};

interface PostToolUseInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_response?: any;
}

export function buildCachePath(cwd: string, sessionId: string, toolUseId: string): string {
  return path.join(cwd, ".claude", "slimline-cache", sessionId, `${toolUseId}.txt`);
}

export function handleEvent(
  input: PostToolUseInput,
  writeCache: (cachePath: string, content: string) => void,
  logStats: (event: StatsEvent) => void = () => {}
): object | null {
  const spec = input.tool_name ? TOOL_SPECS[input.tool_name] : undefined;
  if (!spec) return null;

  const response = input.tool_response;
  if (!response || typeof response !== "object") return null;

  const payloads = spec.getPayloads(response);
  if (payloads.length === 0) return null;

  const beforeChars = payloads.reduce((sum, p) => sum + p.text.length, 0);
  const record = (truncated: boolean, afterChars: number) =>
    logStats({
      ts: new Date().toISOString(),
      tool: input.tool_name!,
      sessionId: input.session_id || "unknown-session",
      truncated,
      beforeChars,
      afterChars,
      project: input.cwd ? path.basename(input.cwd) : undefined,
    });

  const truncated = new Map<string, TruncationResult>();
  for (const payload of payloads) {
    const result = truncateText(payload.text, spec.thresholdLines);
    if (result) truncated.set(payload.key, result);
  }
  if (truncated.size === 0) {
    record(false, beforeChars); // logged so the hit rate reflects what passed through untouched
    return null;
  }

  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "unknown-session";
  const toolUseId = input.tool_use_id || `slimline-${Date.now()}`;
  const cachePath = buildCachePath(cwd, sessionId, toolUseId);

  // Cache every payload, not just the truncated ones, so the cache file is a
  // faithful record of the whole original response.
  const cacheBody = payloads.map((p) => `=== ${p.key} ===\n${p.text}`).join("\n\n");
  writeCache(cachePath, cacheBody);

  // Deliberately says "as received", not "full original": Claude Code caps some
  // tool output before any hook sees it (Bash hard-cuts at 30,000 chars), so what
  // we cache is everything that reached us, which is not always everything the
  // command actually produced. Claiming otherwise would mislead a debugging loop.
  const marker = `\n\n[Output as received cached at: ${cachePath} — Read it if the above isn't enough]`;
  const replacements = new Map<string, string>();
  for (const [key, result] of truncated) replacements.set(key, result.text + marker);

  const afterChars = payloads.reduce(
    (sum, p) => sum + (replacements.get(p.key) ?? p.text).length,
    0
  );
  record(true, afterChars);

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: spec.withReplacements(response, replacements),
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function writeCacheToDisk(cachePath: string, content: string): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, content, "utf8");
}

/**
 * `--stats-dir <path>` sends the savings log somewhere central so one install can
 * monitor several projects and still report a single aggregate number.
 *
 * The cache deliberately does NOT follow it: Claude retrieves a cached original
 * with its own Read tool, and a path outside the session's working directory
 * triggers a permission prompt. Frictionless retrieval matters more than tidiness.
 */
function parseStatsDir(argv: string[]): string | undefined {
  const i = argv.indexOf("--stats-dir");
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: PostToolUseInput;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const statsDir = parseStatsDir(process.argv) || cwd;
  const output = handleEvent(input, writeCacheToDisk, (event) => logEvent(statsDir, event));
  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

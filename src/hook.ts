#!/usr/bin/env node
/**
 * Slimline PostToolUse hook (Bash-only, v1 slice).
 *
 * Reads a Claude Code PostToolUse event on stdin. If the Bash tool's stdout/stderr
 * exceeds a line threshold, replaces it with a head+tail truncation that preserves
 * any error/failure-signal lines regardless of position, caches the full original
 * to disk, and points Claude at the cache file (retrievable via its own Read tool).
 * Under threshold: exits 0 with no output — a true no-op.
 */
import * as fs from "fs";
import * as path from "path";

export const THRESHOLD_LINES = 300;
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

export function truncateText(text: string): TruncationResult | null {
  const lines = text.split("\n");
  if (lines.length <= THRESHOLD_LINES) return null;

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES);
  const signalLines = middle.filter((line) => SIGNAL_PATTERN.test(line));

  const parts: string[] = [head.join("\n")];
  parts.push(`\n[... ${middle.length} lines omitted ...]\n`);

  if (signalLines.length > 0) {
    const shown = signalLines.slice(0, MAX_SIGNAL_LINES);
    const note =
      shown.length < signalLines.length
        ? `[${signalLines.length} possible error/failure line(s) found in the omitted region, showing first ${shown.length}]:`
        : `[${signalLines.length} possible error/failure line(s) found in the omitted region]:`;
    parts.push(note);
    parts.push(shown.join("\n"));
  }

  parts.push(tail.join("\n"));

  return { text: parts.join("\n"), omittedLines: middle.length };
}

interface PostToolUseInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_response?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    isImage?: boolean;
  };
}

export function buildCachePath(cwd: string, sessionId: string, toolUseId: string): string {
  return path.join(cwd, ".claude", "slimline-cache", sessionId, `${toolUseId}.txt`);
}

export function handleEvent(
  input: PostToolUseInput,
  writeCache: (cachePath: string, content: string) => void
): object | null {
  if (input.tool_name !== "Bash") return null;

  const response = input.tool_response;
  if (!response || typeof response.stdout !== "string") return null;

  const stdoutResult = truncateText(response.stdout);
  const stderrResult = typeof response.stderr === "string" ? truncateText(response.stderr) : null;

  if (!stdoutResult && !stderrResult) return null; // true no-op, under threshold

  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "unknown-session";
  const toolUseId = input.tool_use_id || `slimline-${Date.now()}`;
  const cachePath = buildCachePath(cwd, sessionId, toolUseId);

  const original = [
    "=== stdout ===",
    response.stdout,
    "",
    "=== stderr ===",
    response.stderr || "",
  ].join("\n");
  writeCache(cachePath, original);

  const marker = `\n\n[Full original output cached at: ${cachePath} — Read it if the above isn't enough]`;

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: {
        stdout: stdoutResult ? stdoutResult.text + marker : response.stdout,
        stderr: stderrResult ? stderrResult.text + marker : response.stderr,
        interrupted: response.interrupted ?? false,
        isImage: response.isImage ?? false,
      },
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

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: PostToolUseInput;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const output = handleEvent(input, writeCacheToDisk);
  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

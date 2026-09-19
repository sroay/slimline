#!/usr/bin/env node
/**
 * Slimline savings log + reporter.
 *
 * Every hook invocation on a matched tool appends one line here, including the
 * ones that changed nothing — the no-ops are what make the hit rate meaningful.
 * Without them you can only see what was saved, never what flowed past untouched.
 *
 * Local-only. Nothing is transmitted anywhere.
 */
import * as fs from "fs";
import * as path from "path";

export interface StatsEvent {
  ts: string;
  tool: string;
  sessionId: string;
  truncated: boolean;
  beforeChars: number;
  afterChars: number;
}

/**
 * Rough heuristic, not a real tokenizer: ~4 chars per token for English/code.
 * Everything derived from it is reported as an estimate, never as a measurement.
 */
export const CHARS_PER_TOKEN = 4;

export function statsPath(cwd: string): string {
  return path.join(cwd, ".claude", "slimline-stats.jsonl");
}

export function logEvent(cwd: string, event: StatsEvent): void {
  try {
    const target = statsPath(cwd);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the tool call it is observing.
  }
}

export interface Summary {
  totalCalls: number;
  truncatedCalls: number;
  hitRate: number;
  charsBefore: number;
  charsAfter: number;
  charsSaved: number;
  estTokensSaved: number;
  reductionOnTruncated: number;
  reductionOverall: number;
  byTool: Record<string, { calls: number; truncated: number; charsSaved: number }>;
  firstSeen?: string;
  lastSeen?: string;
}

export function summarize(events: StatsEvent[]): Summary {
  const summary: Summary = {
    totalCalls: 0,
    truncatedCalls: 0,
    hitRate: 0,
    charsBefore: 0,
    charsAfter: 0,
    charsSaved: 0,
    estTokensSaved: 0,
    reductionOnTruncated: 0,
    reductionOverall: 0,
    byTool: {},
  };

  let truncatedBefore = 0;
  let truncatedAfter = 0;

  for (const e of events) {
    summary.totalCalls++;
    summary.charsBefore += e.beforeChars;
    summary.charsAfter += e.afterChars;

    const tool = (summary.byTool[e.tool] ??= { calls: 0, truncated: 0, charsSaved: 0 });
    tool.calls++;

    if (e.truncated) {
      summary.truncatedCalls++;
      tool.truncated++;
      tool.charsSaved += e.beforeChars - e.afterChars;
      truncatedBefore += e.beforeChars;
      truncatedAfter += e.afterChars;
    }

    if (!summary.firstSeen || e.ts < summary.firstSeen) summary.firstSeen = e.ts;
    if (!summary.lastSeen || e.ts > summary.lastSeen) summary.lastSeen = e.ts;
  }

  summary.charsSaved = summary.charsBefore - summary.charsAfter;
  summary.estTokensSaved = Math.round(summary.charsSaved / CHARS_PER_TOKEN);
  summary.hitRate = summary.totalCalls ? summary.truncatedCalls / summary.totalCalls : 0;
  summary.reductionOnTruncated = truncatedBefore ? 1 - truncatedAfter / truncatedBefore : 0;
  summary.reductionOverall = summary.charsBefore ? summary.charsSaved / summary.charsBefore : 0;
  return summary;
}

export function readEvents(cwd: string): StatsEvent[] {
  const target = statsPath(cwd);
  if (!fs.existsSync(target)) return [];
  return fs
    .readFileSync(target, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as StatsEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is StatsEvent => e !== null);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatReport(summary: Summary): string {
  if (summary.totalCalls === 0) {
    return "slimline: no activity recorded yet.\nRun some tool-heavy work first, then check again.";
  }

  const lines: string[] = [];
  lines.push("slimline savings report");
  lines.push("=".repeat(52));
  lines.push(`Window            ${summary.firstSeen ?? "?"} -> ${summary.lastSeen ?? "?"}`);
  lines.push(`Tool calls seen   ${summary.totalCalls}`);
  lines.push(`Calls truncated   ${summary.truncatedCalls}  (hit rate ${pct(summary.hitRate)})`);
  lines.push("");
  lines.push(`Characters in     ${summary.charsBefore.toLocaleString()}`);
  lines.push(`Characters out    ${summary.charsAfter.toLocaleString()}`);
  lines.push(`Characters saved  ${summary.charsSaved.toLocaleString()}`);
  lines.push("");
  lines.push(`Reduction on truncated calls   ${pct(summary.reductionOnTruncated)}`);
  lines.push(`Reduction across all calls     ${pct(summary.reductionOverall)}`);
  lines.push("");
  lines.push(`Est. tokens saved ~${summary.estTokensSaved.toLocaleString()}  [ESTIMATE: chars/4, not a real tokenizer]`);
  lines.push("");
  lines.push("By tool:");
  for (const [tool, s] of Object.entries(summary.byTool).sort((a, b) => b[1].charsSaved - a[1].charsSaved)) {
    lines.push(
      `  ${tool.padEnd(10)} ${String(s.calls).padStart(4)} calls, ${String(s.truncated).padStart(4)} truncated, ` +
        `${s.charsSaved.toLocaleString()} chars saved`
    );
  }
  lines.push("");
  lines.push("Note: 'reduction across all calls' counts only tool output passing through");
  lines.push("slimline, not your whole session (prompts, replies, and unmatched tools are");
  lines.push("not measured here), so it is not a whole-session quota saving figure.");
  return lines.join("\n");
}

if (require.main === module) {
  const cwd = process.argv[2] || process.cwd();
  console.log(formatReport(summarize(readEvents(cwd))));
}

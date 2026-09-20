#!/usr/bin/env node
/**
 * "What did it hide?" audit.
 *
 * Replays every cached original through the same truncation Claude saw, then
 * inspects what was dropped and rates how risky the omission looks. This covers
 * the one failure mode that testing cannot: truncation quietly removing
 * something that mattered, which otherwise depends on a human noticing a subtle
 * absence in the moment.
 *
 * It reports suspicion, not proof. A high rating means "go read this one", not
 * "this definitely broke something".
 */
import * as fs from "fs";
import * as path from "path";
import { computeOmission, SIGNAL_PATTERN } from "./hook";

/**
 * Things that often matter but that SIGNAL_PATTERN does not catch. Kept separate
 * from SIGNAL_PATTERN deliberately: widening that one costs tokens on every
 * truncation, whereas this list only ever runs after the fact.
 */
export const AUDIT_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "warning", re: /\b(warning|warn|deprecated)\b/i },
  { label: "refusal/permission", re: /\b(refused|denied|unauthorized|forbidden|permission)\b/i },
  { label: "missing thing", re: /\b(not found|missing|no such file|cannot|can't|unable to)\b/i },
  { label: "timeout", re: /\b(timeout|timed out|deadline exceeded)\b/i },
  { label: "assertion", re: /\b(assert|assertion|expected|unexpected)\b/i },
  { label: "stack frame", re: /\bat\s+\S+.*:\d+(:\d+)?/ },
  { label: "test summary", re: /\b\d+\s+(passing|failing|passed|failed|skipped|pending|errors?)\b/i },
  // Must tolerate "exit code 1", "exit status 2", "exited with code 3" and bare
  // "exit 1". Zero is excluded on purpose — a clean exit is not a finding.
  { label: "nonzero exit", re: /\bexit(ed)?\s+(with\s+)?((code|status)\s*[:=]?\s*)?[1-9]\d*\b/i },
  { label: "resource exhaustion", re: /\b(out of memory|oom|segfault|stack overflow|killed)\b/i },
];

export interface Finding {
  cacheFile: string;
  section: string;
  severity: "high" | "medium" | "low";
  omittedLines: number;
  hiddenSignalCount: number;
  uniqueRatio: number;
  reasons: string[];
  samples: string[];
}

/** Sections are written by the hook as `=== key ===` blocks. */
export function parseCacheFile(content: string): { key: string; text: string }[] {
  const sections: { key: string; text: string }[] = [];
  const parts = content.split(/^=== (.+?) ===$/m);
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({ key: parts[i], text: (parts[i + 1] ?? "").replace(/^\n/, "") });
  }
  return sections.length ? sections : [{ key: "(whole file)", text: content }];
}

/**
 * How repetitive the dropped region is. Digits are normalised so that
 * "compiling module_417" and "compiling module_912" count as the same shape —
 * cutting a thousand near-identical progress lines is safe; cutting a thousand
 * distinct ones is not.
 */
export function uniqueRatio(lines: string[]): number {
  if (lines.length === 0) return 0;
  const shapes = new Set(lines.map((l) => l.trim().replace(/\d+/g, "#")));
  return shapes.size / lines.length;
}

export function analyzeOmission(
  cacheFile: string,
  section: string,
  text: string
): Finding | null {
  const omission = computeOmission(text);
  if (omission.mode === "none" || omission.omitted.length === 0) return null;

  const reasons: string[] = [];
  const samples: string[] = [];

  if (omission.hiddenSignals.length > 0) {
    reasons.push(
      `${omission.hiddenSignals.length} error/failure line(s) were dropped without being surfaced ` +
        `(the cap of surfaced signals was exceeded)`
    );
    samples.push(...omission.hiddenSignals.slice(0, 3));
  }

  // Patterns worth a second look that the live signal regex does not cover.
  const alreadySurfaced = new Set(omission.surfacedSignals);
  for (const { label, re } of AUDIT_PATTERNS) {
    const hits = omission.omitted.filter(
      (line) => re.test(line) && !alreadySurfaced.has(line) && !SIGNAL_PATTERN.test(line)
    );
    if (hits.length > 0) {
      reasons.push(`${hits.length} hidden line(s) matching "${label}"`);
      if (samples.length < 6) samples.push(hits[0]);
    }
  }

  const ratio = uniqueRatio(omission.omitted);
  if (ratio > 0.5) {
    reasons.push(
      `dropped region is highly varied (${(ratio * 100).toFixed(0)}% distinct line shapes), ` +
        `so it was not just repetitive filler`
    );
  }

  if (reasons.length === 0) return null;

  const severity: Finding["severity"] =
    omission.hiddenSignals.length > 0
      ? "high"
      : reasons.some((r) => /matching "(nonzero exit|assertion|test summary|resource exhaustion)"/.test(r))
        ? "high"
        : reasons.length > 1 || ratio > 0.8
          ? "medium"
          : "low";

  return {
    cacheFile,
    section,
    severity,
    omittedLines: omission.omitted.length,
    hiddenSignalCount: omission.hiddenSignals.length,
    uniqueRatio: ratio,
    reasons,
    samples: samples.slice(0, 6).map((s) => (s.length > 160 ? s.slice(0, 160) + " …" : s.trim())),
  };
}

function findCacheFiles(projectDir: string): string[] {
  const root = path.join(projectDir, ".claude", "slimline-cache");
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const session of fs.readdirSync(root)) {
    const dir = path.join(root, session);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".txt")) out.push(path.join(dir, file));
    }
  }
  return out;
}

export function auditProjects(projectDirs: string[]): { findings: Finding[]; scanned: number } {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const dir of projectDirs) {
    for (const cacheFile of findCacheFiles(dir)) {
      scanned++;
      const content = fs.readFileSync(cacheFile, "utf8");
      for (const section of parseCacheFile(content)) {
        const finding = analyzeOmission(cacheFile, section.key, section.text);
        if (finding) findings.push(finding);
      }
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { findings, scanned };
}

export function formatAudit(findings: Finding[], scanned: number): string {
  const lines: string[] = [];
  lines.push("slimline omission audit");
  lines.push("=".repeat(72));
  lines.push(`Cached truncations scanned: ${scanned}`);

  if (scanned === 0) {
    lines.push("");
    lines.push("Nothing to audit yet — no truncations have been cached.");
    lines.push("Caches are cleared between runs, so do some real work first.");
    return lines.join("\n");
  }

  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;
  lines.push(`Flagged: ${findings.length}  (high ${high}, medium ${medium}, low ${findings.length - high - medium})`);

  if (findings.length === 0) {
    lines.push("");
    lines.push("No omissions look risky. Every dropped region was either repetitive");
    lines.push("filler or had its error lines surfaced.");
    return lines.join("\n");
  }

  for (const f of findings) {
    lines.push("");
    lines.push(`[${f.severity.toUpperCase()}] ${path.basename(f.cacheFile)} (${f.section})`);
    lines.push(`  dropped ${f.omittedLines.toLocaleString()} lines, ${(f.uniqueRatio * 100).toFixed(0)}% distinct`);
    for (const r of f.reasons) lines.push(`  - ${r}`);
    for (const s of f.samples) lines.push(`      > ${s}`);
    lines.push(`  full original: ${f.cacheFile}`);
  }

  lines.push("");
  lines.push("This flags suspicion, not proof. A HIGH rating means the dropped region");
  lines.push("deserves a look, not that something definitely broke.");
  return lines.join("\n");
}

if (require.main === module) {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = dirs.length ? dirs : [process.cwd()];
  const { findings, scanned } = auditProjects(targets);
  console.log(formatAudit(findings, scanned));
}

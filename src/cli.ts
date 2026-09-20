#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SettingsAction,
  MergeResult,
  mergeHookIntoSettings,
  removeHookFromSettings,
  runSelfTest,
} from "./install";

export type Scope = "user" | "project";
export type Command = "install" | "uninstall" | "doctor" | "help";

export interface CliOptions {
  command: Command;
  scope: Scope;
  statsDir?: string;
  dryRun: boolean;
}

const COMMANDS: readonly string[] = ["install", "uninstall", "doctor", "help"];

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { command: "help", scope: "user", dryRun: false };
  let i = 0;

  const first = argv[0];
  if (first !== undefined && !first.startsWith("-")) {
    if (!COMMANDS.includes(first)) {
      throw new Error(`slimline: unknown command "${first}". Run \`slimline help\`.`);
    }
    opts.command = first as Command;
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        opts.command = "help";
        break;
      case "--user":
        opts.scope = "user";
        break;
      case "--project":
        opts.scope = "project";
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--stats-dir": {
        const value = argv[++i];
        if (!value || value.startsWith("-")) {
          throw new Error("slimline: --stats-dir needs a directory path");
        }
        opts.statsDir = value;
        break;
      }
      default:
        throw new Error(`slimline: unknown option "${arg}". Run \`slimline help\`.`);
    }
  }

  return opts;
}

/**
 * User scope covers every local project from one place. Project scope writes to
 * `settings.local.json` rather than the shared `settings.json` — slimline is a
 * personal preference, and committing it would impose it on the whole team.
 */
export function resolveSettingsPath(
  scope: Scope,
  ctx: { home: string; projectDir: string },
): string {
  return scope === "user"
    ? path.join(ctx.home, ".claude", "settings.json")
    : path.join(ctx.projectDir, ".claude", "settings.local.json");
}

/**
 * Read, transform and write a settings file, with the read failure surfaced rather
 * than swallowed: a file we cannot parse is a file we must not overwrite, since
 * whatever is in there is the user's, not ours.
 */
export function applyToSettingsFile(
  settingsPath: string,
  transform: (existing: unknown) => MergeResult,
  opts?: { dryRun?: boolean },
): MergeResult {
  let existing: unknown;
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf8");
    if (raw.trim()) {
      try {
        existing = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `slimline: ${settingsPath} is not valid JSON, so it was left untouched. ` +
            `Fix it and rerun. (${(err as Error).message})`,
        );
      }
    }
  }

  const result = transform(existing);
  if (result.changed && !opts?.dryRun) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(result.settings, null, 2) + "\n", "utf8");
  }
  return result;
}

/**
 * Say plainly what happened, and — on a dry run — what merely would have. Conflating
 * the two would be the one lie that matters in a tool whose whole job is to edit a
 * settings file on the user's behalf.
 */
export function formatInstallOutcome(
  action: SettingsAction,
  settingsPath: string,
  dryRun: boolean,
): string {
  if (action === "unchanged") {
    return dryRun
      ? `slimline already installed in ${settingsPath} — nothing to do`
      : `slimline already installed in ${settingsPath}`;
  }
  if (action === "updated") {
    return dryRun
      ? `would update slimline in ${settingsPath}`
      : `slimline updated in ${settingsPath}`;
  }
  return dryRun ? `would add slimline to ${settingsPath}` : `slimline added to ${settingsPath}`;
}

/** The hook script as it sits inside the installed package, beside this file. */
function hookScriptPath(): string {
  return path.join(__dirname, "hook.js");
}

const HELP = `slimline — trim oversized Claude Code tool output to save subscription quota

Usage:
  slimline install [--project] [--stats-dir <dir>] [--dry-run]
  slimline uninstall [--project] [--dry-run]
  slimline doctor
  slimline help

Options:
  --project        write to this project's .claude/settings.local.json
                   (default: ~/.claude/settings.json, covering every local project)
  --stats-dir DIR  send the savings log to DIR instead of each project
  --dry-run        report what would change without writing

Notes:
  Cloud/web Claude Code sessions do not read ~/.claude/settings.json; those need
  the hook committed to the repo instead.
  Set SLIMLINE_DISABLED=1 to switch the hook off without editing any settings.
`;

async function runDoctor(): Promise<number> {
  const script = hookScriptPath();
  if (!fs.existsSync(script)) {
    console.error(`FAIL  hook script missing at ${script}`);
    return 1;
  }

  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline-doctor-"));
  try {
    const verdict = await runSelfTest(script, probeDir);
    console.log(verdict.ok ? `OK    hook works — ${verdict.reason}` : `FAIL  ${verdict.reason}`);
    if (!verdict.ok) {
      console.error(
        "      Some Claude Code versions ignore updatedToolOutput (claude-code#68951).",
      );
      return 1;
    }
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }

  if (process.env.SLIMLINE_DISABLED === "1" || process.env.SLIMLINE_DISABLED === "true") {
    console.log("NOTE  SLIMLINE_DISABLED is set, so the hook is currently a no-op.");
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  if (opts.command === "help") {
    console.log(HELP);
    return 0;
  }
  if (opts.command === "doctor") {
    return runDoctor();
  }

  const settingsPath = resolveSettingsPath(opts.scope, {
    home: os.homedir(),
    projectDir: process.cwd(),
  });

  try {
    if (opts.command === "install") {
      const script = hookScriptPath();
      const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline-"));
      let verdict;
      try {
        verdict = await runSelfTest(script, probeDir);
      } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
      }
      if (!verdict.ok) {
        console.error(`slimline: the hook did not work here, so nothing was installed.`);
        console.error(`  ${verdict.reason}`);
        console.error(`  Some Claude Code versions ignore updatedToolOutput (claude-code#68951).`);
        return 1;
      }

      const result = applyToSettingsFile(
        settingsPath,
        (existing) => mergeHookIntoSettings(existing, script, { statsDir: opts.statsDir }),
        { dryRun: opts.dryRun },
      );
      console.log(formatInstallOutcome(result.action, settingsPath, opts.dryRun));
      if (!opts.dryRun && result.changed) {
        console.log("Settings changes are picked up mid-session — no restart needed.");
      }
      return 0;
    }

    const result = applyToSettingsFile(settingsPath, removeHookFromSettings, {
      dryRun: opts.dryRun,
    });
    console.log(
      result.action === "absent"
        ? `slimline was not installed in ${settingsPath}`
        : `slimline removed from ${settingsPath}`,
    );
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

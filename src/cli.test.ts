import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseArgs,
  resolveSettingsPath,
  applyToSettingsFile,
  formatInstallOutcome,
} from "./cli";
import { mergeHookIntoSettings, removeHookFromSettings } from "./install";

const HOOK = "/opt/node_modules/slimline/dist/hook.js";

test("parseArgs: no arguments asks for help rather than installing something", () => {
  assert.equal(parseArgs([]).command, "help");
});

test("parseArgs: --help and -h ask for help", () => {
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["-h"]).command, "help");
});

test("parseArgs: install defaults to user scope so it covers every project", () => {
  const opts = parseArgs(["install"]);

  assert.equal(opts.command, "install");
  assert.equal(opts.scope, "user");
  assert.equal(opts.dryRun, false);
});

test("parseArgs: --project switches to project scope", () => {
  assert.equal(parseArgs(["install", "--project"]).scope, "project");
});

test("parseArgs: --stats-dir is carried through", () => {
  assert.equal(parseArgs(["install", "--stats-dir", "D:/central"]).statsDir, "D:/central");
});

test("parseArgs: --stats-dir without a value is an error, not a silent drop", () => {
  assert.throws(() => parseArgs(["install", "--stats-dir"]), /stats-dir/);
});

test("parseArgs: --dry-run is recognised", () => {
  assert.equal(parseArgs(["install", "--dry-run"]).dryRun, true);
});

test("parseArgs: uninstall and doctor are commands", () => {
  assert.equal(parseArgs(["uninstall"]).command, "uninstall");
  assert.equal(parseArgs(["doctor"]).command, "doctor");
});

test("parseArgs: an unknown command names itself in the error", () => {
  assert.throws(() => parseArgs(["instal"]), /instal/);
});

test("parseArgs: an unknown flag is rejected rather than ignored", () => {
  assert.throws(() => parseArgs(["install", "--frce"]), /--frce/);
});

test("applyToSettingsFile: creates the file and its .claude directory when absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline-cli-"));
  try {
    const target = path.join(dir, ".claude", "settings.json");

    const result = applyToSettingsFile(target, (s) => mergeHookIntoSettings(s, HOOK));

    assert.equal(result.action, "added");
    const written = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(written.hooks.PostToolUse.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyToSettingsFile: unrelated content in an existing file survives the write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline-cli-"));
  try {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ model: "opus", permissions: { allow: ["x"] } }));

    applyToSettingsFile(target, (s) => mergeHookIntoSettings(s, HOOK));

    const written = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(written.model, "opus");
    assert.deepEqual(written.permissions, { allow: ["x"] });
    assert.equal(written.hooks.PostToolUse.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyToSettingsFile: aborts on an unparseable settings file instead of overwriting it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline-cli-"));
  try {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, "{ this is not json");

    assert.throws(() => applyToSettingsFile(target, (s) => mergeHookIntoSettings(s, HOOK)), /JSON/i);
    assert.equal(fs.readFileSync(target, "utf8"), "{ this is not json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyToSettingsFile: dry run reports the action without touching the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline-cli-"));
  try {
    const target = path.join(dir, "settings.json");

    const result = applyToSettingsFile(target, (s) => mergeHookIntoSettings(s, HOOK), {
      dryRun: true,
    });

    assert.equal(result.action, "added");
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyToSettingsFile: uninstall round-trips back to the original content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slimline-cli-"));
  try {
    const target = path.join(dir, "settings.json");
    const original = { model: "opus" };
    fs.writeFileSync(target, JSON.stringify(original));

    applyToSettingsFile(target, (s) => mergeHookIntoSettings(s, HOOK));
    const result = applyToSettingsFile(target, removeHookFromSettings);

    assert.equal(result.action, "removed");
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatInstallOutcome: reads as a sentence for each action", () => {
  assert.equal(formatInstallOutcome("added", "/p", false), "slimline added to /p");
  assert.equal(formatInstallOutcome("updated", "/p", false), "slimline updated in /p");
  assert.equal(formatInstallOutcome("unchanged", "/p", false), "slimline already installed in /p");
});

test("formatInstallOutcome: a dry run says it would happen, not that it did", () => {
  assert.equal(formatInstallOutcome("added", "/p", true), "would add slimline to /p");
  assert.equal(formatInstallOutcome("updated", "/p", true), "would update slimline in /p");
  assert.equal(
    formatInstallOutcome("unchanged", "/p", true),
    "slimline already installed in /p — nothing to do",
  );
});

test("resolveSettingsPath: user scope targets the home settings file", () => {
  const p = resolveSettingsPath("user", { home: "/home/me", projectDir: "/work/app" });

  assert.equal(p, path.join("/home/me", ".claude", "settings.json"));
});

test("resolveSettingsPath: project scope targets settings.local.json, not the shared file", () => {
  const p = resolveSettingsPath("project", { home: "/home/me", projectDir: "/work/app" });

  assert.equal(p, path.join("/work/app", ".claude", "settings.local.json"));
});

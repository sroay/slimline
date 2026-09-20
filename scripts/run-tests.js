#!/usr/bin/env node
/**
 * Find the compiled test files and hand them to `node --test`.
 *
 * Not just `node --test "dist/*.test.js"`: the test runner only expands globs
 * itself on Node 21+, and an unquoted glob relies on the shell, which PowerShell
 * and cmd do not do. Resolving the list here works on every supported Node and
 * in every shell — including the Windows CI runners.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const distDir = path.join(__dirname, "..", "dist");
if (!fs.existsSync(distDir)) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}

const tests = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(distDir, name));

if (tests.length === 0) {
  console.error("no compiled test files found in dist/ — run `npm run build` first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
process.exit(result.status ?? 1);

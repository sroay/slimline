# Slimline — Claude Code tool-output compression (design)

Working name: **slimline**. Rename freely before build.

## Motivation

Inspired by [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom), which compresses
everything an agent reads (tool output, logs, RAG chunks) before it reaches the LLM. Headroom is built
around a local proxy sitting in front of `api.anthropic.com`/OpenAI-compatible endpoints, plus a Rust/Python
stack with an ML compression model, AST-aware code compression, cross-agent memory, and a savings dashboard.
That's a multi-month, multi-contributor project (169 releases, 274 contributors as of Sep 2026).

This design is a **much smaller, Claude-Code-native subset** aimed specifically at people running Claude
Code under a subscription plan (Pro/Max), where usage is metered by tokens processed against a rolling
weekly quota rather than per-token API billing. Goal: cut context bloat from huge tool outputs (the single
biggest identified waste source) without a proxy, without touching auth/network, and without materially
changing what Claude sees when it actually needs the full detail.

## Non-goals (v1)

- No local proxy / no MITM of the Anthropic API.
- No JSON/AST/ML-aware compression — pure size-based head+tail truncation only.
- No cross-agent memory, no output-verbosity/effort-routing, no telemetry/dashboard.
- Not a general port of Headroom — a narrow, native Claude Code plugin.

These may become later iterations, but are explicitly out of scope for the first build so it stays small
and shippable in a single session.

## Architecture

A `PostToolUse` hook (command-type, Node/TypeScript) matched to tool calls likely to produce oversized
output (`Bash`, `Grep`, `Read`, `WebFetch`, `WebSearch` — matcher: `Bash|Grep|Read|WebFetch|WebSearch`).

Flow per matched tool call:

1. Tool runs normally to completion (hooks fire *after* execution — the hook cannot reduce the work done,
   only what Claude sees afterward).
2. Hook receives the event JSON on stdin, including `tool_name` and `tool_response` (the tool's actual
   output, already produced).
3. Estimate the size of `tool_response` (line count / char count, not real tokenization — good enough for
   a threshold check).
4. If under threshold: hook exits 0 with no output. No-op, zero overhead on the common case.
5. If over threshold:
   - Write the full original `tool_response` content to a local cache file:
     `.claude/slimline-cache/<session_id>/<tool_use_id>.txt`.
   - Build a truncated replacement: head N lines + tail N lines + a marker line noting how much was
     omitted and the cache file path.
   - Return JSON on stdout:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PostToolUse",
         "updatedToolOutput": { /* must match this tool's own output shape */ }
       }
     }
     ```
6. Claude sees the truncated version. If the omitted middle turns out to matter, Claude just calls `Read`
   on the cache file path like any other file — no new tool, no MCP server, no retrieval protocol to teach it.

### Signal-aware truncation (refinement, not pure positional head+tail)

Motivation: Claude Code already runs autonomous build→test→fail→fix→retest loops on its own (this isn't
something slimline provides — it's inherent Claude Code agentic behavior). That loop is exactly where huge
tool outputs pile up (test suites, build logs, browser console dumps), so it's exactly where slimline's
savings matter most. But pure positional head+tail truncation risks hiding the actual error if it falls in
the omitted middle of a long log — which would silently break the self-fixing loop by removing the one
line Claude actually needed to react to. That's a real quality regression, not a hypothetical one, and
directly conflicts with the "without compromising quality" goal from day one.

Fix: truncation keeps head + tail **plus** any line matching a small set of failure-signal patterns
regardless of position — e.g. `error`, `fail`, `exception`, `traceback`, `panic`, non-zero exit indicators.
Those lines are pulled out and appended in an "important lines below" section rather than silently dropped
in the omitted middle. Cheap to implement (a regex pass over the omitted region before discarding it), and
directly protects the exact workflow (autonomous debug loops) where this tool is most valuable.

### Verified against official docs

Confirmed via `code.claude.com/docs/en/hooks.md` (fetched directly, not taken on trust from a sub-agent's
summary, which had the field name slightly wrong):

- `PostToolUse` hooks can return `hookSpecificOutput.updatedToolOutput`, which genuinely replaces what
  Claude sees for that tool call. Docs' own example redacts a `Bash` call's `stdout`.
- **Caveat that shapes the whole design**: *"a value that doesn't match the tool's output schema is
  ignored and the original output is used"* — silently, no error surfaced. So this is not one generic
  string-replace; each tool's `tool_response` has its own shape and the replacement must match it.
  - `Bash` confirmed exact shape from docs: `{ stdout, stderr, interrupted, isImage }`.
  - `Grep`, `Read`, `WebFetch`, `WebSearch` shapes are **not yet confirmed** — first build step is to log
    a few real `tool_response` payloads for each (a `PostToolUse` hook with matcher `*` that just dumps
    `tool_response` to a debug file is enough) and confirm the shape empirically before wiring truncation
    for that tool. Treat each tool as "add support once verified," not "assume it works."
- The tool has already fully executed by the time the hook fires — a giant command still runs to
  completion, a file still gets written. This only shrinks what enters context afterward, which is exactly
  what we want for quota/speed, but it does not skip work.

## Cache & retrieval

- Location: `.claude/slimline-cache/<session_id>/<tool_use_id>.txt` (gitignored).
- No retrieval tool/MCP server — Claude retrieves via its existing `Read` tool on the cache path embedded
  in the truncation marker. Zero new moving parts.
- Cache eviction: out of scope for v1 (add a simple max-age or max-size sweep later if it becomes a real
  disk-usage problem; not worth building preemptively).

## Configuration

- Threshold: a single configurable line/char count (e.g. env var or a small JSON config file), sensible
  default picked during build by testing against a real oversized Bash/Grep output.
- Head/tail line counts: also configurable, default something like 40 head + 40 tail lines.
- Matcher list (which tools get this treatment): start with `Bash|Grep|Read|WebFetch|WebSearch`, adjust
  based on which of these actually produce oversized output in practice.
- **Hook scope: register in `~/.claude/settings.json` (user-level), not the project's `.claude/settings.json`.**
  Per the docs, user-level settings apply to every project opened in Claude Code on this machine, which is
  what "works for all my sessions" requires. Caveat: Claude Code **cloud/web sessions don't read local
  `~/.claude/settings.json`** — they only pick up hooks committed into that project's repo. So this covers
  every local session automatically; a cloud session on a given repo would need the hook committed there too.
  The cache directory itself still writes per-project (relative to cwd), which is correct and needs no
  special handling even though the hook registration is global.

## Testing plan

1. Confirm `tool_response` shape for each targeted tool (see caveat above) before enabling truncation for it.
2. Run a command that produces genuinely huge output (e.g. a verbose build log, a wide-open grep) and
   confirm: (a) Claude's context shows the truncated version, (b) the cache file exists and contains the
   full original, (c) asking Claude to look closer causes it to `Read` the cache file successfully.
3. Confirm the no-op path: a small/normal tool output passes through completely unchanged (no cache file
   written, no truncation marker).
4. Confirm `updatedToolOutput` mismatches fail *silently* as documented — add a debug log line so a schema
   mismatch is at least visible to the developer, since Claude Code won't surface an error for it.

## Possible future extensions (explicitly not v1)

- Format-aware compression (JSON key-dedup, log dedup, code-aware truncation).
- Output-verbosity steering (terser Claude responses) and effort routing — the two other waste sources
  identified but deprioritized for v1.
- Cache eviction policy.
- Extending matcher coverage to more tools / MCP tool outputs once core shapes are proven out.
- **Redundant re-exploration** (Claude re-grepping/re-reading the same codebase context across turns or
  sessions instead of jumping straight to what it needs) — the third waste source identified during
  brainstorming. Decision: **don't build this** — adopt an existing tool instead. Headroom itself doesn't
  build this from scratch either; it leans on **Serena**, an existing open-source MCP server providing
  LSP-based semantic code navigation (jump to symbol/definition instead of grep-and-read-whole-file).
  Install/configure Serena as an MCP server whenever convenient — separate from slimline, no design work
  needed. Cheaper wins available today with zero build: maintaining `CLAUDE.md` project notes, and
  delegating wide searches to a subagent (e.g. the `Explore` agent) to keep exploration out of the main
  session's context.

## Packaging & distribution (open source, npm-published)

Decision: this will be given away for free as a properly installable npm package, not just a public
repo people copy-paste from.

- **Package layout**: a small npm package (name TBD — check availability before committing; "slimline" is
  a placeholder and may already be taken) containing the compiled hook script plus a tiny CLI entry point
  (e.g. `npx <name> init`) that writes/merges the `PostToolUse` hook entry into the user's
  `~/.claude/settings.json` and drops the compiled script somewhere stable (e.g. inside the installed
  package, referenced by an absolute `node_modules` path, or copied to `~/.claude/slimline/`). Hand-editing
  JSON is exactly the kind of friction an installer should remove for other people picking this up.
- **Build step**: source is TypeScript; ship compiled JS in the published package so end users don't need
  `ts-node` or a TS toolchain just to run a hook. Needs a `tsconfig.json` + build script, and one bin.
- **License**: MIT (simple, most permissive, standard for small dev-tool packages) unless there's a reason
  to match Headroom's Apache-2.0.
- **Docs**: a real top-level README — what it does, install command, config options, limitations
  (per-tool shape verification status), and a short note on how it differs from Headroom.
- **Repo hygiene**: `.gitignore` covering `node_modules`, `dist/`, and `.claude/slimline-cache/`; nothing
  hardcoded to this machine's paths — everything derived from cwd/env at runtime.
- **Publishing itself requires the user's own npm account** — logging in and running `npm publish` is a
  public, only-partially-reversible action (npm allows unpublish within a 72-hour window, then it's
  permanent), so that step happens with the user present and explicitly confirming, not run unattended.

This adds real scope on top of the core hook logic: CLI installer, build tooling, README, license/name
selection, and a supervised publish step. Revised total v1 estimate (core hook logic + npm packaging):
**roughly 3.5–4.5 hours** of build time, still realistically split across multiple sessions rather than
one sitting — versus ~2–2.5 hours for the hook logic alone without the packaging/distribution work.

## Cross-platform verification (CI matrix, required — not optional)

Decision: cross-platform correctness must be **tested, not assumed**. The Node/TS choice and careful use
of Node's `path` module make Windows/Mac/Linux compatibility likely, but "likely" isn't the bar for
something distributed to other people's machines.

- **GitHub Actions workflow** running the test suite on `windows-latest`, `macos-latest`, and
  `ubuntu-latest` (Linux included too — free to add on GH Actions, and plenty of Claude Code users are on
  Linux even though it wasn't explicitly asked about).
- **What the tests actually exercise**, since there's no real Claude Code process to drive in CI: invoke
  the built hook script directly as a child process, feeding it the same JSON on stdin that Claude Code
  would send (`tool_name`, `tool_response`, etc., using the real shapes confirmed per tool), and assert on:
  - stdout JSON matches the expected `hookSpecificOutput.updatedToolOutput` shape for an oversized input.
  - The cache file is written to the correct path and contains the untouched original.
  - A small/normal-sized input passes through as a true no-op (no cache file, no stdout).
  - Path handling specifically: a test case with a Windows-style absolute path in the input and one with a
    POSIX-style path, confirming the cache file path construction doesn't break on either OS.
- **This runs on every push**, so a change that works on the dev's machine but breaks on the other OS is
  caught before anyone installs it, not after.
- Genuine limitation this doesn't cover: CI proves the *script* behaves correctly on each OS. It does not
  prove Claude Code's own hook-invocation plumbing behaves identically everywhere — that part is already
  covered by the docs' explicit "fires the same wherever it runs" guarantee, not something this project
  can independently verify.

This adds a real test harness and CI workflow file on top of the hook logic and npm packaging. Revised
total v1 estimate: **roughly 4.5–5.5 hours** (hook logic + npm packaging + CI matrix), still splittable
across sessions.

## Upstream contribution to Headroom itself (separate from slimline)

Decision: pursue **both** slimline (this project) and a couple of scoped contributions back to Headroom
upstream — different goals, different codebases, do both rather than picking one.

Researched against Headroom's actual issue tracker (not just its README) before committing to scope:

- **[#869](https://github.com/headroomlabs-ai/headroom/issues/869)** confirms Headroom's proxy-based
  `wrap` **does not currently engage in Claude Desktop app / agent mode** — the Desktop app overrides
  `ANTHROPIC_BASE_URL` itself, so Headroom's routing never takes effect there. Still open.
- **[#84](https://github.com/headroomlabs-ai/headroom/issues/84)** — Headroom's own community has asked
  for clarity on whether/how it works for Claude subscription (Pro/Max) accounts at all. Still open.
- **[#1494](https://github.com/headroomlabs-ai/headroom/issues/1494)** — an existing, separate feature
  request for a "dev-safe conservative compression profile" that preserves stack traces, file paths,
  errors, and never touches project rule files (`AGENTS.md`, `README.md`, config files) — same idea as
  slimline's signal-aware truncation. A follow-up comment on that issue shows someone already tried a
  strict/lossless version and got **zero measurable savings** (rejected by Headroom's own internal
  size-floor/tokenizer logic), and that this is entangled with several other in-flight issues/PRs
  (#2116, #2823, #1877, #3013) — i.e. this is an active, unresolved, multi-contributor epic, not a quick
  isolated fix. Attempting the *whole* issue is out of scope; a narrow slice of it is not.

**Two scoped contribution targets, chosen for being small and self-contained rather than trying to solve
the whole epic:**

1. **Docs PR for #84**: document Claude subscription (Pro/Max) deployment accurately, including the
   Desktop-app override limitation from #869 as a known caveat. Pure documentation, no code risk, and we're
   unusually well-positioned for it — this is exactly what we researched firsthand for slimline's own design.
2. **Narrow code PR referencing #1494**: just the "preserve stack traces/file paths/line numbers/exact
   errors, never compress `AGENTS.md`/`README.md`/config files" rule — the same signal-aware idea already
   designed for slimline, ported to Headroom's compressors. Explicitly **not** attempting to fix the
   zero-savings/lossless-mode bug also discussed on that issue — that's a separate, harder, already
   being-investigated problem.

**Honest assessment of impact**: both are genuine, real improvements for Headroom's broader user base (the
docs fix saves other subscription users the same confusion; the compression guard is a real safety
improvement other users have already asked for) — but modest and specific, not a fix for Headroom's deeper
unresolved issues, and contingent on maintainers actually reviewing and merging either PR.

**Sequencing**: this is downstream of slimline, not a blocker to it — build/ship slimline first (it's the
thing that actually works in the user's own environment today), then port the proven signal-aware logic
upstream once it exists and is tested, rather than designing it twice in parallel.

## Decisions recap (from brainstorming session, 2026-09-16)

| Question | Decision |
|---|---|
| Primary metric | Both subscription-quota tokens and session speed |
| Architecture | Claude Code native (hooks), not a proxy |
| First priority | Verbose/huge tool outputs (not output-verbosity or dedup, yet) |
| Language | Node.js/TypeScript |
| Reversibility | Yes — cache original, retrievable via plain `Read` |
| Compression strategy | Simple size-based head+tail truncation, not format-aware |
| Distribution | Open source, published as an installable npm package (not just a public repo to copy-paste from) |
| Cross-platform proof | Required GitHub Actions CI matrix (Windows/Mac/Linux) — tested, not assumed |
| Truncation quality | Signal-aware, not pure positional — always preserve error/failure lines regardless of position, to protect autonomous debug loops |

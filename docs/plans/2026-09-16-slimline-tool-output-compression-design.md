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

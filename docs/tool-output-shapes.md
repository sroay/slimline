# Verified `tool_response` shapes

Captured empirically on 2026-09-20 by wiring `scripts/shape-logger.js` as a temporary `PostToolUse` hook
and making one real call per tool (Claude Code desktop app, Windows).

This matters because a `updatedToolOutput` value that doesn't match the tool's own output shape is
**silently ignored** — Claude Code shows the original output and surfaces no error. Guessing is not viable;
every shape below differs from the others, and two of them are nested.

| Tool | Where the bulk payload lives | Type | Notes |
|---|---|---|---|
| `Bash` | `stdout`, `stderr` | string (top level) | Also `interrupted`, `isImage`. **Implemented in v1.** |
| `Grep` (mode `content`) | `content` | string | Alongside `mode`, `numFiles`, `filenames[]`, `numLines`, `totalLines` |
| `Grep` (mode `files_with_matches`) | `filenames` | array of strings | Different shape from the same tool — handling must be `mode`-aware |
| `Glob` | `filenames` | array of strings | Already carries its own `truncated` boolean — self-limits |
| `Read` | `file.content` | string, **nested one level** | Sibling `file.filePath`, `file.numLines`, `file.startLine`, `file.totalLines`; wrapper has `type` |
| `WebFetch` | `result` | string | Alongside `bytes`, `code`, `codeText`, `durationMs`, `url` |
| `WebSearch` | `results` | array of `{ tool_use_id, content[] }` | Deeply nested; most complex of the set |

## Implications for implementation

1. **`Grep` needs mode-aware handling.** The same tool returns a string payload in `content` mode and an
   array payload in `files_with_matches` mode. One code path cannot serve both.
2. **`Read` is nested.** Truncating `content` at the top level would produce a shape mismatch and be
   silently dropped — the exact failure the design warned about.
3. **`Glob` and `Grep`/`files_with_matches` are low-value targets.** They return filename arrays which are
   usually modest, and Glob already self-truncates. Cutting a file list also risks hiding a path Claude
   needs. Recommend skipping both.
4. **`WebSearch` is the most complex and least urgent** — deeply nested arrays, moderate payload size.
   Defer until the simpler string-payload tools are proven.

Recommended implementation order after Bash: `Grep` (content mode) → `WebFetch` → `Read` (with a higher
threshold than Bash, since a file read is a deliberate request for content rather than incidental noise).

## Findings from live testing (2026-09-20)

All three of `Grep` (content), `Read`, and `WebFetch` were implemented and verified live in a real session,
alongside the already-working `Bash`. Two findings worth recording:

1. **`WebFetch` is a low-value target.** Its `result` field holds a *model-generated answer* about the
   fetched page, not the raw page content — WebFetch already compresses by design. In practice the payload
   almost never approaches the threshold, so this adapter will rarely fire. Harmless to keep, but it should
   not be counted toward expected savings.
2. **The signal pattern is noisy on source code.** Grepping TypeScript source flagged 66 "error/failure"
   lines that were mostly identifiers (`function fail(...)`, `error` variable names) rather than real
   failures. The `MAX_SIGNAL_LINES` cap of 50 bounds the damage, and the tradeoff is deliberate — a false
   positive costs one kept line, a false negative loses the error that a debug loop needed. Worth revisiting
   only if it proves noisy in practice on real sessions.

`Read` was the important one to get right: its payload is nested under `file.content`, and the live test
confirmed the nested replacement is accepted rather than silently dropped (1200 lines → 86, with an error
line buried at position 700 preserved).

## Claude Code caps Bash output at 30,000 chars BEFORE any hook runs

Found by monitoring real traffic on 2026-09-20, and it corrects an assumption baked into the original design.

A deliberately generated 2,500-line (~100KB) Bash output arrived at the hook as **exactly 30,000
characters**. This matches the Bash tool's own documented behaviour ("if the output exceeds 30000
characters, output will be truncated"). The cut is naive: it keeps the head and discards everything after,
mid-line if necessary.

Three consequences, all of which matter:

1. **The per-call savings ceiling is 30,000 chars (~7,500 tokens), not the command's true output size.**
   Savings estimates must not be extrapolated from raw command output — a 100KB log and a 30KB log present
   identically to the hook. Measured on the real call: 30,000 → 3,527 chars, an 88% reduction, ~6,600
   estimated tokens saved on that single call. Real and worthwhile, but bounded.
2. **The cache is not always the complete original.** For output over the cap, the tail was already
   discarded before slimline existed in the pipeline. The truncation marker now says "Output as received"
   rather than "Full original output" — overclaiming here would actively mislead a debugging loop that went
   looking for something the cache never had.
3. **Slimline still improves on the native cap, for a reason worth stating.** Claude Code's built-in
   truncation keeps only the head, so the *end* of a long run — exit status, summary line, final error — is
   exactly what gets thrown away. Slimline keeps head **and** tail **and** surfaced error lines within a
   far smaller budget. So the win is not only fewer tokens, it is better-chosen tokens.

Whether `Read`, `Grep`, and `WebFetch` have equivalent upstream caps has not been verified. Worth checking
before quoting savings figures for them.

## Version sensitivity — a real distribution risk

A web search turned up [anthropics/claude-code#68951](https://github.com/anthropics/claude-code/issues/68951):
`updatedToolOutput` reported as **silently ignored for the built-in Bash tool** on versions 2.1.163/2.1.177,
described as a regression, with earlier reports (#65403, #67442, #54196) closed as duplicates without a fix.
Related: [#32105](https://github.com/anthropics/claude-code/issues/32105) requesting `updatedToolOutput` for
built-in tools at all.

We verified it working live on the version in this environment, so this is not universally broken — but it
confirms the mechanism has been version-dependent. **Consequence for the npm package**: the CLI installer
must run a self-test (feed a synthetic oversized payload through the hook and confirm the replacement
actually took effect) rather than assuming the mechanism works on the user's version. Silent failure with
no error is the worst possible failure mode for a tool whose whole purpose is invisible background savings.

## Reproducing

`scripts/shape-logger.js` is kept in the repo for exactly this purpose. Wire it as a `PostToolUse` hook
with a matcher for the tools you want to inspect, make a real call to each, then read `.claude/shapes.jsonl`.
It logs structure and short samples only, never full payload content.

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

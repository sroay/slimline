# slimline

A Claude Code hook that trims oversized tool output before it reaches the model — keeping the head, the tail, and every line that looks like an error — and caches the original so Claude can read it back if it needs to.

No proxy. No network interception. No new tools. One `PostToolUse` hook.

## Be realistic about what this saves

Measured across 30 days of real Claude Code transcripts (1,827 sessions, 89.6B tokens, read from the `usage` block of every assistant turn):

| Where the tokens actually go | Share |
| --- | --- |
| Conversation history re-sent each turn (cache read) | 96.3% |
| Cache writes | 3.4% |
| **Tool output entering context** | **~2.1%** |
| Model output | 0.3% |

**Tool-output compression has a ceiling of roughly 2%.** The dominant cost is that every token in your context gets re-billed on every later turn — about 28.5× on average. Session cost grows with the *square* of session length.

So before installing this, do the thing that's worth 10–50×:

- `/clear` between unrelated tasks instead of carrying one session all day
- Delegate wide searches to a subagent so the bulk never enters your main thread
- Don't resume marathon sessions

slimline is worth having once you've done that — it's free, it runs locally, and it protects long autonomous loops from drowning in log output. It is not a fix for a 19,000-turn session.

## Install

```bash
npm install -g slimline && slimline install
```

This writes a `PostToolUse` hook into `~/.claude/settings.json`, covering every local project. It refuses to install if the hook doesn't actually work on your Claude Code version (see [Verify](#verify)).

Per-project instead, into `.claude/settings.local.json`:

```bash
slimline install --project
```

Preview without writing anything:

```bash
slimline install --dry-run
```

Settings changes are picked up mid-session — no restart needed.

## Verify

```bash
slimline doctor
```

```
OK    hook works — 30892 chars replaced with 8410
```

This matters: [claude-code#68951](https://github.com/anthropics/claude-code/issues/68951) reports `updatedToolOutput` being silently ignored on some Claude Code versions. A hook whose reply is dropped fails with no error anywhere, so `install` runs this probe first and aborts rather than leaving you with a hook you believe is working.

## What it does to output

A 1,000-line build log becomes something like:

```
[first 40 lines]
… slimline: 960 lines omitted (30,000 → 3,527 chars) …
[50 lines matching error/fail/exception/traceback/panic/fatal]
[last 40 lines]
Full output as received: .claude/slimline-cache/<session>/<tool_use_id>.txt
```

Claude reads that cache file with its own `Read` tool when it needs the detail. The cache stays inside the project so retrieval doesn't trigger a permission prompt.

## Tool coverage

| Tool | Behaviour |
| --- | --- |
| `Bash` | Truncated when oversized |
| `Grep` (content mode) | Truncated when oversized |
| `Read` | **Data-shaped files only** — `.csv`, `.log`, `.jsonl`, `.json`, `.map`, lock files, minified bundles |
| `WebFetch` | Truncated when oversized (rarely fires — its result is already a model-written answer) |
| `Glob`, `Grep` (files mode) | Never touched — they return filename lists, and cutting those hides paths |

`Read` deliberately leaves source and markdown alone at any size. Truncation assumes the omitted middle is filler; that's true for logs and false for code. Cutting a 6,000-line component blinds the model, and the tokens come straight back as re-reads.

## Measure it yourself

```bash
slimline install --stats-dir /path/to/central
npm run stats    # savings report
npm run audit    # what truncation actually hid
```

`stats` logs every matched call including no-ops, so the hit rate is honest rather than flattering. `audit` replays cached originals through the same truncation and rates each omission high/medium/low — it will tell you if error lines were dropped past the signal cap.

Expect a hit rate near zero on small, clean projects. That's a real answer, not a misconfiguration: on one 34-test zero-dependency repo, 46 tool calls produced 0 truncations, median payload 274 chars.

## Turn it off

```bash
SLIMLINE_DISABLED=1          # per-shell
setx SLIMLINE_DISABLED 1     # Windows, persistent
slimline uninstall           # remove the hook entirely
```

`uninstall` removes only slimline's own entry and prunes the empty containers it leaves behind. Everything else in your settings file is untouched.

## Limits worth knowing

- **Claude Code caps `Bash` output at 30,000 characters before any hook runs.** Per-call savings top out around 7,500 tokens — never extrapolate from raw command size. slimline still beats that cap, because the cap keeps only the head and throws away the end (exit status, final error) while slimline keeps head, tail *and* error lines.
- **The cache is the output as received**, which for `Bash` may already be capped upstream. It is not always the complete original.
- **Cloud and web Claude Code sessions don't read `~/.claude/settings.json`.** Those need the hook committed into the repo.
- Whether `Read`/`Grep`/`WebFetch` have similar upstream caps is unverified.
- The signal regex is noisy on source code, which is part of why `Read` is restricted to data-shaped files.

## How it works

Claude Code sends every matching tool result to the hook on stdin. The hook replies with `hookSpecificOutput.updatedToolOutput`, which replaces what the model sees. Each tool has a different response shape — `Read` nests under `file.content`, `Grep` returns a string or an array depending on mode — so a per-tool adapter table normalises them. A shape mismatch is silently ignored by Claude Code, which is why the shapes were verified empirically rather than assumed. See [docs/tool-output-shapes.md](docs/tool-output-shapes.md).

## Development

```bash
npm install
npm run build
npm test
```

Prior art: [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom), which is far larger — Rust/Python, an ML compression model, a proxy server. slimline targets one waste source with one hook, partly because headroom's proxy-based `wrap` doesn't engage in Claude Desktop app mode.

## License

MIT

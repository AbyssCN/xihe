# CLI — main entry for every host

[← docs index](../README.md) · [getting started](getting-started.md) ·
[MCP tools](mcp-tools.md) · [workflow](workflow.md) ·
[architecture](../architecture/overview.md)

`omd <command> [args]` is the engine's single binary entry point. Every MCP tool exposed by
`omd mcp` has a named subcommand here, plus an escape hatch (`omd call`) and a diagnostics
command (`omd doctor`). For MCP-native hosts (Claude Code, Codex) the stdio server stays the
primary integration; for cron, CI, the omd TUI and any host that cannot speak MCP, this CLI is
the only path that exists.

## Why a CLI exists (three on-disk facts)

| Fact | Source | Structural response |
|---|---|---|
| A long-lived MCP server runs the code it was started with; this repo ships ~50 commits/day, so an MCP process started two days ago is silently stale | `dag_status` first line | CLI loads from disk on every invocation — no staleness surface |
| The high-value calls do not depend on in-process state: `solve --detached` already spawns an independent worker; state lives in sqlite + `.omd/continuity/`; ignition-gate refusals are textual | `scripts/goal-worker.ts` + `cli-solve.ts` headers | CLI and MCP share `assembleOmdMcpTools()` and dispatch by name; zero second execution path |
| MCP only works for Claude; Codex, Antigravity, opencode, cron, omd's own TUI, and any non-MCP host must use a process | owner ruling 2026-09-05 | one binary, every host |

The iron rule follows `cli-solve`'s **INV-1**: **zero second execution semantics**. The CLI does
not import any `engine`/`goal`/`hooks` internal; the only execution path is "assemble the same
tool table → look up the handler by name → call it". Any shortcut inside the CLI is rejected.

## Install

Same as `omd mcp` — one binary:

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install && bun link      # puts `omd` on PATH
omd init                     # keys, preset, .env
```

After install, every command below is reachable from any directory:

```bash
omd status <runId>          # check a running run
omd result <runId> --json   # fetch final result, machine-readable
omd run "add a /health route"
omd solve --sdd docs/plan/foo.md --detached
omd doctor                  # diagnose jail + ecosystem prerequisites
```

## Patterns

### `--json` for pipes

Every command supports `--json`. Without it, output is the human-readable text the handler
returned (concatenated `text` segments). With it, output is `JSON.stringify(handler content)`,
so `omd status <runId> --json | jq .status` works in a pipe.

### `--detached` for fire-and-forget

`omd run "<task>" --detached` spawns the same worker process that `solve --detached` uses, and
prints the new `runId` immediately. The engine outlives your shell — exit 0 from the CLI does
not mean the run finished; poll with `omd status <runId>`.

### `--cwd` for non-current repos

The default working directory is `process.cwd()`. Pass `--cwd <path>` to point at a different
repo (the worker process inherits it; sqlite and `.omd/` state live there).

### Exit codes (single mapping, INV-3)

| Code | Meaning |
|---|---|
| `0` | success — handler ran, returned a normal content |
| `1` | the call shape was wrong (handler threw, args couldn't parse, tool not found) |
| `2` | the handler refused — business-level "no", not a crash |

Logs always go to stderr; only the result lands on stdout. Pipe-friendly by construction.

## Engine commands

| Command | Maps to | Notes |
|---|---|---|
| `omd run "<task>"` | `run` | dispatch a task; in-process by default. With `--detached`, spawns the worker and prints `runId` |
| `omd run "<task>" --fixture <dir>` | (legacy) | the fixture loader path; kept unchanged, see [workflow](workflow.md) |
| `omd solve "<goal>"` · `omd solve --sdd <path>` | `solve` | has its own CLI adapter (`cli-solve.ts`); headless autonomous run with repair rounds |
| `omd run-plan <plan.json>` | `dag_run_plan` | execute a pre-built plan JSON directly; `--resume` skips checkpointed green nodes |
| `omd status <runId>` | `dag_status` | one-line summary plus running node, if any |
| `omd result <runId>` | `dag_result` | full final result, with `sessionId` / `nodes` / `writeset` / `verification` |
| `omd runs [--limit N]` | `dag_runs` | list runs merged from memory + on-disk checkpoints |
| `omd resume <runId>` | `dag_resume` | reload the plan from its checkpoint, re-run only non-green nodes |
| `omd cancel <runId>` | `dag_cancel` | cooperative stop; ends `cancelled`, resumable |
| `omd intervene <runId> "<directive>"` | `dag_intervene` | record a human intervention; powers the avoidability readout |
| `omd node-output <runId> <nodeId>` | `dag_node_output` | one node's artifact |
| `omd research "<question>"` | `dag_research` | multi-lens research, judged synthesis |
| `omd review` | `dag_review` | adversarial multi-dimension diff review |
| `omd debug "<symptom>"` | `dag_debug` | parallel multi-hypothesis debug fleet |
| `omd deepen` | `dag_deepen` | architecture-hotspot scan → leverage-ranked report |
| `omd slim` | `dag_slim` | over-engineering, deletion-only audit fleet |
| `omd triage <runId>` | `dag_triage` | owner inbox — decision forks a running graph raised |
| `omd rule <runId> "<ruling>"` | `dag_rule` | rule on a triage fork; the ruling becomes a verbatim owner directive |

## Map commands (decision maps)

| Command | Maps to | Notes |
|---|---|---|
| `omd map init` | `map_init` | initialize the pathfinder backend (probe + recommendation, or set `backend`) |
| `omd map open` | `map_open` | list / create / resume decision maps |
| `omd map add --title <t> --blocked-by <ids>` | `map_add` | add a typed ticket (`research` · `grill` · `prototype` · `task`) |
| `omd map tickets` | `map_tickets` | show the frontier; folds in landed background results |
| `omd map rule <ticketId> "<ruling>"` | `map_rule` | adjudicate a decision onto the map |
| `omd map confirm <ticketId>` | `map_confirm` | accept or reject a machine-suggested ticket |
| `omd map deliver` | `map_deliver` | the power gate — compile the clear region to a slice, run the DAG |
| `omd map prefetch` | `map_prefetch` | dispatch frontier research to detached background processes |

## Memory commands

| Command | Maps to | Notes |
|---|---|---|
| `omd memory recall` | `memory_recall` | hybrid semantic + lexical search over the fact store |
| `omd memory fact <id>` | `memory_fact` | fetch one fact in full, with per-anchor staleness |
| `omd memory remember` | `memory_remember` | store a verified fact; gated by namespace safeguards |

## Config commands

| Command | Maps to | Notes |
|---|---|---|
| `omd env` | `omd_env` | what the engine detects about the repo: languages, test runners, acceptance candidates |
| `omd config status` | `omd_config_status` | every seat, its model, whether the credential is present |
| `omd config set-key` | `omd_set_key` | set a provider key |
| `omd config set-model` | `omd_set_model` | set a model coordinate (`provider:model`) |
| `omd config set-role` | `omd_set_role` | bind a role to a model |
| `omd config preset` | `omd_apply_preset` | apply a wizard preset (base-opencode-go · cn-standard · cn-ultimate) |
| `omd config register-provider` | `omd_register_provider` | register an OpenAI-compatible provider |
| `omd config models-auto` | `omd_models_auto` | auto-assign per-node models by channel economics |
| `omd config hud` | `omd_toggle_hud` | toggle the statusline HUD |

## Misc commands

| Command | Maps to | Notes |
|---|---|---|
| `omd shapes` | `omd_shapes` | the graph-shape catalogue; call once before decomposing |
| `omd primitive` | `omd_primitive` | run one control-flow primitive directly, no graph |
| `omd web` | `omd_web` | search + fetch, zero LLM |
| `omd distill` | `omd_distill` | distil insight from text you already have |
| `omd plans` | `omd_plans` | list saved plans |
| `omd history read` | `history_read` | read conversation history |
| `omd history search` | `history_search` | search conversation history |

## The `call` escape hatch

`omd call <tool> [--json '<obj>' | --key value ...]` reaches **any** MCP tool, named or not.
This is the universal adapter when a command has no shorthand:

```bash
omd call memory_recall --query "branch strategy" --limit 5
omd call my_custom_tool --json '{"foo":"bar"}'
```

The first form parses flags into the handler argument object (kebab-case → camelCase, numbers
auto-detected, `--flag` alone is `true`). The `--json` form takes exactly one JSON object and
hands it through verbatim. There is no flag-splitting fallback — `--json` is all-or-nothing.

## `doctor` — diagnose jail + ecosystem

`omd doctor [repo]` runs the same probes the ignition gate uses, and prints a one-line per
problem plus a final count. Output looks like:

```
fatal | bwrap 在这台机器上起不来 | unprivileged user namespace disabled
warn  | no git bind            | add gitBinds
doctor: 1 fatal / 1 warn
```

`fatal` exits with code `1`; `warn` does not. Default `repo` is `process.cwd()`.

## What's not in the CLI (MCP_ONLY)

Some tools intentionally have no CLI shorthand. They live in the MCP layer for reasons that
do not translate to a one-shot command:

| Tool | Why no CLI command |
|---|---|
| `conductor_chat` | Multi-turn session state lives in `serve` / the TUI; a one-shot CLI invocation has no session to attach to |

If you find yourself wanting one of these from a script, the right primitive is usually
`omd run` against a small wrapper, not a CLI command.

## Getting help

- `omd --help` — prints USAGE (the registry-driven command list plus the legacy
  `mcp`/`tui`/`serve`/`init`/... section, all generated from the table).
- `omd <command> --help` — every named command renders its `--key <type>` flags from the
  underlying tool's `inputSchema`, with 必填 / 可选 markers.
- Full MCP-tool reference: [MCP tools](mcp-tools.md) — every command here maps to one
  row of that table.

## See also

| | |
|---|---|
| [MCP tools](mcp-tools.md) | the full raw API every command here wraps |
| [Workflow](workflow.md) | when to reach for `run` vs `solve` vs `map_*` |
| [Model config](model-config.md) | the seat matrix the config commands edit |
| [Architecture overview](../architecture/overview.md) | the engine shape these commands target |

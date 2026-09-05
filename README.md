<p align="center">
  <img src="assets/diagrams/omd-layers.svg" alt="Where omd sits: your coding agent on top, omd underneath over MCP, then memory and models" width="920">
</p>

<p align="center">
  <strong>The orchestration layer under your coding agent.</strong>
</p>

<p align="center">
  <a href="docs/guide/mcp-tools.md"><img src="https://img.shields.io/badge/MCP%20tools-50-c9a227?style=flat&colorA=140f0a" alt="50 MCP tools"></a>
  <a href="docs/architecture/model-layer.md"><img src="https://img.shields.io/badge/seats-18-6f9488?style=flat&colorA=140f0a" alt="18 seats"></a>
  <a href="docs/guide/skills.md"><img src="https://img.shields.io/badge/skills-22-6f9488?style=flat&colorA=140f0a" alt="22 skills"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat&colorA=140f0a" alt="Bun"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-c9a227?style=flat&colorA=140f0a" alt="MIT"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="docs/why-omd.md">Why omd exists</a> · <a href="docs/driving-omd.md">Give this to your agent</a>
</p>

Your agent says it's done. omd doesn't take its word for it.

**50** MCP tools · **13** control-flow primitives · **18** model seats · **22** shipped pipelines · **6,818** tests.

## Install

```sh
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install && bun link
omd init
```

Then point your agent at it:

```sh
cd <your-project> && claude mcp add omd -- omd mcp
```

`omd init` asks for keys, offers three preset model matrices, probes each provider, and writes `.env`. First server start drops 22 skills into `~/.claude/skills/` — idempotent, never clobbers one you edited. Not on npm yet, so the clone is the install.

After install, **`omd` is a CLI first, MCP server second**. The same `omd` binary runs every MCP
tool as a named subcommand, an escape hatch (`omd call`), and a diagnostic (`omd doctor`) — so
cron, CI, TUI and any non-MCP host can drive the engine without spawning an MCP server. See
the [CLI guide](docs/guide/cli.md) for the full command reference.

Then tell your agent: *read `docs/driving-omd.md`, then use omd to…* — that file is the operating guide, written for the agent rather than for you.

## Where omd sits

Every coding harness shipping today owns the turn. Sample the model, run its tools, feed the result back, repeat, and stop when the model says it's finished. They compete on context compaction and sandbox depth, and they compete well — but the forward pass that wrote the code is the same one grading it. There is nowhere else for a verdict to come from without leaving the session.

omd leaves it. The unit of work is a node in a typed graph, and the graph is a file: `{ nodes[], outputs[] }`, zod-validated. A node has declared inputs, so it can be scheduled, checkpointed, resumed, priced, and judged on its own. A turn has none of that.

Keep the agent you already use. omd is what it calls when the job is bigger than one conversation.

## What it does

### 01 · The finish line is an exit code

Most harnesses end a task when the model writes "done". omd ends one when a `command` node exits with the code the plan declared — `tsc`, your suite, your script. Zero model in that node, so nothing can be argued into passing. Two more checks run beside it without asking: write-set reconciliation compares the files a node *claims* it wrote against the ones it actually touched, and an artifact gate looks on disk for the file it named. A node that reports a file it never created fails there.

### 02 · The criterion sits an exam before anything trusts it

A test that passes against everything is indistinguishable from a test that passes for the right reason — unless you check. So before an acceptance command is believed, the engine runs it twice in a throwaway copy of the repo: once **before any work exists**, and once against a **deliberately wrong artifact** the classifier had to hand over alongside the command. Green either time and the goal is demoted to exploratory instead of banking a fake pass.

This gate found its own bug that way. It fired zero times across 69 runs — and a number that never moves is usually measuring the ruler, not the thing. The "wrong world" had been an empty temp dir, where `bun test` fails no matter what you put in it. Now it's a real repo copy.

### 03 · A different model on every node

`node.model` beats `template.model` beats auto-assign, and a model you pin explicitly is never overwritten — [`stamp-pass.ts:66`](src/harness/plan-passes/stamp-pass.ts). Cheap models where volume is high and an oracle catches mistakes, a strong one where being wrong is expensive, and a *different family* wherever something needs a second opinion. Auto-assign fills the 18 seats by channel economics; pin any of them and every resolver reads that one value.

### 04 · The second opinion comes from another family

When no exit code can settle it — is this summary faithful? does this design meet the contract? — a verifier reads the result against the original requirement. It runs on a different model family than the author on purpose: same family, same blind spots, and the bad plan it wrote is a bad plan it can't see. Its brief is to attack the result, not to bless it. Fail escalates: stronger conductor, re-plan, and only the rejected nodes re-run.

### 05 · Interrupted work resumes instead of restarting

Every finished node lands on disk atomically. `dag_resume` reloads the plan from that checkpoint, re-hashes each node's inputs, and keeps every unchanged node green — and unbilled. Only the rest runs again. `solve --detached` hands the loop to a worker process that outlives your session: close the client, the graph keeps going.

### 06 · Retrieval with no model in it

`omd_web` searches and fetches with zero LLM in the loop. Full text lands on disk; only an index comes back to your context. Gaps close by re-crawling the source that's missing, never by a model filling one in from memory. On the same question, a cheap-seat run cost **$2.19** and reproduced **13 of the 15** facts a 106-agent frontier workflow had verified — because coverage is decided by retrieval, and retrieval is the part with no model in it.

## Pipelines ship as graphs, not prompts

<p align="center">
  <img src="assets/diagrams/omd-pipeline-research.svg" alt="The deep-research pipeline: four stages, four models, and a fetch step with no model in it" width="920">
</p>

A skill in your harness is a prompt — it can only ask the one model in front of you to behave differently. A pipeline picks a model per stage, and puts a deterministic command on the end.

| | |
|---|---|
| `/omd-research-deep` | seeded crawl → lens fan-out → judge panel → gap rounds. Four stages, four models |
| `/omd-grill` → `/omd-contract` | argue the design, then write the spec the engine executes |
| `/omd-review` | multi-dimension diff review, every finding falsified cross-model |
| `/omd-debug` | reproduce → scope lock → parallel hypotheses → verify |
| `/omd-path` · `/omd-rule` · `/omd-deliver` | a decision map in git, ruled by you, delivered on your trigger |

Build your own the same way — hand `dag_run_plan` a graph and name the model on each node:

```jsonc
{
  "nodes": {
    "draft_a":  { "goal": "…", "executor": "leaf", "model": "deepseek:deepseek-v4-pro" },
    "draft_b":  { "goal": "…", "executor": "leaf", "model": "minimax-cn:MiniMax-M3" },
    "critique": { "goal": "…", "executor": "leaf", "model": "openai-codex:gpt-5.6-sol",
                  "depends_on": ["draft_a", "draft_b"] },
    "gate":     { "goal": "run the suite", "executor": "command",
                  "command": "bun test", "expect_exit": 0, "depends_on": ["critique"] }
  },
  "outputs": ["gate"]
}
```

Cross-family best-of-N with a hard gate on the end, and you chose every seat in it.

## The one thing omd will not do

`map_deliver` is a trigger you pull. Automation researches, fetches, plans and argues on its own; it does not decide to start writing files. For anything unattended — and anything that touches the open web — pass `branchStrategy: 'branch'` and the run gets its own git worktree plus a jail. The engine never merges that branch back. You read the diff.

## Docs

| | |
|---|---|
| [Driving omd](docs/driving-omd.md) | the operating guide — hand it to your agent |
| [Why omd exists](docs/why-omd.md) | the long argument: which layer, and who decides correctness |
| [Getting started](docs/guide/getting-started.md) · [CLI guide](docs/guide/cli.md) · [MCP tools](docs/guide/mcp-tools.md) · [Model config](docs/guide/model-config.md) · [Skills](docs/guide/skills.md) · [Deep research](docs/guide/deep-research.md) | install, the CLI / tool surface, the seats |
| [Architecture](docs/architecture/overview.md) · [DAG engine](docs/architecture/dag-engine.md) · [Goal loop](docs/architecture/goal-loop.md) · [Primitives](docs/architecture/primitives.md) | node kinds, the four pure passes, scheduling, isolation |
| [Silent failures](docs/silent-failures.md) | every defect family this engine shipped with no red light |

## License

MIT — see [LICENSE](LICENSE).

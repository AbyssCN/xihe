# The goal loop — `solve`

[← architecture overview](overview.md) · [dag engine](dag-engine.md) ·
[model layer](model-layer.md) · [primitives](primitives.md) ·
[engine flow diagram](../diagrams/01-engine-flow.md)

Hand the engine a *plan* and [`run` executes it](dag-engine.md). Hand it a **goal** and
`solve` wraps that same machine in a bounded outer sequence: classify what "done" means,
write a contract, execute, judge, re-expand — until a frozen criterion goes green or a stop
axis fires. This page is that outer sequence.

`src/harness/goal/run-goal.ts`. A goal comes in and the engine walks a **fixed stage
sequence** — `classify → survey → research → spec → execute` — with no human step between
them. The sequence itself is **strictly acyclic**; the loop lives one level down, inside the
execute node.

## Classification produces two independent axes

One call, two answers (`src/harness/goal/classify-acceptance.ts`):

- **cost tier** — how much machinery this goal deserves;
- **acceptance kind** — `executable` (a command plus the exit code that counts as success)
  — for web repos (an `index.html` entry plus a usable chromium) the classifier may hand back a declarative
  `web_oracle` spec instead of a command; the engine materializes it to `.omd/acceptance/web-oracle.json`,
  freezes it before the first dispatch, and the command becomes `bun run <engine>/scripts/web-oracle.ts <spec>`
  (a real browser drives the page and asserts DOM state — see `docs/plan/2026-09-11-web-oracle-执行契约.md`)
  or `exploratory` (no machine criterion; a learning goal plus an affordable loss).

The axes are independent on purpose, and forcing the tier deliberately does **not** override
the acceptance axis — the classification still runs. "This goal is cheap" and "this goal has
no machine criterion" are different statements, and one knob for both would let the first
silently answer the second.

## The acceptance criterion is frozen outside the loop

The whole anti-cheating story rests on one property: **the executor cannot move the goalposts.**
So the criterion is computed at classify time and then pinned in two places the loop cannot
reach — the task text handed to the conductor, and an out-of-graph `accept` node built by
`runGoal` itself (`executor: 'command'`, `expect_exit` from the spec). The conductor never
authors it and the inner judge cannot edit it.

That handles a moving goalpost. It does **not** handle a goalpost that was hollow to begin
with, which is what `src/harness/goal/acceptance-gate.ts` adds — two probes, both **fail-open**
(they harden, they are not preconditions):

| Probe | Question | Verdict when it fires |
|---|---|---|
| vacuity | run the command *before any work happens* — does it already pass? | passing here means it is unrelated to this task |
| discrimination | make the classifier produce a **known-wrong** artifact, run the command against it in a temp world | still passing means right and wrong answers both satisfy it |

A criterion that cannot fail is not a criterion. The probe verdict is a five-way vocabulary
(`passed-both` / `vacuity-only` / `demoted` / `skipped` / `exploratory`) and it is persisted
per run, so "was this goal actually judged by anything" is a readable number rather than a
belief.

## The loop is inside the node, and it re-expands rather than re-runs

Both LLM-driven stages compile to a **single `executor: 'conductor'` node** — `goal-contract`
(bounded by `specRounds`) and `goal-execute` (bounded by `maxRounds`). A conductor node draws
a subgraph at runtime and schedules it locally, and its rounds are the loop.

The round semantics matter: each round hands the previous failure reason back to the conductor
and it **draws a new subgraph**. Re-running the same graph can only redo the same work;
redrawing can add a step the previous round did not have at all — which is why the loop needs
no back-edge in the graph itself.

A run-level fixpoint used to sit above this. It was **withdrawn** (D-F, 2026-07-30): two
verify layers meant double cost and an argument about which one owned convergence. What
survived the withdrawal is `judge_final` — with no outer layer left to ask "did the overall
goal happen", the last round has to ask it, or `solve` would be reduced to reading "it
finished" as "it worked", which is the most comfortable entrance for a false completion.

Per round, two gates report separately (`RoundVerdict` in `src/harness/continuity/types.ts`):

1. **the frozen criterion**, run directly by the engine — deliberately *not* as a child node,
   because the judge renders children and would simply copy the answer;
2. **the inner judge**, asked afterwards.

Green criterion ends the loop; the judge's vote on that round is **recorded, not obeyed**.
Both three-state vocabularies stay unflattened — `criterion: 'none'` (nothing was configured)
is not "the criterion failed", and `judge: 'unreachable'` is not "the judge said no". Flatten
either and the combination worth observing — criterion green while the judge says no, i.e.
a judge that is too strict — is buried under noise.

## Four stop axes, none of them "ask the model if we are done"

`max_rounds` (schema-capped at 4) · token / wall-clock budget (`loopBudget`) · deterministic
idle detection (a round that re-expands to exactly the previous subgraph exits `BLOCKED`) ·
convergence. An unreachable judge exits immediately as `infra-error` rather than burning the
remaining rounds on a deterministic fault.

The outcomes are a vocabulary, not a boolean (`src/harness/run-outcome.ts`), because the
*next action* differs: `blocked` needs external input, `budgetStopped` usually just needs more
budget and a resume, `infra-error` means fix the engine, `not-converged` means the rounds ran
out. `RunGoalResult.criteria` additionally exposes the judge and oracle bits separately —
without that pair, "the criterion passed but the judge refused" has no cell to live in.

When a run ends badly, the recorded `error` is a **diagnostic block and nothing else**
(`src/harness/goal/summarize-goal-failure.ts`): termination reason with that outcome's next
action, converged, rounds, both criteria (absent is written as "never judged", never as
false), then only the non-success stages. It used to be the full goal summary, which opens
with the goal text — in the measured case, roughly 1500 characters of task description
before the actual reason. The `succeed` and `cancel` paths still use the full summary; they
want the whole picture, not a diagnosis.

## Detached — surviving the session that started it

An MCP server is stdio: it dies with its client, so an in-flight goal used to die with the
conversation and "unattended" was physically impossible on that path. `solve detached=true`
spawns `scripts/goal-worker.ts` as a detached, `unref`'d child that loads the same tool
assembly and calls the same handler — **zero new execution path**. Logs go to
`.omd/goal-logs/<runId>.log` and any later session can poll `dag_status`.

The parent deliberately does **not** register the run: the worker is the owner, and pid-based
liveness has to point at the owner. A parent-owned record would be judged "interrupted" by the
next session that hydrates it. The cost is a millisecond-wide window where the run is not yet
findable, and a spawn failure must fail loudly on the spot rather than return a `runId` that
will never appear.

## Three gates against unattended re-dispatch

An unattended heartbeat re-dispatched one goal ticket ~55 times over 3.5 days, because
per-call round and budget caps cannot see across calls. The fix is three gates, none of them
prose (2026-08-10, `edc28d1`):

| Gate | Where | What it counts |
|---|---|---|
| A | `src/harness/pathfinder/dispatch.ts` + `afk-hook.ts` | real spawns per ticket (`.goal-attempts`; idempotent hits do not count); over the cap → escalate to a human |
| B | `afk-hook.ts` | exploratory goals — no machine criterion — escalate on the **first** non-convergence, because an opinion loop can say "not yet" forever |
| C | `run-goal.ts` | resume with the same `runId` and a byte-identical goal reuses the classification and the contract stage (`goal-state.json`, keyed by a sha256 of the full goal text) |

Gate C's key is exact by construction: change one character of the goal and the state is void.
Without continuity there is no `runId` to anchor to and the gate simply does not arm — the
behaviour is then identical to before.
## Cost shape of a goal

`solve` adds its own overhead on top of the graphs it runs ([graph-level cost is
here](dag-engine.md#cost-shape-of-a-graph)): one classification call, a conductor
re-expansion per round in each of the two stages, and one judge call per round —
including the last one, which is what `judge_final` buys and it is not free. Both stages
record separately under the same `runId`, so the cost of one goal is the sum of its two graph
records, rather than a number that has to be reconstructed afterwards.

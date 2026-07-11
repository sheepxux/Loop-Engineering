# Protocol v1

`loop.yaml` is the immutable contract for a recurring agent workflow:

```text
goal → discovery → handoff → verification → persistence → schedule → safety
```

Task strategy lives separately in `strategy.json`. A strategy candidate cannot modify the contract.

## Required sections

- `metadata`: stable name, owner, description, risk, tags.
- `goal`: objective, acceptance, stop, and blocked conditions.
- `discovery`: bounded sources, deterministic-first ranking, item cap.
- `handoff`: worker role, isolation, typed permissions, prompt.
- `verification`: independent evaluator, evidence types, commands, verdicts.
- `persistence`: repository-relative paths under the loop directory.
- `schedule`: runtime, cadence, timezone, timeout, concurrency.
- `runner` (optional): dry-run or command executor.
- `safety`: budgets, retries, typed action gates, failure policy.
- `evolution` (optional): external task-strategy experiment policy.
- `outputs`: expected durable artifacts.

## Mechanical safety checks

The validator rejects self-evaluation, writes without isolation, discovery above the item budget, timeouts above the runtime budget, unsafe paths or branch prefixes, high-risk permissions without exact human-only action IDs, duplicate gate IDs, missing executable verification, and automatic promotion for non-low-risk loops.

Human gate entries are typed IDs such as `open-pull-request`, `merge-pull-request`, `deploy-production`, and `change-permissions`; substring matches are not accepted.

## Run evidence

`loopctl record` accepts terminal logs only. Each attempted item binds:

- a schema-valid evaluator artifact stored inside the loop directory;
- evaluator identity and independent context ID;
- loop, item, and verdict equality;
- the artifact SHA-256;
- every configured evidence type and successful command for a passing result.

The recorder rejects duplicate/unknown item IDs, `passed` with no results, aggregate status/verdict mismatches, malformed or future timestamps, cost/time/item overruns, and daily budget bypasses. `dry-run` artifacts do not update task state, budgets, or evolution counters.

## Strategy experiments

An experiment includes a benchmark manifest and digest, stable case IDs, matched baseline/candidate case results, per-case artifacts and digests, evaluator command evidence, and a promotion recommendation. Scores are recomputed from per-case results.

For human-reviewed promotion:

1. `loopctl evolve` stages the exact experiment digest.
2. `loopctl approval create` produces an approval bound to that digest.
3. `loopctl evolve --approval` verifies state, staged file, digest, baseline, approver, and timestamp.

Promotion archives both strategies. `loopctl strategy rollback` restores archived behavior as a new version and records actor, reason, and time.

## Enforcement boundary

Schema checks, typed gates, budgets, hashes, state transitions, leases, and timeouts are mechanical. Natural-language intent and local command permissions are not an OS sandbox. Keep privileged credentials away from unattended loops and preserve human-only governance for external effects.

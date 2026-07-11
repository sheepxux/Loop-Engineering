# Local Runner (`loopd`)

`loopd` is the local reference runtime for validated Loop-Engineering contracts.

## Execution flow

```text
scan → pause/cadence check → loopctl next → acquire lease
     → create run directory → execute → validate terminal log
     → verify evidence/budgets → record → release lease
```

## Modes

- `dry-run`: exercises planning, leases, events, and artifacts. It records a `dry-run` run but does not update task success, budgets, cadence state, or evolution metrics.
- `command`: invokes a configured local command only when the operator passes `--allow-command`. The command receives loop/run environment variables and must write a terminal run-log draft.

## Durable artifacts

Each run directory may contain `plan.json`, `events.ndjson`, `stdout.log`, `stderr.log`, `run-log.draft.json`, validated `run-log.json`, evaluator artifacts, and `summary.md`.

## Concurrency and recovery

The active lease carries a random owner token, process/host identity, start/heartbeat/expiry timestamps, and a timeout grace period. Release verifies the owner token. Expired recovery rechecks ownership before unlinking. v1.x will add async heartbeats and stronger compare-and-swap recovery for multi-process stress cases.

## Command environment

- `LOOP_DIR`
- `LOOP_SPEC`
- `LOOP_RUN_DIR`
- `LOOP_RUN_LOG`
- `LOOP_PLAN`
- `LOOP_RUN_ID`
- `LOOP_STRATEGY`

The command executor runs with the current user's OS permissions. `--allow-command` authorizes the configured local command transport only; it does not override Loop-Engineering human gates or the user's stated scope.

## External schedulers

GitHub Actions, Codex automation, and cloud schedulers remain external. The bundled GitHub Actions renderer emits only a manual, read-only preflight scaffold. Add a trusted executor, durable state channel, least-privilege permissions, and secret policy before scheduling it.

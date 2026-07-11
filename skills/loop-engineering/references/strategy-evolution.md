# Strategy Evolution

Strategy evolution changes external task instructions, not model weights and not the safety contract.

## Preconditions

Require:

- a stable objective and immutable `loop.yaml`;
- one named metric with direction and minimum improvement;
- a fixed benchmark manifest with stable case IDs;
- the same eligible cases for baseline and candidate;
- an evaluator independent from the worker and strategy author;
- enough samples for both arms;
- retained strategies and raw evidence for rollback and audit.

Do not evolve when the metric is missing, the benchmark changed between arms, or the candidate needs weaker verification to appear better.

## One experiment

1. Read the active strategy, recent runs, evaluator failures, and human decisions.
2. Form one falsifiable hypothesis.
3. Change only the strategy instructions.
4. Run baseline and candidate against identical case IDs.
5. Store per-case outputs, verdicts, evaluator identity, commands, exit codes, and artifact digests.
6. Recompute aggregate scores from the recorded cases.
7. Check the configured improvement threshold and safety invariants.
8. Reject, stage for review, or promote. Never self-approve.

Use `assets/experiment.json` as the portable artifact shape and `loopctl evolve` for mechanical checks.

## Approval integrity

Bind human approval to the exact staged experiment and candidate digest. Record approver, timestamp, baseline version, and reason. Any candidate or evidence change invalidates the approval.

## Promotion and rollback

Archive the prior and promoted strategies. Reset promotion counters only after both the strategy and state commit successfully. Keep a manual rollback command available and require a reason. A later regression should create evidence for rollback; it must not silently rewrite history.

## Honest claims

Call this benchmark-gated task-strategy evolution. Do not claim autonomous model self-training, guaranteed monotonic improvement, or unlimited self-evolution.

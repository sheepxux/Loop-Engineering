# Contract Design

Use `assets/loop.yaml` as the field template and validate it with `loopctl validate`.

## Required decisions

### Metadata and goal

- Give the loop a stable lowercase name and an accountable owner.
- Describe one recurring objective.
- Write observable acceptance criteria.
- Separate normal completion, blocked conditions, and unsafe conditions.

### Discovery

- Name each source and the bounded query or command.
- Prefer deterministic filtering before model ranking.
- Assign stable item IDs and cap items per run.
- Decide how deduplication and previously failed items work.

### Handoff

- Use worktree/process isolation for writes.
- List explicit permissions; omit permissions that are not required.
- Make one worker responsible for one item.
- Require a durable result and worker notes.

### Verification

- Use a role and context independent from the worker.
- Start from `assume-broken`.
- Require artifact-specific evidence: tests, type checks, screenshots, DOM assertions, query results, or diff review.
- Permit `pass`, `fail`, `blocked`, and `needs-human`; missing evidence is not `pass`.

### Persistence

Keep the contract and mutable state separate:

```text
.loop-engineering/loops/<name>/
├── loop.yaml
├── state.json
├── strategy.json          # only when evolution is enabled
├── inbox.md
├── decisions.md
├── experiments/
└── runs/
```

Never place safety policy in `strategy.json`. Never use chat history as the only state store.

### Schedule and runtime

Start manually. Add a cadence only after one complete manual run produces valid evidence. Define timezone, timeout, concurrency, retry, and recovery behavior.

### Safety

Set item, run, time, retry, and cost limits. Use typed action IDs where possible. Route merge, deploy, deletion, spending, external messaging, and permission changes to human-only gates.

## Review order

Review a contract in this order: unsafe authority, missing stop conditions, self-evaluation, unbounded discovery, missing persistence, unenforced budgets, then clarity and style.

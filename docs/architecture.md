# Loop-Engineering v1 Architecture

## Product boundary

Loop-Engineering is a complete Agent Skill plus a portable local reference runtime. The Skill decides whether to use a loop and guides design, execution, review, recovery, and measured strategy evolution. The runtime enforces the deterministic parts of that contract.

## Layers

```text
┌─────────────────────────────────────────────────────────────┐
│ canonical Skill: trigger, suitability, routing, invariants │
├─────────────────────────────────────────────────────────────┤
│ references + assets + evals: progressive expertise         │
├─────────────────────────────────────────────────────────────┤
│ loop.yaml: immutable objective, verification, safety       │
├─────────────────────────────────────────────────────────────┤
│ strategy.json: versioned, experimentally mutable behavior  │
├─────────────────────────────────────────────────────────────┤
│ loopctl: validate, plan, record, evolve, approve, rollback  │
├─────────────────────────────────────────────────────────────┤
│ loopd: cadence, leases, execution, events, persistence      │
├─────────────────────────────────────────────────────────────┤
│ platform plugins and per-loop instance Skills              │
└─────────────────────────────────────────────────────────────┘
```

## Canonical Skill package

```text
skills/loop-engineering/
├── SKILL.md
├── agents/openai.yaml
├── references/
│   ├── suitability-and-patterns.md
│   ├── contract-design.md
│   ├── execution-and-evaluation.md
│   ├── runtime-integrations.md
│   ├── strategy-evolution.md
│   ├── safety-and-governance.md
│   └── troubleshooting.md
├── scripts/run-loopctl.mjs
├── assets/
└── evals/evals.json
```

`SKILL.md` contains only the routing workflow and hard invariants. Detailed guidance loads only for the selected mode. Assets are canonical; `templates/` is a checked compatibility mirror.

## Product Skill versus instance Skill

The product Skill handles the lifecycle across loops. A rendered instance Skill binds one `loop.yaml` and teaches one platform how to execute exactly one iteration. Instance generation never replaces the product Skill.

## Trust boundaries

1. **User/operator**: grants authority and owns human-only decisions.
2. **Worker**: may create a candidate in declared isolation; cannot issue the final verdict.
3. **Evaluator**: receives inspectable artifacts, not private reasoning; emits schema-valid evidence.
4. **Recorder**: verifies bindings, hashes, status, budgets, and state before persistence.
5. **Strategy evaluator**: compares baseline and candidate on the same frozen benchmark.
6. **Runner**: schedules and executes with current OS permissions; it is not a sandbox.

## Persistence

```text
.loop-engineering/loops/<name>/
├── loop.yaml
├── state.json
├── strategy.json
├── strategies/v<N>.json
├── experiments/<id>.json
├── evaluators/<artifact>.json
├── inbox.md
├── decisions.md
├── locks/active-run.json
└── runs/<run-id>/
```

JSON/YAML state writes use same-directory temporary files, `fsync`, and atomic rename. Strategy archives make promotion and rollback auditable. A future v1.x hardening step will add full multi-file transaction journals and async lease heartbeats.

## Evolution boundary

Only `strategy.json.instructions` is evolvable. The benchmark and evidence establish whether a candidate was better on observed cases; they do not prove universal improvement. Promotion requires a configured threshold and, except for explicitly low-risk automatic mode, digest-bound human approval.

## Non-goals

- autonomous model-weight training;
- automatic merge or deployment;
- hiding external effects behind evaluator approval;
- replacing domain Skills such as GitHub, security review, or browser testing;
- pretending the GitHub Actions scaffold is an executor;
- distributed orchestration or a production sandbox.

# Suitability and Loop Patterns

## Decision gate

Use the smallest mechanism that can reliably reach the objective.

| Class | Evidence | Default response |
| --- | --- | --- |
| One-shot | one bounded request, no durable recurrence | perform it directly |
| Deterministic | stable inputs and rules; no model judgment needed | build a script/job and test it |
| Agentic loop | recurring inputs, changing context, bounded judgment or remediation | design a governed loop |
| Unsafe loop | irreversible/high-impact actions without a trustworthy approval boundary | add human gates or refuse unattended operation |

An agentic loop should have all of:

- a recurring objective rather than “keep improving”;
- a bounded source of eligible work;
- acceptance, stop, and blocked conditions;
- evidence an independent evaluator can inspect;
- state that survives the conversation;
- finite item, time, retry, and cost budgets.

## Common patterns

### Triage

Collect bounded failures, alerts, or issues; rank deterministically; produce diagnoses or draft fixes. Keep notification and remediation as separate gates.

### Repair

Reproduce one defect, isolate work, implement the smallest patch, and independently verify it. Merge and deployment remain human-only.

### Drift detection

Compare generated or documented artifacts with a canonical source. Prefer deterministic diffing; use an agent only for ambiguous remediation.

### Research monitor

Poll stable sources, deduplicate findings, score relevance, and write a review queue. Do not let the loop publish externally without approval.

### Strategy improvement

Repeat a task under a versioned strategy, collect objective outcomes, and test one candidate on matched cases. This is strategy optimization, not model training.

## Rejection signals

Do not create a loop when the request is merely vague, when success cannot be measured, when every run needs fresh human intent, or when the only proposed control is “the model will know when to stop.”

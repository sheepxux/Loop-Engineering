# Roadmap

## v1.0 (current)

- One canonical, installable `loop-engineering` Agent Skill shared across platforms.
- Progressive references, deterministic runtime helper, self-contained assets, and behavior evals.
- Codex and Claude Code plugin/marketplace packaging.
- Portable protocol v1 with typed action gates and safe persistence paths.
- Evidence-bound run results with independent evaluator artifacts and SHA-256 verification.
- Hard item, time, daily-run, and cost limits.
- Local Runner with dry-run/command modes, leases, timeouts, events, and pause/resume.
- Benchmark manifests, matched per-case strategy results, mechanically recomputed scores, digest-bound human approvals, strategy archives, and rollback.
- Platform-specific loop-instance renderers and an explicitly non-operational GitHub Actions preflight scaffold.

## v1.x hardening

- Async process supervision with lease heartbeats and whole-process-group termination.
- Transaction journals and crash-recovery commands for multi-file state transitions.
- Stronger runtime sandbox integrations for untrusted commands.
- Signed evaluator/provenance attestations for remote runners.
- Held-out Skill eval automation across Codex and Claude Code.

## Later

- Provider-native Codex, Claude Code, and OpenClaw executors.
- Cron-expression and timezone-aware local scheduling.
- Optional GitHub, package-manager, and Playwright collectors.
- Dependency graphs only when real workloads outgrow the single-lane loop model.
- Remote control plane without weakening the portable local contract.

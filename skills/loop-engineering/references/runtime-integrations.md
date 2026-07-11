# Runtime and Platform Integrations

## Runtime choice

Use the least powerful runtime that meets the need:

1. manual `loopctl` run for design and early validation;
2. local `loopd` for durable polling and leases;
3. repository CI for repository-scoped collection/scaffolding;
4. provider-native automation or a cloud scheduler for always-on operation.

Do not schedule a loop until a manual run has completed with valid evidence.

## Canonical Skill versus loop instance

The installed `loop-engineering` Skill assesses, designs, operates, reviews, and evolves loops. A rendered loop-instance Skill contains the specific `loop.yaml` contract and one-iteration executor instructions. Do not overwrite the canonical Skill with an instance.

Codex project instances belong under `.agents/skills/<loop-name>/`. Claude Code project instances belong under `.claude/skills/<loop-name>/`.

## Local Runner

Use:

```bash
loopd start --once --root .loop-engineering/loops --loop <name>
loopctl status --root .loop-engineering/loops
loopctl runs .loop-engineering/loops/<name>
loopctl pause .loop-engineering/loops/<name> --reason "..."
loopctl resume .loop-engineering/loops/<name>
```

The dry-run executor tests scheduling and persistence only. A command executor is disabled unless the operator passes `--allow-command`; that flag does not override user authority or human gates.

## GitHub Actions

Treat rendered Actions output as a scaffold unless it defines a real executor, least-privilege permissions, secret handling, and a durable state channel. Never claim `echo` placeholders are operational automation.

## Installation

Prefer versioned plugin or `gh skill` installation for public use. From a source checkout or npm package, use `loopctl skill install <codex|claude-code> --scope <project|user>`. Validate the installed copy after installation.

Pin public installation examples to a release tag. Do not rely on an unpublished or floating npm package.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code specifics

Everything above comes from `AGENTS.md`, the single source of truth shared with other agents. Edit that file, not this one. Only notes that apply to Claude Code alone belong below.

- **`invariants-reviewer` subagent** (`.claude/agents/`): a read-only review against the hard constraints. Run it after any change to `src/domain`, `src/application`, `src/infrastructure/mikro-orm`, migrations, the SQS consumer or the outbox publisher, before reporting the work as done.
- **`/verify` skill** (`.claude/skills/verify/`): the full gate (lint, typecheck, unit, integration and concurrency suites). Run it before asking the maintainer for a commit.
- **Hooks** (`.claude/settings.json`, scripts in `.claude/hooks/`): Biome formats each TypeScript file after an edit, and a Stop hook runs the typecheck when TypeScript files have changed, blocking once if it fails. Both stay inert until `bun install` has run. The format hook does not organize imports: run `bun run format` when lint reports import order.
- **`.env` is unreadable on purpose** (permission deny rule), because it holds the LocalStack token. Use `.env.example` for variable names.

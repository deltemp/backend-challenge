---
name: verify
description: Full verification gate for this repository. Runs lint, typecheck and the unit, integration and concurrency suites against real PostgreSQL and LocalStack, and reports each step honestly. Use before asking the maintainer for a commit, or when asked to verify or validate the project.
---

# Verify

Run the full gate in order and report what actually happened. Stop when a step cannot run at all. Keep going past a step that merely fails, so the report covers everything.

## 1. Preconditions

- If `package.json` does not exist, the project is not scaffolded yet. Say so and stop: there is nothing to verify.
- Docker must be running: `docker info`. If it is not, ask the maintainer to start Docker Desktop, and stop.
- `.env` must exist, because LocalStack needs `LOCALSTACK_AUTH_TOKEN`. Check only that the file exists. Never read it, never print it, and never ask for the token in chat. If LocalStack fails to start or reports a license or token error, stop and tell the maintainer.

## 2. Static checks

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
```

## 3. Unit tests

```sh
bun run test:unit
```

## 4. Integration and concurrency tests

```sh
docker compose up -d --wait postgres localstack
bun run test:integration
bun run test:concurrency
```

These suites start the application as real processes from the current sources, so they need only PostgreSQL and LocalStack, not the replicas. If `README.md` documents a different way to prepare the test environment, follow the README and mention the difference.

When the change touches `Dockerfile`, `compose.yaml` or `docker/`, also run `docker compose up -d --build --wait` and check `curl http://localhost:3000/health/ready` through the proxy.

Leave the Compose services running afterwards, and say so.

## 5. Report

Give one line per step: passed, failed or not run, with the reason. For each failure, include the relevant output itself, not a summary of it.

- Never report the gate as green if any step failed or was not run.
- Do not make a failing step pass by weakening or skipping tests, adding sleeps or retries, or replacing PostgreSQL or SQS with a mock. A failing invariant test is a finding to report to the maintainer.
- Do not run `docker compose config` or `docker inspect`: both print the LocalStack token.
- If the change under verification touched `src/domain`, `src/application`, `src/infrastructure/mikro-orm`, migrations, the SQS consumer or the outbox publisher, also run the `invariants-reviewer` subagent and include its findings.

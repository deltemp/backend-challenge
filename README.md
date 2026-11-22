# Distributed Wagering Processor

Solution to Jungle Gaming's backend technical challenge: a distributed financial service that processes wagering transactions (`BET → WIN | LOSS | REFUND | ROLLBACK`) sent by multiple game providers over HTTP and AWS SQS. It must stay correct when messages are duplicated, delivered out of order or processed concurrently by several instances.

The original challenge statement (in Portuguese) is kept verbatim in [docs/CHALLENGE.md](docs/CHALLENGE.md).

> **Status:** the foundation is in place: configuration, structured logs, metrics, health checks, database migrations, SQS queue provisioning, three replicas behind a proxy, and the test harness. The wagering domain itself (wallets, transactions, ledger, inbox and outbox) is not implemented yet.

## Stack

| Concern | Choice |
|---|---|
| Runtime, package manager, test runner | Bun 1.4.5 |
| Language | TypeScript 7 (strict) |
| Framework | NestJS 12 (Express) |
| Database | PostgreSQL 19 |
| ORM and migrations | MikroORM 7 |
| Messaging | AWS SQS on LocalStack (AWS SDK for JavaScript v3) |
| Validation | Zod |
| Logs and metrics | pino (JSON) and prom-client |
| Local orchestration | Docker Compose, nginx in front of 3 replicas |
| Lint and format | Biome |

Every version is pinned exactly in `package.json` and `compose.yaml`.

## Prerequisites

- [Bun](https://bun.sh) 1.4.5 or later.
- Docker with Docker Compose v2.20 or later.
- A LocalStack auth token. LocalStack's AWS emulator has required one since March 2026; the free Hobby plan is enough. Sign in at [app.localstack.cloud](https://app.localstack.cloud), open **Auth Tokens** and copy your personal token. It goes in a local `.env` file, which is git-ignored and must never be committed.

## Setup

```sh
bun install
cp .env.example .env                  # PowerShell: Copy-Item .env.example .env
# edit .env and set LOCALSTACK_AUTH_TOKEN
docker compose up -d --build --wait
curl http://localhost:3000/health/ready
```

`docker compose up` starts:

| Service | What it does | Host port |
|---|---|---|
| `postgres` | PostgreSQL 19 | 55432 |
| `localstack` | SQS emulator | 4566 |
| `provision` | One-shot job: applies migrations and creates the queues, then exits | none |
| `app` | 3 replicas of the application, started after `provision` succeeds; healthy only when ready, restarted unless stopped | none |
| `proxy` | nginx, load-balancing across the replicas | 3000 |

PostgreSQL is published on 55432 rather than 5432 so that a PostgreSQL installed on your machine does not answer in its place. Every host port can be changed in `.env` (`APP_PORT`, `POSTGRES_PORT`, `LOCALSTACK_PORT`); keep `DATABASE_URL` and `AWS_ENDPOINT_URL` in line with them.

To run a single instance on the host instead, with reload on change:

```sh
docker compose up -d --wait postgres localstack
bun run provision
bun run dev
```

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | One instance on the host, reloading on change |
| `bun run start` | One instance on the host |
| `bun run lint` | Biome lint and format check; fails on warnings |
| `bun run format` | Apply Biome formatting and safe fixes |
| `bun run typecheck` | TypeScript type check |
| `bun run test:unit` | Unit tests; no containers needed |
| `bun run test:integration` | Integration tests against real PostgreSQL and LocalStack |
| `bun run test:concurrency` | Multi-instance tests with real processes |
| `bun run test:load` | k6 smoke run through the proxy (the full load test comes later) |
| `bun run provision` | Apply migrations and create the queues |
| `bun run migration:create` | New migration from the schema diff; `--blank` for a hand-written one, `--name=<name>` to name it |
| `bun run migration:up` | Apply pending migrations |
| `bun run migration:down` | Revert the last migration |

## Tests

Unit tests run anywhere. Integration and concurrency tests need PostgreSQL and LocalStack:

```sh
docker compose up -d --wait postgres localstack
bun run test:integration
bun run test:concurrency
```

Each test file gets its own database, cloned in a fraction of a second from a template migrated once per run, and its own SQS queues. Application instances are started as real processes from the current sources, so no image rebuild is needed. Nothing is mocked: PostgreSQL and SQS are always real.

```sh
bun test ./test/unit/config.test.ts                                   # one file
bun test ./test/unit -t "rejects an unknown role"                     # one test by name
bun test --preload ./test/support/preload.ts ./test/integration/health.test.ts
```

On Windows a process cannot catch SIGTERM, so graceful shutdown is checked against a container (`docker stop`), where it runs on Linux.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health/live` | The process is up. Checks no dependency. |
| `GET /health/ready` | PostgreSQL answers and SQS resolves the inbound queue; 503 otherwise. |
| `GET /metrics` | Prometheus metrics of the instance that answers. Through the proxy, each request may reach a different replica. |

Requests may carry an `x-correlation-id` header; it is echoed back and attached to every log line, and one is generated when absent.

## Configuration

Environment variables, validated at boot. An invalid or missing value stops the process with a message that names the variable but never prints its value. `MIKRO_ORM_*` variables are refused, because MikroORM would apply them around this validation.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection URL |
| `DATABASE_POOL_MAX` | `10` | Connection pool size per process |
| `DATABASE_CONNECT_TIMEOUT_MS` | `5000` | Longest wait for a database connection |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `30000` | PostgreSQL ends a session idle inside a transaction for longer, releasing its locks |
| `PORT` | `3000` | HTTP port; `0` picks a free port |
| `APP_ROLES` | `api,consumer,outbox,retry` | What this process runs |
| `LOG_LEVEL` | `info` | pino log level |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Longest graceful shutdown before a forced exit |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | Timeout of each readiness check |
| `AWS_REGION` | `us-east-1` | AWS region |
| `AWS_ENDPOINT_URL` | unset (real AWS) | Custom endpoint, such as LocalStack |
| `SQS_WAGER_TRANSACTIONS_QUEUE` | `wager-transactions.fifo` | Inbound queue |
| `SQS_WAGER_TRANSACTIONS_DLQ` | `wager-transactions-dlq.fifo` | Dead-letter queue of the inbound queue |
| `SQS_WAGER_EVENTS_QUEUE` | `wager-events.fifo` | Queue that receives the integration events |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Receives before a message moves to the dead-letter queue |

Bun loads `.env` automatically for processes started on the host. Containers get their values from `compose.yaml`.

## Troubleshooting

- **`localstack` is unhealthy:** the auth token is missing or invalid. Check `LOCALSTACK_AUTH_TOKEN` in `.env`, then look at `docker compose logs localstack`.
- **Tests report that PostgreSQL is unreachable, or authentication fails:** make sure `DATABASE_URL` in `.env` points at port 55432 (or your `POSTGRES_PORT`), not at a local PostgreSQL.
- **A port is already in use:** change it in `.env` as described in Setup.
- **`/health/ready` reports SQS down after LocalStack restarted:** LocalStack keeps no state, so the queues are gone. `docker compose up -d --wait` runs `provision` again and recreates them.

## Documentation

- [docs/CHALLENGE.md](docs/CHALLENGE.md): the challenge statement.
- `ARCHITECTURE.md`: decisions, trade-offs and limitations (not written yet).
- [AGENTS.md](AGENTS.md): working conventions for contributors and AI coding agents.

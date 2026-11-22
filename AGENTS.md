# AGENTS.md

Working instructions for AI coding agents and human contributors. This file is the single source of truth for how to work in this repository; `CLAUDE.md` only imports it.

## Project

Solution to Jungle Gaming's backend challenge, "Distributed Wagering Processor": a distributed financial service that processes wagering transactions (`BET → WIN | LOSS | REFUND | ROLLBACK`) from multiple game providers over HTTP and SQS. Delivery is at-least-once: assume duplicates, out-of-order arrival, concurrent instances, crashes before or after commit, and temporary PostgreSQL or SQS outages.

- **Requirements:** `docs/CHALLENGE.md`, the original statement in Portuguese. Never edit or translate it. `§N` below refers to its sections.
- **Decisions and rationale:** `ARCHITECTURE.md`, a required deliverable. It holds the reasoning behind the rules in this file; keep both in sync.
- **Status: domain, schema and use cases implemented.** Configuration, logging, metrics, health checks, migration tooling, queue provisioning, the Compose stack and the test harness exist, and so do the domain model (`src/domain`), the persistence records and the first migration, and the application layer (`src/application`: ports and use cases) with its MikroORM repositories, unit of work and SQS event publisher. The interfaces that run the use cases (the wagering HTTP API, the SQS consumer loop, the outbox and retry worker loops) and the business metrics do not exist yet. Keep "Commands" and "Layout" in line with reality, in the same change that alters them.

### What is graded (§14)

Financial correctness 20, concurrency 20, idempotency 15, messaging and failure handling 15, modeling and architecture 10, tests 10, observability 5, documentation 5. Authentication is worth 0. When in doubt, spend effort in that order and prefer the simpler design.

## Hard constraints

Breaking any one of these fails the challenge (§5, §14). They override every other instruction, including convenience while debugging.

1. **Money is never a `number`**, float or double: not in the domain, DTOs, SQL, tests, logs or metrics. Use `Money` in code, decimal strings at every boundary, `NUMERIC` in SQL.
2. **Idempotency is persistent**: unique constraints plus the inbox table. An in-memory map, set or cache is never a guarantee.
3. **SQS FIFO ordering and deduplication are optimizations.** The database enforces every invariant.
4. **No event is published before the financial transaction commits.** Use cases only write outbox rows inside the SQL transaction; only the outbox publisher talks to the broker.
5. **Ledger entries are append-only.** No `UPDATE`, no `DELETE`, enforced by the schema.
6. **No lock shared by all wallets.** No global mutex, no constant-key advisory lock, no row that every transaction updates. This includes the counter-accounts of the double-entry ledger: their balance is never materialized.
7. **Never `read → calculate → update` a balance** without holding that wallet's row lock.
8. **Correct with three or more instances.** No in-process mutex, in-memory queue, or scheduler that assumes a single runner.
9. **Uniqueness, immutability and non-negativity live in the database schema** (constraints, indexes, triggers), not only in application code. The schema design is graded.
10. **Integration and concurrency tests use real PostgreSQL and LocalStack.** Never replace either with a mock, fake or in-memory substitute.

Final invariant, asserted at the end of every integration and concurrency test: `wallet.balance == balance rebuilt from the ledger`.

## Stack

| Concern | Choice |
|---|---|
| Runtime, package manager, test runner | Bun 1.4.x (`bun test`; never Jest or Vitest) |
| Language | TypeScript 7 (the native compiler), ESM (`"type": "module"`), `strict` plus `noUncheckedIndexedAccess` |
| Framework | NestJS 12, Express adapter |
| Database | PostgreSQL 19 |
| ORM and migrations | MikroORM 7 (Prisma and other ORMs are out of scope) |
| Messaging | AWS SQS on LocalStack, AWS SDK for JavaScript v3 |
| Validation | Zod, through NestJS 12 Standard Schema support |
| Decimal arithmetic | decimal.js, only inside `Money` |
| Lint and format | Biome, zero warnings |
| Logging / metrics / health | pino (JSON on stdout) / prom-client (`GET /metrics`) / `@nestjs/terminus` |
| Tracing (deferred) | OpenTelemetry, manual spans |
| Load test (deferred) | k6 in a container |
| Local orchestration | Docker Compose; nginx in front of 3 replicas |

Version policy: latest stable releases, pinned to exact versions in `package.json` and in Compose image tags. If a combination turns out to be incompatible, step back only the offending package and record why in `ARCHITECTURE.md`.

No `any`, no `@ts-ignore` or `@ts-expect-error`, no non-null assertion used to silence the compiler. Never relax a compiler or lint rule to make code pass.

## Commands

All verified on Windows with Bun 1.4.5 and Docker Compose 5.

```sh
bun install                                        # install from the lockfile
docker compose up -d --build --wait                # full stack: proxy on :3000, 3 replicas
docker compose up -d --wait postgres localstack    # infrastructure only, for host runs and tests
bun run dev                                        # one instance on the host, reloading on change
bun run provision                                  # migrations + queues, from the host
bun run lint                                       # Biome check, fails on warnings
bun run format                                     # Biome format and safe fixes (organize imports)
bun run typecheck                                  # tsc
bun run test:unit                                  # test/unit, no containers needed
bun run test:integration                           # test/integration, needs postgres + localstack
bun run test:concurrency                           # test/concurrency, needs postgres + localstack
bun test ./test/unit/config.test.ts                # a single file
bun test ./test/unit -t "rejects an unknown role"  # a single test by name
bun test --preload ./test/support/preload.ts ./test/integration/health.test.ts  # one integration file
bun run migration:create --blank --name=<name>     # new migration (drop --blank to diff the schema)
bun run migration:up                               # apply pending migrations
bun run migration:down                             # revert the last migration
bun run test:load                                  # k6 smoke run; the real load test is deferred
```

Integration and concurrency files must run with the preload (the package scripts pass it): it checks the infrastructure and builds the template database.

Scripts must run on Windows, macOS and Linux: use Bun's cross-platform shell or TypeScript files under `scripts/`, never bash-only syntax.

## Layout

```
src/
  domain/
    money/           Money (decimal.js, exact, never rounds)
    wallet/          Wallet aggregate
    ledger/          WalletLedgerEntry, LedgerAccount, LedgerDirection
    wagering/        WagerTransaction (state machine), FailureCode, payload hash,
                     wager rules (applyWagerTransaction)
    events/          IntegrationEvent and the four events
    messaging/       InboxMessage, OutboxMessage
    shared/          domain errors, FullJitterBackoff
  application/
    ports/           clock, id generator, repositories, unit of work, event publisher
    use-cases/       OpenWallet, SubmitWagerTransaction, FindDuePendingReferences,
                     ReprocessPendingReference, PublishOutbox, queries (GetWallet,
                     GetWalletLedger, GetWagerTransaction, ReconcileWallet)
                     errors.ts (protocol codes), views.ts (outputs), policies.ts (retry
                     settings), wager-processing.ts, integration-events.ts, ledger-cursor.ts
  infrastructure/
    config/          environment schema (Zod), loadConfig, ConfigModule (APP_CONFIG token)
    observability/   pino logger, request context (AsyncLocalStorage), metrics, HTTP middleware
    mikro-orm/       ORM options, DatabaseModule, Postgres readiness check;
                     records/ (defineEntity, scalar-only), migrations/ (hand-written SQL and
                     the diff snapshot), repositories/, unit-of-work.ts, database-errors.ts
    sqs/             SQS client, queue provisioning, SQS readiness check, event publisher;
                     (next) consumer
    runtime.ts       system clock, UUIDv7 ids, Math.random behind the ports
    use-cases.ts     composition root: createUseCases(dependencies)
  interfaces/
    http/            health and metrics controllers, AuthGuard; (next) API controllers
    (next)           sqs-consumer/, workers/ (outbox publisher, reference retry)
  app.module.ts
  main.ts            one entry point; APP_ROLES selects what runs
scripts/             migrations.ts, provision.ts
test/
  support/           preload, per-file databases and queues, app processes, ledger invariant,
                     use-case harness (TestClock, command builders)
  unit/              unit/domain/ covers the §13 unit list
  integration/       schema.test.ts proves every schema guarantee; records.test.ts the mappings
  concurrency/  load/
docker/nginx/        proxy configuration
```

Dependency rule: `interfaces → application → domain`, and `infrastructure` implements the ports declared in `application`. `src/domain` imports nothing from NestJS, MikroORM, the AWS SDK, Zod or pino; decimal.js is its only package dependency, plus Node's built-in `node:crypto` for the payload hash (`test/unit/domain/dependency-rule.test.ts` enforces it). This is one bounded context: do not split it into feature modules.

## Pitfalls already found

Each of these cost time once. Do not rediscover them.

- **Never turn an injected class import into `import type`.** NestJS resolves constructor dependencies from `emitDecoratorMetadata`; a type-only import erases that reference and dependency injection fails at runtime, with no compile error. Biome's `useImportType` is off for this reason; interfaces and type aliases still need `import type` (TypeScript enforces it through `verbatimModuleSyntax`).
- **Biome:** `noStaticOnlyClass` is off only in `*.module.ts` (NestJS dynamic modules); Markdown is not formatted. The edit hook formats but does not organize imports: run `bun run format` when `bun run lint` reports import order.
- **MikroORM 7 connects lazily.** `isConnected()` and `checkConnection()` report "not connected" until the first query, so readiness runs `select 1`.
- **MikroORM reads `MIKRO_ORM_*` variables** and merges them into its options, around the Zod validation (`MIKRO_ORM_DB_NAME` would redirect every query, `MIKRO_ORM_DEBUG` would log SQL with values). `loadConfig` refuses to start when one is set. The exception is the color switches: MikroORM writes `MIKRO_ORM_COLORS` into `process.env` itself, as soon as `DatabaseModule` is declared.
- **Bun rejects unknown HTTP methods** with 400 before Express sees them, so the `method` metric label stays bounded.
- **MikroORM configuration** lives in `createMikroOrmOptions`: register persistence records in `entities`; keep the explicit migration paths (the defaults pick up unrelated files); the snapshot has a fixed name and is not rewritten by `up`/`down`, so test databases never touch it. Every unit of work forks its own EntityManager (`registerRequestContext: false`, `allowGlobalContext: false`).
- **SQS clients come from `createSqsClient`,** which sets `useQueueUrlAsEndpoint: false`. Without it the SDK sends each call to the host inside the QueueUrl, which LocalStack sets to an address that does not resolve from every network.
- **nginx resolves the replicas once, at startup,** on purpose (see the comment in `docker/nginx/nginx.conf`); compose restarts it when it recreates the replicas. After changing the replica count, run `docker compose restart proxy`.
- **Ports:** PostgreSQL is published on 55432 because the maintainer's machine runs native PostgreSQL services on 5432. A password error in Portuguese means a native PostgreSQL answered, not the container.
- **The LocalStack image has no curl;** its healthcheck uses Python.
- **Bun loads `.env` into every process started on the host** (dev, scripts, tests); containers get their environment from `compose.yaml`.
- **Git Bash rewrites absolute-looking arguments** (`/scripts/x` becomes `C:/Program Files/Git/scripts/x`) when passing them to `docker`. Use the package scripts or PowerShell.
- **Never let MikroORM generate schema SQL against a migrated database** (`orm.schema.update*`, `getUpdateSchemaSQL`). It does not model CHECKs, triggers, partial indexes or deferrable foreign keys, so its diff drops all of them. `migration:create` is safe because it diffs the records against `.snapshot.json`, not the database; review its output anyway. A record change with no schema change still needs the snapshot refreshed: run `bun run migration:create --blank --name=x` and delete the blank migration it writes.
- **PL/pgSQL ends an `IF` condition at the first `THEN` outside parentheses,** including one inside a `CASE`: wrap a `CASE` in parentheses there. The error is a bare "syntax error at end of input".
- **Bun SQL binds a JavaScript string for a `jsonb` column as a JSON string,** not as an object; pass the object itself.
- **MikroORM infers optional `em.create` fields from defaults, not from generated columns:** the outbox `sequenceNumber` is typed `Opt<string>` so the application never has to (and never can usefully) pass it.
- **The migrator is silent** (`silent: true`): its own progress lines are plain text, not JSON logs; the scripts print what they applied.
- **MikroORM's PostgreSQL converter appends `detail` and `hint` to the error message** ("\n - detail: Failing row contains (...)"), and the stack repeats the message. `serializeError` removes exactly those suffixes again; keep it that way, or row values (amounts included) reach the logs through `message` and `stack`.
- **MikroORM types only some SQLSTATEs** (unique, foreign key, check, not null, deadlock). A lock timeout (55P03) or a statement timeout (57014) arrives as a plain `DriverException`; `translateDatabaseError` reads the code itself.
- **MikroORM's identity map would answer a re-read from memory.** Reads in repositories pass `disableIdentityMap: true`; never rely on a managed entity loaded earlier in the same unit of work.
- **MikroORM writes parameter values into the SQL text** (escaped on the client). A NUL inside a value ends the query's protocol message early: PostgreSQL answers 08P01 "invalid message format", which `translateDatabaseError` reads as an unavailable database (503). The text is sent as UTF-8, which turns an unpaired surrogate into U+FFFD and so merges distinct ids. Every identifier is checked for control characters and unpaired surrogates before it reaches a query.

## Domain modeling (§6)

The class skeletons in §6 and §11 are the reference. Names may be adapted; guarantees may not.

- Constructors are `private` or `protected`. Instances come from static factories (`create`, `from`, `open`, `receive`, `enqueue`) and from `rehydrate`.
- `rehydrate` rebuilds persisted state and never revalidates transitions. Only repositories call it.
- State is private and changes only through explicit transition methods. Transitioning a terminal transaction (`PROCESSED`, `REJECTED`, `FAILED`) throws `InvalidTransactionStateError`: that is a programming error, not a business path.
- `Money` is immutable. It accepts decimal strings with up to 2 decimal places, always serializes with exactly 2, and never rounds. `NaN`, `Infinity`, scientific notation, empty strings, more than 2 decimals, and negative amounts in input contracts are rejected. Operations across currencies throw a domain error.
- `Money` persists as `NUMERIC(20,2)` plus `CHAR(3)` and is rehydrated as `Money`. decimal.js defaults to 20 significant digits, which is not enough to add two amounts at the limit of `NUMERIC(20,2)` exactly, so `Money` uses its own decimal.js configuration with more precision, and rejects amounts outside that range.
- `WalletLedgerEntry` is structurally immutable: every field `readonly`, no transition methods. Its factory validates `balanceBefore ± money == balanceAfter`.
- Integration events extend the abstract `IntegrationEvent<T>`, with one concrete subclass per event and `eventType` and `version` declared on the class, never as strings at the call site. Event `data` carries `MoneyProps` (decimal strings), never a `Money` instance.
- Use `interface` for plain data shapes (props, DTOs, state) and classes for behavior.

## Persistence

- **Records are not domain objects.** MikroORM entities are persistence records defined with `defineEntity` under `src/infrastructure/mikro-orm`, without decorators. Repositories convert record → domain with `rehydrate`, and domain → managed record.
- **One use case, one SQL transaction** (`em.transactional`). The inbox row (SQS entry only), the wager transaction, the wallet balance, the ledger entry and the outbox rows commit together or not at all.
- **The concurrency unit is the wallet.** Take the wallet row lock (`LockMode.PESSIMISTIC_WRITE`, that is `SELECT … FOR UPDATE`) first: before reading anything the decision depends on, and before any other row lock. Look up the idempotency key under that lock. Bound the wait with `lock_timeout`; a timeout is a transient error and increments the lock-conflict metric. Workers follow the same order: the retry worker picks due transactions without locking them, locks their wallet (`SKIP LOCKED` on `wallets` is fine), then re-reads the transaction under that lock. Never lock `wager_transactions` rows before the wallet.
- **No row shared by all wallets is ever locked, not even by a foreign key.** A foreign-key check locks the referenced row (`FOR KEY SHARE`) at every commit, so no foreign key points at a counter-account (a provider's settlement account is shared by all its wallets); the deferred ledger check reads the counter-account without locking it. Accounts are insert-only: get or create one with a read, then `INSERT … ON CONFLICT DO NOTHING` and a read again if it was missing; never lock or upsert-update an account row.
- **Unique constraints are the backstop.** A unique violation on the idempotency key or on `(provider_id, external_transaction_id)` is resolved by rolling back and re-running once, which then finds the row and returns a replay or a conflict. A race never surfaces as a 500. The re-run looks the winner's row up before inserting, so a violation on it is no contention but a bug: it propagates as a 500 (`UNEXPECTED_ERROR`), with nothing committed, just as reprocessing ends `FAILED` on a second violation.
- `Wallet.version` starts at 1 on creation (the `OPENING` credit, when present, is part of creation) and increments only when the balance changes.
- **Double-entry ledger.** One immutable row per financial transaction, with `debit_account_id`, `credit_account_id` and a positive `amount`, plus the wallet-side `balance_before`, `balance_after` and `wallet_version`. Accounts: `PLAYER_WALLET` (1:1 with a wallet), `PROVIDER_SETTLEMENT` (per provider and currency), `FUNDING` (per currency, used by `OPENING`). Counter-account balances are always derived by summing entries.
- **Schema-level guarantees** (all implemented in the first migration and proved in `test/integration/schema.test.ts`; keep both in step): one wallet per `(player_id, currency)`; `balance >= 0`; unique `idempotency_key`; unique `(provider_id, external_transaction_id)`; one ledger entry per transaction; unique `(wallet_id, wallet_version)` on the ledger; at most one `PROCESSED` reversal per referenced transaction (partial unique index); one `OPENING` per wallet; inbox unique on `(consumer_name, message_id)`; ledger rows and ledger accounts reject `UPDATE`, `DELETE` and `TRUNCATE`; a wager transaction in a terminal state rejects further updates, a parked one changes only its outcome, and none is deleted; `FAILED` only from a stored `PENDING_REFERENCE`; `PENDING` is never stored; wallets are never deleted and their owner and currency never change; an unpublished outbox event cannot be deleted or truncated and changes only its publication schedule, and a published one is final (it may then be purged); amounts above zero (a `LOSS` may be zero, a ledger amount never); debit and credit accounts differ; the wallet is on its own side of each entry; `balance_after` matches `balance_before ± amount`; a composite foreign key keeps an entry in its wallet's currency. **Deferred constraint triggers** check at commit that balance, ledger and transactions agree: every applied balance-moving transaction has its entry and every entry its applied transaction (kind, amount, direction, counter-account and its currency, and the stored snapshot equal to the entry's `balance_after`); the entries of a wallet chain unbroken from zero; the wallet holds the balance of its last entry, whether or not its row was touched; an applied transaction names its wallet's player and currency; and its reference matches it (scope, kind, a reversal's amount, no settling of a reversed bet). `wallet.balance == balance rebuilt from the ledger` is therefore a schema guarantee.
- **Foreign keys are deferred** (`DEFERRABLE INITIALLY DEFERRED`), so a unit of work may flush its rows in any order; unique constraints are not, so idempotency races fail at the insert. Guard violations raise SQLSTATE 23000 and consistency violations 23514, each naming the rule in the error's `constraint` field; both are bugs (500), unlike 23505 on the idempotency keys. Trigger messages carry ids and versions, never amounts, because they reach the logs; amounts go to `DETAIL`, which the log serializer drops.
- **Records map columns only, with no relations.** Repositories resolve ids explicitly; the schema enforces the links between rows.
- **Migrations** are MikroORM migrations with hand-reviewed SQL. Every `up()` has a `down()` that works, covered by an up → down → up test. Do not rewrite a committed migration without asking.
- **Application processes never run DDL.** `ensureDatabase` is off: databases come from compose or the test harness, the schema only from migrations.
- **Connection limits** live in `createMikroOrmOptions` and come from the environment: a 5-second connection timeout, so an unreachable database fails fast as a transient error, and a 30-second `idle_in_transaction_session_timeout`, so PostgreSQL releases the row locks of a process that stalled or vanished mid-transaction.
- **Lock and statement timeouts:** a 2-second `lock_timeout` and a 5-second `statement_timeout` (`DATABASE_LOCK_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`), sent by the pg driver as session settings when `createMikroOrmOptions(database, "application")` opens a connection. `"migrations"` sessions run without them. The lock timeout must stay below the statement timeout (`loadConfig` refuses otherwise), or a long lock wait would end as a statement timeout. A lock timeout answers `WALLET_BUSY`; a statement timeout or an unreachable dependency answers `DEPENDENCY_UNAVAILABLE`, both 503.
- **The unit of work** (`MikroOrmUnitOfWork`) forks an EntityManager per call and runs the work in `em.transactional`. `translateDatabaseError` maps failures by SQLSTATE: 23505 becomes a `DuplicateKeyError` named by meaning (`idempotency-key`, `external-transaction`, `inbox-message`, `reversal`, `wallet-owner`), 55P03/40P01/40001 a `WalletBusyError`, statement timeouts, server shutdowns, classes 08 (connection), 53 (insufficient resources) and 58 (system and I/O) and lost connections a `DependencyUnavailableError`; anything else (schema guards, bugs) passes through. Renaming one of those unique constraints in a migration means updating its mapping: the deterministic race tests in `test/integration/submit-wager-transaction.test.ts` (idempotency key, provider id, inbox) and `open-wallet.test.ts` (wallet owner) catch a mismatch.
- **Validation comes before any lock.** `RequestCheck` (`src/application/request-limits.ts`) refuses an identifier that is empty, longer than the schema allows or contains a control character or an unpaired surrogate, and a wallet id that is not a lowercase UUID (`InvalidRequestError`, `VALIDATION_FAILED`), and the transaction is built (and validated by the domain) before the unit of work starts. A query by an id that is not a lowercase UUID, or by a provider identifier that breaks those rules, answers not found without querying.
- **Repositories** read with `disableIdentityMap: true` (a read after taking a lock must see the latest committed row, never a cached one) and write with native statements (`em.insert`, `em.nativeUpdate`), run at once and in call order. Raw SQL goes through `em.execute(sql, params)` with `?` placeholders, which MikroORM escapes; never build SQL by concatenation. Records map to domain objects only through the mappers in `repositories/mappers.ts`.

## Decisions already made

Each of these was decided with the maintainer. Implement them as written; if one looks wrong, stop and ask instead of improvising. The rationale and trade-offs belong in `ARCHITECTURE.md`.

### Business rules and interpretations (§7)

- A referenced transaction can have at most one `PROCESSED` reversal. `REFUND` and `ROLLBACK` of the same transaction are mutually exclusive, and the second one is `REJECTED` with `REFERENCE_ALREADY_REVERSED`. This is stricter than the statement on purpose, to prevent a double credit. A `REFUND` undone by a `ROLLBACK` does not reopen the `BET` for a new `REFUND` (documented limitation).
- `WIN` and `LOSS` may carry a reference. When present, it must resolve to a `PROCESSED` `BET` of the same provider, player, wallet, currency and round; a `WIN` or `LOSS` for a `BET` that was reversed is `REJECTED` with `REFERENCE_ALREADY_REVERSED`. A `BET` with a reference is an invalid payload (400).
- Amounts are above zero, except that a `LOSS` may record zero (it never moves the balance). A reversal must have its reference's amount (`AMOUNT_MISMATCH`).
- When several rules are broken, the first in this order is reported: `WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`, then the reference (missing: wait; `REFERENCE_MISMATCH`; `REFERENCE_KIND_NOT_ALLOWED`; still pending: wait; `REFERENCE_NOT_PROCESSED`; `REFERENCE_ALREADY_REVERSED`; `AMOUNT_MISMATCH`), then funds (`INSUFFICIENT_FUNDS` for a `BET`, `REVERSAL_WOULD_OVERDRAW` for a `ROLLBACK`). The scope of a reference comes before anything else about it, so a provider learns nothing about transactions outside its player, wallet and round. `applyWagerTransaction` implements this order.
- A wallet mismatch (`WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`) stores no observed balance (a CHECK enforces it), so neither the response nor the event shows another player's balance.
- The `OPENING` credit is created already `PROCESSED`, in the wallet's SQL transaction, with no provider fields and no idempotency key (null in the schema and in events); a partial unique index allows one per wallet. A wallet opened at zero has no `OPENING` and no ledger entry, so its first movement is version 2.
- Identifier limits, enforced by the schema, which the API validation must mirror (the use cases check them again before any lock, so an oversized id is a 400, never a database error): `providerId` up to 64 characters; `externalTransactionId`, `referenceExternalTransactionId`, `playerId`, `roundId` and `gameId` up to 128; `Idempotency-Key` up to 255. The use cases also refuse an identifier with a control character or an unpaired surrogate; the schema enforces only the lengths (an identifier is never empty), and nothing but the use cases writes identifiers.
- The ids this service issues (wallets, transactions) are accepted only in their canonical lowercase form. An uppercase UUID is a validation error on input (400, or the DLQ from the queue) and matches nothing on lookup (404); accepting both would mean normalizing every id before hashing and comparing it.
- The schema backs the bookkeeping with deferred constraint triggers: balance, ledger and transactions must agree at every commit (see "Persistence").
- A missing reference is persisted as `PENDING_REFERENCE` and retried by a scheduled worker until a deadline 15 minutes after receipt (see "Retry policies"). On expiry the transaction becomes `REJECTED` with `REFERENCE_NOT_FOUND` and the matching event is published.
- A reference that exists but is itself still `PENDING_REFERENCE` (the `ROLLBACK` of a `REFUND` whose `BET` has not arrived) parks the new transaction in `PENDING_REFERENCE` too, with its own 15-minute deadline. It proceeds once the reference is `PROCESSED`. It is `REJECTED` with `REFERENCE_NOT_PROCESSED` if the reference ends `REJECTED` or `FAILED`, or is still pending when its own deadline passes. The worker processes the oldest pending transactions first, so chains resolve in order.
- State machine: `PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE`, and `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`. Nothing leaves a terminal state.
- `FAILED` is reserved for an already persisted `PENDING_REFERENCE` transaction whose reprocessing hits an unrecoverable, non-business error (`INTERNAL_ERROR`). A new transaction that fails on infrastructure is rolled back and never persisted.
- An unknown wallet is a contract error and nothing is persisted. A wallet that exists but belongs to another player or currency yields a persisted `REJECTED`.
- A replay answers from the snapshot stored with the transaction (status, failure code, balance observed at that moment), never from the current balance.
- Failure codes: `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `INTERNAL_ERROR`. `INSUFFICIENT_FUNDS` (a bet without balance) and `REVERSAL_WOULD_OVERDRAW` (a reversal that would make the balance negative) are distinct on purpose. Codes are a public contract: add one only with a documented reason, and never rename one.
- Currency: only `BRL` is exercised end to end, but the model stays multi-currency and currency conflicts are tested.
- IDs are UUIDv7, generated by the application behind an `IdGenerator` port.

### Idempotency (§9)

- The `Idempotency-Key` header is mandatory and authoritative. `payloadHash` is the SHA-256 (hex) of the RFC 8785 canonical JSON of the business fields: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` and, when present, `referenceExternalTransactionId`, with money normalized to scale 2. The idempotency key, headers and transport metadata (`messageId`, `occurredAt`, message type) are not hashed.
- Same key with the same hash is a replay (`idempotentReplay: true`). Same key with a different hash is a conflict, never a replay. As a consequence, a rejection is final for its key: a corrected payload must come as a new transaction, with a new `externalTransactionId`.

### HTTP contract (§9)

| Situation | Status |
|---|---|
| Transaction `PROCESSED`, first call or replay | 200 |
| Wallet created | 201 |
| Transaction `PENDING_REFERENCE` | 202 |
| Invalid payload, missing `Idempotency-Key`, `kind: OPENING` | 400 |
| Unknown wallet or transaction | 404 |
| Idempotency conflict; duplicate wallet for the same player and currency | 409 |
| Transaction `REJECTED` by a business rule (the body is the transaction, with `failureCode`) | 422 |
| Body larger than the accepted limit | 413 |
| Unexpected failure (a bug) | 500 |
| Transient infrastructure failure, with `Retry-After` | 503 |

Protocol errors use RFC 9457 `application/problem+json`: `type` is `about:blank`, plus `title`, `status`, `detail` and `instance` (the request path), and the extension members `code` and `correlationId`. `VALIDATION_FAILED` adds `errors: [{ path, message }]`. Every 503 carries `Retry-After`, and resending any 5xx with the same idempotency key is safe. The mapping is identical on every endpoint. Health endpoints never require authentication. The codes are a public contract, like failure codes:

| Status | `code` | When |
|---|---|---|
| 400 | `MALFORMED_JSON` | The body is not valid JSON |
| 400 | `VALIDATION_FAILED` | The payload or a header breaks the schema, including `kind: OPENING` |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | The `Idempotency-Key` header is missing or blank |
| 400 | `INVALID_CURSOR` | The ledger cursor was not issued by this service |
| 404 | `WALLET_NOT_FOUND` | Unknown wallet |
| 404 | `TRANSACTION_NOT_FOUND` | Unknown transaction |
| 404 | `ROUTE_NOT_FOUND` | Unknown route |
| 409 | `IDEMPOTENCY_CONFLICT` | Same idempotency key, different payload |
| 409 | `EXTERNAL_TRANSACTION_CONFLICT` | Same `providerId` and `externalTransactionId` under another idempotency key |
| 409 | `WALLET_ALREADY_EXISTS` | A wallet already exists for the player and currency |
| 413 | `PAYLOAD_TOO_LARGE` | The body exceeds the accepted size |
| 503 | `WALLET_BUSY` | `lock_timeout` while waiting for a contended wallet |
| 503 | `DEPENDENCY_UNAVAILABLE` | PostgreSQL or SQS unreachable, or a statement timeout |
| 500 | `UNEXPECTED_ERROR` | A bug |

`GET /wallets/:walletId/ledger` paginates by `wallet_version`, newest entry first, like a statement: the cursor is the version of the last entry returned, encoded in base64url and opaque to clients, and leads to the older entries. Pages hold 50 entries by default and at most 100. A cursor this service did not issue is `INVALID_CURSOR`.

`POST /wallets/:walletId/reconciliation` reads the stored balance and the wallet's ledger in one consistent snapshot, so concurrent transactions cannot produce false divergences. A divergence is logged, counted in a metric and flagged in the response, never corrected.

### Messaging (§10, §11)

- Inbound queues: `wager-transactions.fifo` and `wager-transactions-dlq.fifo`. The consumer calls the same use case as the HTTP entry point.
- Deduplicate with the persistent inbox on `(consumerName, messageId)`. Acknowledge only after the commit. A message found in the inbox answers from the transaction it produced and does nothing again; the same message id with another payload is an `InboxConflictError` (queue-only, permanent: straight to the DLQ), never processed and never a replay.
- Error classes: a business rejection is terminal, so acknowledge it; a transient error extends the visibility timeout with full-jitter exponential backoff (base 5 s, cap 60 s, so at most about 2 min 15 s across the 5 receives); a permanent error (malformed message, unknown type, unknown wallet) goes straight to the DLQ. The redrive policy uses `maxReceiveCount = 5`.
- While PostgreSQL or SQS is unreachable, the consumer stops receiving and probes the dependency with backoff before resuming. An outage therefore does not use up the 5 receives and does not push healthy messages to the DLQ; per-message backoff is left for isolated failures such as a lock timeout.
- Producers are expected to use `walletId` as `MessageGroupId`. Correctness must not depend on it.
- On `SIGTERM`, stop polling, then finish in-flight messages or return their visibility. The queue's default long poll (20 s) is longer than the shutdown budget (`SHUTDOWN_TIMEOUT_MS`, 10 s): pass an `AbortSignal` to every `ReceiveMessage` and abort it as the first shutdown step, and set `WaitTimeSeconds` on each call. Keep the shutdown budget above the longest message processing plus the visibility calls, and below compose's `stop_grace_period` (15 s).
- Outbox: workers poll with `FOR UPDATE SKIP LOCKED`, publish at-least-once to `wager-events.fifo` (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`), then mark the rows as published. A crash between commit and publish must be recovered by another instance. A failed publish reschedules the row; it is never dropped. A published row is final in the schema: hold the row lock from claim to marking, and mark with `… WHERE published_at IS NULL`, so a repeated publication is a no-op rather than a trigger error.
- Events are published in commit order per wallet: only the oldest unpublished event of each wallet is eligible, ordered by a database sequence assigned at insert, under the wallet lock (never by UUIDv7, which follows each instance's clock). Concurrent publishers therefore never hold two events of the same wallet. An event that keeps failing holds back the later events of its wallet only, and the 10-attempt gauge raises the alert.
- Events: `WagerTransactionProcessed` (every applied transaction, including `LOSS` and the `OPENING`), `WagerTransactionRejected`, `WalletBalanceChanged` (only when the balance changes, after the transaction's own event), `WagerTransactionPendingReference` (when first parked; a rescheduled attempt raises nothing), and `WagerTransactionFailed` (a parked transaction that ends `FAILED`), so every terminal outcome has its event. Opening a wallet above zero raises `WagerTransactionProcessed` (kind `OPENING`) and `WalletBalanceChanged`; opening at zero raises nothing, and there is no wallet-creation event.
- Published message: the body is the event envelope (JSON), `MessageGroupId` the wallet, `MessageDeduplicationId` the event id, and a `eventType` message attribute.
- Reference retries: `ReprocessPendingReference` locks the wallet with `SKIP LOCKED` (busy means skip and come back), reads the transaction again under the lock, and skips it unless it is still `PENDING_REFERENCE` and due. An unexpected, non-transient error marks it `FAILED` (`INTERNAL_ERROR`) in a new unit of work, with its event; a transient error (`WALLET_BUSY`, `DEPENDENCY_UNAVAILABLE`) leaves it parked. A violation of the reversal index runs it once more in the same call: every reversal runs under its reference's wallet lock, so this is no genuine race, and the second run either sees a reversal committed meanwhile, which rejects this one, or violates the index again, a bug that ends `FAILED` like any other duplicate key.
- Obligations of the worker loops (next step): the retry loop processes due ids sequentially, oldest first, within each process (a chain must resolve in order), and paces itself when a round fails transiently or skips busy wallets, since those leave `next_attempt_at` unchanged. The outbox publisher gets an SQS client of its own with a short request timeout and `maxAttempts: 1` (the outbox has its own backoff, and its transaction stays open during the call), and shutdown aborts its calls.

### Retry policies

Pacing and termination are separate concerns. Pacing spreads retries, so that a burst of failures does not come back in the same instant. Termination bounds the lifecycle. Every retry is paced with exponential backoff and full jitter: `delay = random(0, min(cap, base × 2^attempt))`.

| Retry | Pacing | Termination |
|---|---|---|
| `PENDING_REFERENCE` reprocessing (§7.1) | Full jitter, base 1 s, cap 60 s | TTL of 15 minutes, then `REJECTED` with `REFERENCE_NOT_FOUND` |
| Outbox publishing (§11) | Full jitter, base 1 s, cap 60 s | None: retried forever, never deleted, expired or parked |
| Inbound SQS message, transient error (§10) | Full jitter on the visibility timeout, base 5 s, cap 60 s | `maxReceiveCount = 5`, then the DLQ (at most about 2 min 15 s) |
| Wallet lock wait (§8) | No retry inside the request | `lock_timeout` raises a transient error: 503, or SQS redelivery |

- The `PENDING_REFERENCE` deadline is `receipt + TTL`, fixed when the transaction is first persisted. The next attempt is never scheduled past the deadline, and rejection only happens on a real lookup made at or after it. A transaction is therefore never abandoned before the TTL and never rejected without being looked up, even after the worker was down. The TTL errs long on purpose: a reversal that expires before its `BET` arrives leaves the player debited for a bet the provider cancelled, while waiting longer only costs a few cheap lookups. There is no attempt limit: with full jitter, an attempt count says nothing about elapsed time.
- A confirmed event can never be lost, so the outbox has no TTL and no attempt limit. A gauge counts pending outbox rows with 10 or more attempts; together with outbox lag, that is the alert signal. The table itself is the intervention list.
- Base, cap, TTL and the attempt threshold are configurable through the environment (`REFERENCE_TTL_MS`, `REFERENCE_RETRY_BASE_MS`, `REFERENCE_RETRY_CAP_MS`, `OUTBOX_RETRY_BASE_MS`, `OUTBOX_RETRY_CAP_MS`; the attempt threshold arrives with its gauge), so tests can use short values.
- Time and randomness are injected through the `Clock` and `RandomSource` ports. Domain and application code never calls `Date.now()`, `new Date()` or `Math.random()` directly, which keeps backoff and expiry tests deterministic.

### Runtime topology

- One image and one entry point. `APP_ROLES` (`api`, `consumer`, `outbox`, `retry`) selects what a process runs. Compose runs 3 replicas with every role, behind nginx on a single port.
- Every process serves the management endpoints (`/health/*`, `/metrics`) over HTTP, whatever its roles. The `api` role adds the wagering API; the other roles add their workers. Import role modules in `AppModule.forRoot` only when `config.roles` includes them.
- In compose, a replica counts as healthy only when it is ready, and replicas restart unless stopped.
- Migrations and queue creation run once per `docker compose up`, in the one-shot `provision` service; the replicas start only after it succeeds, so instances never race to migrate. Application processes never migrate at boot.
- A replica that dies loses only the requests it was serving. nginx retries a replica that cannot be reached on another one, but never resends a request that already reached a replica.
- Authentication (§2) is not implemented. A no-op `AuthGuard` and a `ProviderIdentityPort` mark the extension point, and `ARCHITECTURE.md` describes the intended design with an external IdP. Never build a users table or password hashing. Messages from the queue are a trusted channel, but the provider identity inside them is validated like any other input.

## Observability (§12)

- Structured JSON logs carry `correlationId`, `messageId`, `transactionId`, `walletId` and `providerId`, propagated with `AsyncLocalStorage`. Never log secrets or full financial payloads.
- Log errors under `err`. They go through an allowlist serializer (type, message, stack, code, constraint, table, column, cause), because database errors carry row values in `detail`, `where` and the failed query. Never widen it to those fields.
- The request-context middleware is registered with `app.use()` in `main.ts`, before NestJS adds its body parser, so requests the parser rejects are still logged and measured. Do not move it into a module's `configure()`.
- Metrics cover at least: transactions by status, duplicates detected, retries, messages in the DLQ, lock conflicts, outbox lag and processing latency. No money amounts and no unbounded identifiers as label values. Use cases stay free of metrics and logging: their results say what happened (`idempotentReplay`, `duplicateMessage`, the reprocess status, the publication failures, `consistent` in a reconciliation report), and the interfaces that call them record metrics and logs from those results. A reconciliation divergence is logged and counted there.
- Metrics are per process. Read them from each replica (for example a Prometheus on the compose network that discovers `app` through Docker DNS), never through the proxy, which hands each scrape to a different replica. Gauges of shared state (outbox lag, rows with many attempts, DLQ depth, pending references) are computed from PostgreSQL or SQS, so every replica reports the same value.
- `GET /health/live` reports on the process; `GET /health/ready` checks PostgreSQL and SQS.

## Testing (§13)

- §13 lists the mandatory unit, integration and concurrency cases. Treat that list as a checklist and keep test names traceable to it.
- Concurrency tests use real parallelism: multi-instance cases run real OS processes. Sequential mocks, or several async tasks posing as instances, do not count. `test/concurrency/use-cases.test.ts` runs the use cases concurrently inside one process, each call on its own connection, so the database-level locking is genuinely exercised; it does not replace the multi-process versions of the §13 scenarios (several instances, two publishers in two processes, a worker killed between commit and acknowledgement, a restart), which come with the interfaces.
- **Use-case tests** open `openUseCaseHarness()` (`test/support/use-cases.ts`): a database of their own, an application ORM with the session timeouts, and the real adapters. `TestClock` and a fixed `random` make deadlines and backoff exact; `variant({ publisher, wrapUnitOfWork })` swaps the publisher or wraps the unit of work for fault injection. Tests that never publish get a publisher that fails if reached; publication tests use `SqsEventPublisher` on LocalStack.
- **Harness (`test/support`).** Each integration or concurrency file creates, in `beforeAll`, its own database (`createTestDatabase()`, cloned from the template the preload migrates once per run) and its own queue set (`createTestQueues()`), and releases them in `afterAll` with `cleanUp(...)`, which runs every step even when one fails. Instances are real processes built from the current sources: `startApp(appEnvironment(database, queues))`, then `waitUntilReady()`, and `stop("SIGKILL")` for crash scenarios. No image rebuild is needed.
- `startApp` refuses an environment without the test file's database and queues, withholds the LocalStack token and `MIKRO_ORM_*` from the child, runs every role unless `APP_ROLES` is passed, and kills a process that fails to start. When starting several instances, keep each one that started (`Promise.allSettled`) so `afterAll` can stop it. The preload sweeps test databases and queues older than an hour.
- Windows cannot deliver a catchable SIGTERM, so `stop("SIGTERM")` kills at once there. Test graceful shutdown against a container (`docker stop`), where it runs on Linux. An exit code of 143 after SIGTERM is expected: NestJS re-raises the signal once its cleanup is done.
- `test/integration/migrations.test.ts` applies, fully reverts and re-applies every migration on an empty database, comparing a fingerprint of the schema catalog (relations, types, functions, triggers, constraints, extensions), not only tables. New migrations are covered automatically and must keep it green.
- Tests must be deterministic. Do not fix a race with `sleep`, retries or a longer timeout; wait on an observable condition.
- Never weaken, skip or delete a failing test to get a green run. A failing invariant test is a finding to report.
- The mandatory scenario of §8 must exist as a concurrency test: balance `100.00`, two concurrent `80.00` bets, exactly one `PROCESSED`, the other `REJECTED` for insufficient funds, final balance `20.00`, exactly one debit entry.

## Scope and sequencing

1. Mandatory requirements first, with the double-entry ledger designed into the first migration.
2. Only once every mandatory requirement and its tests are green: OpenTelemetry tracing (manual spans from HTTP through the use case, the SQL transaction, the outbox and SQS, with trace context propagated in messages, and a Grafana dashboard in an optional Compose profile), and then the load test (`bun run test:load`, reporting environment, methodology, throughput, p50/p95/p99, error rate, concurrency conflicts and outbox lag).
3. Not planned: a second SQS emulator, an identity provider, CI pipelines. Ask before adding any of them.

## Secrets and environment

- `.env` holds `LOCALSTACK_AUTH_TOKEN` and is git-ignored. Never read, print, log or commit it, and never ask the maintainer to paste the token into a chat. Variable names are documented in `.env.example`.
- Never run `docker compose config`, and never `docker inspect` the LocalStack container: both print the token in clear text.
- Configuration comes from environment variables validated with Zod at boot. A missing or invalid variable stops the process with a clear message.
- Files mounted into containers must use LF line endings (`.gitattributes` enforces it). The maintainer develops on Windows; evaluators will most likely run Linux or macOS.

## Documentation deliverables

- `README.md`: setup and commands, limited to ones that have been run and verified. It must explain how to obtain a LocalStack auth token and where to put it, because LocalStack is the only supported emulator.
- `ARCHITECTURE.md` must justify: the ORM choice, the `Money` mapping and the transactional strategy (§4); the concurrency strategy (§8); the authentication decision (§2); the valid state transitions (§6.3); the failure-code taxonomy (§7.2); the retry pacing and the TTL for missing references (§7.1); the `payloadHash` algorithm and the HTTP status mapping (§9); every interpretation that goes beyond the statement (§7); trade-offs and known limitations (§14). Update it in the same change that makes or revises a decision.

## Working agreement

- Talk to the maintainer in Brazilian Portuguese. Everything written to the repository (code, comments, docs, commit messages) is in English.
- Never commit or push unless the maintainer asks. When asked, use Conventional Commits and keep each commit small and focused.
- Before reporting work as done, run lint, typecheck and the affected test suites, and say plainly what was not run.
- A decision that is not covered here or in `docs/CHALLENGE.md` is the maintainer's to make. Ask, then record the answer here and in `ARCHITECTURE.md`.

## Open points

When a decision comes up that this file and `docs/CHALLENGE.md` do not cover, list it here and raise it with the maintainer before implementing the related part.

- **HTTP status of a `FAILED` transaction** (to settle before the HTTP API). The status table covers `PROCESSED` (200), `PENDING_REFERENCE` (202) and `REJECTED` (422), but not `FAILED`, which a replay of its idempotency key or a lookup can return.
- **What the consumer does with an unexpected error** (to settle before the SQS consumer). The error classes cover business rejections, transient errors and permanent ones, but not a bug: a schema guard violation, a duplicate key left after the retry, anything that would be a 500 over HTTP. It can count as transient (visibility backoff, 5 receives, then the DLQ) or go straight to the DLQ. Nothing is committed in either case.

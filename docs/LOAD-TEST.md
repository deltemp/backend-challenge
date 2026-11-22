# Load test

`bun run test:load` measures the stack the way `docker compose up` runs it: three replicas with every role behind nginx, PostgreSQL and LocalStack, all on one machine. The statement sets no throughput target and weighs the quality of the experiment and the honesty of the analysis over the raw number. This document therefore records the method, the environment, a reference run and what it shows, its limits included.

## Running it

```sh
docker compose up -d --build --wait
bun run test:load            # about 5 minutes
bun run test:load --quick    # about 2 minutes, every phase shortened
```

The report of each run lands in `test/load/results/report-<run>.md` (git-ignored). The phases, rates and durations are environment variables (`LOAD_*`, listed in the [README](../README.md#load-test)). The command exits with 1 only when a correctness check fails.

## Method

### Who does what

- **k6** (`test/load/load.js`, in its compose container on the same Docker network) generates the traffic and counts what it sees: each answer, each decided transaction, each replay, each 503.
- **`scripts/load-test.ts`**, on the host, drives the run and judges it:
  1. It checks that the stack answers ready, then records the environment: host, Docker resources, images, commit, and the size of the database before the run.
  2. It opens the wallets the run uses, over HTTP, and waits for the outbox to publish their opening events, so the first phase does not inherit them.
  3. It reads every replica's Prometheus counters before the run and at the end of each phase. Replicas publish no port, so it reads `/metrics` inside each container.
  4. While k6 runs, it reads every second the outbox gauges (`outbox_lag_seconds`, `outbox_pending_events`) and the depth of `wager-transactions.fifo`.
  5. After k6 it waits for the queue and the outbox to drain, reading both at the source: SQS, and the unpublished rows in the database.
  6. It reconciles every wallet through `POST /wallets/:id/reconciliation` and reads the counters again.
  7. It counts the run's transactions in the database by status, and takes each queue message's wait from the inbox. The message id carries the send time and `inbox_messages.received_at` the moment a consumer took it.
  8. It writes the report and checks correctness.

### Traffic

- **An HTTP round** is a `BET` on one of 1,000 wallets, settled by a `WIN` (45%), a `LOSS` (45%) or a `REFUND` (10%), with a stake drawn from 1.00 to 20.00. Three variations exercise the paths that matter under concurrency:
  - 5% of the `WIN`s are rolled back.
  - 5% of the settlements are resent on purpose. The answer must be the stored outcome (same transaction, status, failure code and balance) with `idempotentReplay: true`.
  - 5% of the `BET`s are sent twice at the same instant. Exactly one may be processed and the other must be its replay; anything else counts as an anomaly.

  A round averages 2.1 requests. Its expected balance change is zero, so wallets never run dry.
- **A queue round** sends a `BET` and its settlement as §10 messages, in the wallet's message group, to 200 other wallets and under a provider of its own, so the database tells them apart.
- **A hot-wallet bet** is a `BET` of 1.00. 20 virtual users send them without pause on two wallets, so up to 10 requests compete for each wallet's lock.
- A 503 (`WALLET_BUSY`, `DEPENDENCY_UNAVAILABLE`) or a lost answer is resent with the same idempotency key after its `Retry-After`, as a provider would, up to six attempts. A transaction left without a decision is either *not applied* or *in doubt*:
  - *Not applied*: every attempt met a busy wallet. A lock timeout rolls the transaction back, so it certainly did not commit.
  - *In doubt*: some attempt got no answer, or lost a dependency while it may have committed.

Amounts are strings from a fixed table, as everywhere else: money is never a number.

### Phases

Each phase is its own k6 scenario, run alone and in this order, so their figures stay apart:

| Phase | Load | Duration |
|---|---|---|
| `warmup` | 25 rounds/s over HTTP | 15 s |
| `queue` | 50 rounds/s as messages (100 messages/s) | 45 s |
| `step_25` … `step_200` | 25, 50, 100, 150, 200 rounds/s over HTTP | 30 s each |
| `hot_wallet` | 20 users on 2 wallets, no pause | 15 s |

The queue runs early, while the system is calm. In a first version it ran after the steps, and its numbers mostly measured the backlog the saturated steps had left in the outbox. The hot wallets run last, since their events take a while to drain.

The HTTP steps use k6's constant-arrival-rate executor, an open model: a round starts on schedule whatever the server is doing. A closed model (a fixed number of users looping) would slow its own arrivals as the server slows down and hide the latency a real provider would see (coordinated omission). When every k6 user is busy, the round is dropped and counted, which is itself a sign of saturation. The rates were calibrated so that the steps cross the point where this machine saturates.

### Measures

| Measure | Source |
|---|---|
| Throughput | Rounds, requests and decided transactions per second of each phase, from k6 |
| Latency | k6's `http_req_duration` through nginx: p50, p95, p99, max per phase |
| Time spent inside the replicas | `wager_processing_duration_seconds` from every replica, per phase: the use case, including the wait for a database connection, without nginx or the event loop's queue |
| Error rate | Share of requests answered 5xx or not answered (k6). A 422 rejection or a replay is an outcome, not an error |
| Concurrency conflicts | 503 `WALLET_BUSY` seen by k6, and `wallet_lock_conflicts_total` from the replicas (consumer and retry worker included); idempotency races (the BETs sent twice) |
| Queue | Each message's wait from send to processing, the queue's depth, the time to drain |
| Outbox lag | `outbox_lag_seconds` (age of the oldest unpublished event) and `outbox_pending_events` every second, per phase, and the time to drain after the load |

### Correctness checks

The exit code reflects these checks only. The database is the reference: the run's transactions are counted there by provider and status.

- **No server error and no unexpected answer.** That means no 5xx other than 503, and no 409, 404 or 400, which would mean the script or the service is wrong.
- **HTTP: each transaction stored once, none lost.** For every status, the database holds exactly the run's transactions k6 saw decided, plus those of its transactions in doubt that it turns out to hold. k6 logs the key of each transaction it leaves in doubt, and the script looks each one up, so no outcome is guessed and the comparison has no slack.
- **The replicas' counters match the database.** A counter may miss a stored transaction only when its use case failed after the commit; the client then got a 503 `DEPENDENCY_UNAVAILABLE`. So each transaction that met one allows one uncounted row.
- **Every answer accounted for.** The decisions the replicas counted, replays included, match the answers k6 received; only a lost answer may add one.
- **Replays and races answer the stored outcome.** A replay, and both halves of a BET sent twice at once, must carry the same transaction, status, failure code and balance as the original, and at most one half may be a first-time decision.
- **Queue: each message stored once, none lost.**
  - The run's queue transactions equal the messages sent, plus those whose send got no answer but were stored all the same (looked up by message id).
  - Their inbox rows equal them exactly.
  - The consumers' counter may fall short of the database only by redelivered messages answered from the inbox.
- **No message dead-lettered.** This is checked by the consumers' counter and by the depth of the dead-letter queue, which also catches a redrive after five receives.
- **Every balance equals its ledger**, through the reconciliation endpoint, for every wallet of the run.
- **The queue and the outbox drained, and no replica restarted.** A restart shows as a changed `process_start_time_seconds` or a counter that went down, at the end of the run or at any phase end.

A round still running when its phase ends has 60 seconds to finish (`gracefulStop`): a round cut off with a request in flight would leave an outcome nobody counted, and fail the run.

### Caveats

- One machine runs everything: k6, nginx, three replicas, PostgreSQL and LocalStack share its CPUs, so the load generator competes with the system it measures. The figures say how this stack behaves relative to itself on this machine, not what a production deployment would sustain.
- On Windows and macOS, Docker runs inside a virtual machine (WSL 2 here).
- LocalStack emulates SQS in one Python process. Its latency and throughput are not AWS's, and it accepts the unsigned calls k6 sends.
- nginx writes an access log line per request, and the replicas a log line per message; that cost is part of what is measured.
- The database keeps the rows of every earlier run. The report records its size before the run.
- Tracing is on (as in Compose) but its exports are dropped unless the `observability` profile runs. The reference run had it off.

## Reference run

Run `lt20261122151419` on 22 November 2026: the code of this change, default settings, the default stack (no `observability` profile), 299 seconds from start to finish. The tables below are taken from its report. Two earlier runs with the same plan, which differed only in the outbox claim (`lt20261122143351`, `lt20261122150305`), give the spread where it matters.

| Environment | |
|---|---|
| Host | Windows 11 (10.0.26320), AMD Ryzen 7 2700X (8 cores, 16 threads), 32 GiB |
| Docker | Docker Desktop 29.9.3 on WSL 2: 16 CPUs and 15.6 GiB for every container |
| Topology | 3 replicas with every role behind nginx; PostgreSQL, LocalStack and k6 in containers on the same host |
| Images | postgres:19.0-alpine, localstack/localstack:2026.10.8, nginx:1.30.7-alpine, grafana/k6:2.4.0, the application on Bun 1.4.5 |
| Application | Default settings: 10 database connections per replica, `lock_timeout` 2 s, `statement_timeout` 5 s; tracing on, exports dropped |
| Database before the run | 6,883 wallets, 229,187 transactions, 182,374 ledger entries, every event published |

### HTTP

| Phase | Target (rounds/s) | Rounds/s | Dropped rounds | Requests/s | Decided tx/s | p50 | p95 | p99 | max | Errors | 503s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| warmup | 25 | 25.1 | 0 | 53.6 | 50.9 | 12.3 ms | 20.5 ms | 32.1 ms | 71.3 ms | 0% | 0 |
| step_25 | 25 | 25.0 | 0 | 52.9 | 50.5 | 10.4 ms | 16.8 ms | 37.9 ms | 80.8 ms | 0% | 0 |
| step_50 | 50 | 50.0 | 0 | 106.4 | 101.1 | 11.8 ms | 18.7 ms | 36.1 ms | 77.7 ms | 0% | 0 |
| step_100 | 100 | 100.0 | 0 | 212.6 | 202.5 | 14.4 ms | 26.0 ms | 56.3 ms | 153.7 ms | 0% | 0 |
| step_150 | 150 | 150.0 | 0 | 318.1 | 303.2 | 31.0 ms | 78.9 ms | 121.2 ms | 264.6 ms | 0% | 0 |
| step_200 | 200 | 195.3 | 141 | 416.5 | 395.3 | 412.6 ms | 646.2 ms | 695.0 ms | 788.3 ms | 0% | 0 |
| hot_wallet | 20 users | 141.7 | 0 | 141.7 | 141.7 | 136.0 ms | 201.1 ms | 545.2 ms | 1.12 s | 0% | 0 |

Across the three runs, the phases below the knee agree within a few milliseconds. Past it, `step_200`'s p95 ranged from 626 to 718 ms and its p50 from 319 to 422 ms, and the hot wallets' p99 from 380 to 545 ms.

Time spent inside the replicas (`wager_processing_duration_seconds`, HTTP transactions processed; approximate, from histogram buckets):

| Phase | p50 | p95 | p99 |
|---|---|---|---|
| step_25 | 8.5 ms | 22.8 ms | 26.3 ms |
| step_100 | 17.0 ms | 24.8 ms | 46.9 ms |
| step_150 | 29.7 ms | 84.4 ms | 134.4 ms |
| step_200 | 361.4 ms | 833.5 ms | 966.7 ms |
| hot_wallet | 176.1 ms | 706.3 ms | 947.4 ms |

CPU of the containers during `step_200` (sampled with `docker stats`): each replica 1.03 to 1.38 cores, PostgreSQL 2.4 to 2.8 cores, k6 0.4 to 0.7, nginx 0.15, LocalStack under 0.5.

### Queue

| Messages sent | Wait p50 | Wait p95 | Wait p99 | Wait max | Max depth | Drained after the phase |
|---|---|---|---|---|---|---|
| 4,502 (100 per second) | 33 ms | 70 ms | 107 ms | 188 ms | 8 | 1.1 s |

Across the three runs the wait's p99 ranged from 85 to 107 ms. The consumers spent 17.9 ms (p50) in the use case per message; LocalStack used about one core throughout the phase.

### Outbox

| Phase | Lag max | Lag at the end | Pending events max |
|---|---|---|---|
| warmup to step_100 | 0.5 s | 0.4 s or less | 64 |
| step_150 | 0.5 s | 0.1 s | 218 |
| step_200 | 26.8 s | 26.8 s | 18,384 |
| hot_wallet | 37.0 s | 37.0 s | 20,191 |

After the last phase the outbox drained in 60.6 seconds: 69,580 events were published in all.

### Correctness

Every check passed. The counts agreed three ways:

| | k6 | Replicas' counters | Database |
|---|---|---|---|
| HTTP transactions processed | 34,467 | 34,467 | 34,467 |
| Idempotent replays | 1,657 | 1,657 | |
| Queue transactions | 4,502 sent | 4,502 decided | 4,502 stored, 4,502 inbox rows |

- No transaction was rejected (the round's mix keeps wallets funded), none was left in doubt, and no answer was lost.
- All 805 BETs sent twice at once ended as one processed transaction and one replay with the same outcome.
- The 1,202 wallets of the run reconciled with their ledger.
- No message was dead-lettered, and no replica restarted.

## Analysis

**Below the knee the latency is flat, and almost all of it is the use case.** Up to 100 rounds/s, about 210 requests per second, the median stays between 10 and 15 ms and p95 under 27 ms. The replicas account for nearly all of it: the median time inside the use case is 9 to 17 ms. nginx and the network add a millisecond or two. The p99 of 30 to 60 ms is the tail of the database work: a transaction locks its wallet, writes the transaction, the ledger entry and the outbox rows, and passes the deferred consistency triggers at commit.

**The knee lies between 150 and 200 rounds/s, at about 400 decided transactions per second.**
- At 150 rounds/s the target is held, with p95 at 79 ms.
- At 200 rounds/s, k6 can no longer start every round on time, and 141 are dropped. The stack decides about 395 transactions per second instead of the 420 asked of it, and the median climbs to 413 ms.
- No request fails, before or after the knee: there is no 5xx, no 503 and no timeout. Requests queue instead, well inside the 5-second statement timeout.

**What saturates is the application tier.** At 200 rounds/s each replica runs at 1.0 to 1.4 cores, the limit of its single JavaScript thread, while PostgreSQL uses less than a fifth of its 16 CPUs. The time inside the use case (p50 361 ms) is most of k6's latency (413 ms). Requests therefore wait inside the replicas: in the event loop between the steps of a transaction, and for one of the 10 connections of the pool.

Each transaction costs a replica about 8 ms of CPU: 1.1 cores for about 130 transactions per second, the outbox's share included. That time goes to NestJS, Zod validation, MikroORM, logs, metrics and spans. More replicas would raise the ceiling until the database becomes the limit; this machine cannot show where that is, since k6, nginx and LocalStack run on the same CPUs.

**A hot wallet serializes, but nothing times out.** 20 users betting without pause on 2 wallets get 71 decided transactions per second per wallet, with p99 at 545 ms and no `WALLET_BUSY`. Each replica has 10 connections, so at most 30 transactions can queue on a wallet's lock at once. Each holds it a few milliseconds, and the wait stays far below the 2-second `lock_timeout`. Contention therefore shows as latency, not as conflicts. A `WALLET_BUSY` would take longer transactions or more connections than the pool allows.

**Idempotency holds under load.** Of the 805 BETs sent twice at the same instant, each became one processed transaction and one replay carrying the same outcome. The second request either met the first's row under the wallet lock or lost the race on the unique constraint. The 1,657 settlements resent on purpose all came back as their stored outcome: same status, failure code and balance.

**The queue keeps up at 100 messages per second.** Each message waited 33 ms (p50) and 107 ms (p99) from its send to a consumer, and the queue never held more than 8. The consumers spent 18 ms per message in the use case. LocalStack used a full core at this rate, so a higher one would likely measure the emulator before the consumers.

**The outbox keeps up until the API saturates the replicas.**
- Up to 150 rounds/s the age of the oldest unpublished event stays at half a second or less.
- At 200 rounds/s the transactions produce about 700 events per second (1.8 per transaction). The backlog grows by about 640 a second, to 18,000 events and a 27-second lag. The publishers therefore place only about 60 events per second: they run in the same saturated processes as the API, and get their CPU and connections after it.
- As soon as the request load stops, they publish about 1,300 events per second.
- The backlog drains 61 seconds after the load stops. Its tail is the hot wallets' events: one event per wallet per round, in commit order, about 65 events per second per wallet.

The roles can be split (`APP_ROLES`), so a deployment that must keep the outbox current under peak load would give it processes of its own. Per-wallet ordering costs the most on a hot wallet: every other wallet's events keep flowing in the same rounds, but each round first reads the hot wallets' backlog, which stays cheap only while that backlog is small ([below](#the-claim-behind-a-large-backlog)).

**Correctness does not depend on the load.** At every step, saturation included, each transaction was stored exactly once and none was lost, the replicas' counters agreed with the database, every message was processed once with its inbox row, and every balance equalled its ledger.

## What the load test changed

The runs exposed three defects, fixed in the same change as the load test:

1. **The outbox publisher waited after every partial round.** It paused `OUTBOX_POLL_INTERVAL_MS` (500 ms) after any round short of a full batch of 10, and a round takes one event per wallet. A backlog held by two hot wallets therefore drained at about 10 events per second: of 3,510 events, 618 were still waiting five minutes later. The publisher now goes on at once after any round that published, since publishing an event makes the next one of its wallet due, and waits only when nothing was due. The same kind of backlog then drained in 26 seconds (about 100 events per second); an integration test pins the behaviour.
2. **The outbox claim walked the whole history.** The claim orders pending events by sequence, and PostgreSQL served that order from the unique index on `sequence_number`, which holds every event ever published (they are never purged).
   - **Cost.** After 187,000 events a claim on an empty outbox read 162,000 buffers and took 239 ms. Every round of every publisher paid it, idle or not, and it grew with the history.
   - **Fix.** A partial index on `sequence_number` for unpublished rows brought it to one buffer and 0.013 ms.
   - **A second trap behind it.** A later run drained slowly for a minute: about 75 events per second with PostgreSQL at three cores and the replicas idle. The drain sped up the moment autoanalyze ran on the table. The claim tested each candidate for an earlier unpublished event of its wallet with `NOT EXISTS`, which PostgreSQL turns into an anti-join. Planned with the statistics of an empty outbox, that anti-join scanned every pending event for each candidate: 80 ms per claim behind 23,000 events, reproduced in a rolled-back transaction. The claim now asks whether the candidate holds its wallet's lowest unpublished sequence, as a scalar subquery: a per-wallet index lookup however stale the statistics, 0.2 ms either way.
   - **Effect.** Between the last full run before the index and the reference run:
     - `step_150` went from p95 500 ms with 74 rounds dropped to p95 79 ms with none;
     - `step_200` went from 178 to 195 rounds/s;
     - the maximum outbox lag went from 64 seconds (122 after the hot wallets) to 27 (37);
     - the final drain went from about five minutes to one.

     The two runs used slightly different plans (45-second steps, the queue after them), so the comparison is indicative. The run with the index but still the `NOT EXISTS` claim took 126 seconds to drain, including its slow minute.
3. **nginx answered one request in 50,000 with a 502.** It kept idle connections to the replicas for 60 seconds, while a replica closes them after 5. When nginx reused a connection at the instant the replica closed it, the request met a reset, and nginx does not retry a `POST`. Nothing had been processed (the exactly-once checks showed it). nginx now drops idle connections after 4 seconds. Four full runs since, about 145,000 requests, met no 502. That alone proves little for an event this rare; the mechanism is what makes the fix sound.

The method changed too. The queue phase moved before the steps, because after them it measured the backlog they left.

The correctness checks also went through two independent reviews. The first version compared k6 with the replicas' counters, allowing one extra transaction per unknown outcome, and that slack could hide a double count. The checks now take the database as the reference, and they look up every unknown outcome instead of allowing slack for it. They compare a replay's whole outcome, and they detect a restart by the process start time.

## The claim behind a large backlog

A review of the claim pointed out that its cost grows with the events queued behind the heads it finds. The load test's backlogs were too small to show it, so it was measured on its own.

**Method.** Each scenario ran in a scratch database with the real schema (`pg_dump --schema-only`), in the same PostgreSQL container. It inserted a backlog of due events first, then one due event for each of 50 other wallets, then ran `VACUUM ANALYZE`; payloads averaged 789 bytes, against 795 for real events. The claim's exact SQL then ran six times under `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`, the first as a warm-up, and five times more timed from the client as a cross-check.

| Backlog | Held by | Events read past | Claim, median |
|---|---|---|---|
| 10,000 events | 1 wallet | 9,999 | 74 ms |
| 100,000 events | 1 wallet | 99,999 | 0.77 s |
| 300,000 events | 1 wallet | 299,999 | 2.6 s |
| 1,000,000 events | 1 wallet | 999,999 | 9.7 s |
| 1,000,000 events | 1,000 wallets | 0 | 0.3 ms |

- **A claim reads every event behind the heads it can take, until its batch is full.** That costs 7 to 8 µs per event while the table fits in PostgreSQL's 128 MB of shared buffers, and up to 10 µs beyond. Each claim on a single wallet's backlog took that wallet's head and nine of the other wallets', but only after reading the whole backlog, which holds the oldest sequences. Spread over 1,000 wallets, the same million events cost 0.3 ms: the first ten candidates were ten heads.
- **Every wallet pays for a backlog held by a few.** While fewer than ten heads can be taken, because fewer wallets hold the backlog than a batch takes or because most heads wait out their backoff after failed publications, every round of every publisher reads it whole.
- **Draining such a backlog takes time quadratic in its size.** It goes one event per round, and each round reads what is left: by the measured cost, about 6 minutes for 10,000 events and 11 hours for 100,000, before the time spent publishing.
- **Past about 540,000 events (on this machine), publication stops.** A claim then outlasts the 5-second statement timeout, every round fails, and no event of any wallet is published until `DATABASE_STATEMENT_TIMEOUT_MS` is raised. Nothing is lost: the events wait in the outbox.
- **A hot wallet can get there.** A wallet whose events arrive faster than its rounds publish them keeps growing its backlog while its traffic lasts, faster as the rounds slow. At the load test's hot rate, about 140 events per second, it would take a little over an hour.

A claim that visited one head per wallet with pending events, a skip scan over `outbox_messages_pending_idx` written as a recursive query, would cost per wallet instead of per event, and drain a hot wallet's backlog in linear time. It joins the follow-ups below.

## Not covered

- **Throughput beyond one machine.** The ceiling measured here is this host's. A deployment with the replicas, the database and the load generator apart would move the knee and probably the bottleneck.
- **Endurance.** The runs last about five minutes; memory growth, table growth (published events and inbox rows are kept) and autovacuum over hours are not measured.
- **Failures under load.** Killing replicas, losing PostgreSQL or SQS mid-run: the concurrency and integration suites cover these for correctness, not for performance under load.
- **The observability profile.** With it running, spans are exported to a collector on the same host, which costs CPU the reference run did not pay.
- **The events themselves.** The load test checks that every outbox row was published, not what reached `wager-events.fifo`; the integration and concurrency suites check publication, order and deduplication.
- **The outbox beyond saturation.** Four changes would raise the outbox's ceiling: dedicated outbox processes, publishing several events of a wallet per round (in order), marking a round's events in one statement, and a claim whose cost follows the wallets rather than the events ([above](#the-claim-behind-a-large-backlog)). All four are left as follow-ups.

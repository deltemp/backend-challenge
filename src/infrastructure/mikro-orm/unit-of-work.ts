import type { MikroORM } from "@mikro-orm/postgresql";
import { SpanKind } from "@opentelemetry/api";
import { ATTR_DB_SYSTEM_NAME } from "@opentelemetry/semantic-conventions";
import type { Clock } from "../../application/ports/clock";
import type { IdGenerator } from "../../application/ports/id-generator";
import type { Repositories } from "../../application/ports/repositories";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { hasActiveSpan, inSpan } from "../observability/tracing";
import { translateDatabaseError } from "./database-errors";
import { createRepositories } from "./repositories/repositories";

/**
 * One SQL transaction per call, on an EntityManager forked for it: there is no implicit
 * per-request context. The session's lock and statement timeouts come from the ORM options.
 *
 * Under a traced request, message or job, the transaction gets a span of its own. It is never a
 * root span: the polls of the background loops, which mostly find nothing, leave no trace.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    const transact = async () => {
      try {
        return await this.orm.em
          .fork()
          .transactional((em) => work(createRepositories(em, this.ids, this.clock)));
      } catch (error) {
        throw translateDatabaseError(error);
      }
    };
    return hasActiveSpan()
      ? inSpan(
          "db.transaction",
          { kind: SpanKind.CLIENT, attributes: { [ATTR_DB_SYSTEM_NAME]: "postgresql" } },
          transact,
        )
      : transact();
  }
}

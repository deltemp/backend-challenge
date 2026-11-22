import type { MikroORM } from "@mikro-orm/postgresql";
import type { Clock } from "../../application/ports/clock";
import type { IdGenerator } from "../../application/ports/id-generator";
import type { Repositories } from "../../application/ports/repositories";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { translateDatabaseError } from "./database-errors";
import { createRepositories } from "./repositories/repositories";

/**
 * One SQL transaction per call, on an EntityManager forked for it: there is no implicit
 * per-request context. The session's lock and statement timeouts come from the ORM options.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em
        .fork()
        .transactional((em) => work(createRepositories(em, this.ids, this.clock)));
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}

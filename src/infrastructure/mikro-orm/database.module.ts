import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import type { AppConfig } from "../config/config";
import { APP_CONFIG } from "../config/config.module";
import { createMikroOrmOptions } from "./mikro-orm.config";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...createMikroOrmOptions(config.database),
        // Every unit of work forks its own EntityManager explicitly; there is no implicit
        // per-request context to lean on, and the global EntityManager stays unusable.
        registerRequestContext: false,
      }),
    }),
  ],
})
export class DatabaseModule {}

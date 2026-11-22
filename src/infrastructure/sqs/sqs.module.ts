import type { SQSClient } from "@aws-sdk/client-sqs";
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { AppConfig } from "../config/config";
import { APP_CONFIG } from "../config/config.module";
import { createSqsClient, SQS_CLIENT } from "./sqs-client";

@Injectable()
class SqsClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config.aws),
    },
    SqsClientLifecycle,
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule {}

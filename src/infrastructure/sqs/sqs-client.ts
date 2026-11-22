import { SQSClient } from "@aws-sdk/client-sqs";
import type { AwsConfig } from "../config/config";
import { SQS_CONNECTION_TIMEOUT_MS } from "./limits";

/** Injection token for the shared {@link SQSClient}. */
export const SQS_CLIENT = Symbol("SQS_CLIENT");

export interface SqsClientOptions {
  /** Longest single request. The shared client's must stay above the longest long poll. */
  readonly requestTimeoutMs?: number;
  /** Attempts per call, the SDK's retries included: 1 for a caller with its own backoff. */
  readonly maxAttempts?: number;
}

export function createSqsClient(aws: AwsConfig, options: SqsClientOptions = {}): SQSClient {
  return new SQSClient({
    region: aws.region,
    endpoint: aws.endpointUrl,
    // Always talk to the configured endpoint. By default the SDK sends each call to the host
    // inside the QueueUrl, and the URLs LocalStack returns are not reachable from every network
    // (for example localhost.localstack.cloud from inside another container).
    useQueueUrlAsEndpoint: false,
    maxAttempts: options.maxAttempts,
    // Bounded calls, so an unreachable SQS surfaces as a transient error instead of a hang. The
    // default request timeout stays above the longest long poll (20 seconds).
    requestHandler: {
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
      requestTimeout: options.requestTimeoutMs ?? 30_000,
    },
  });
}

import { SQSClient } from "@aws-sdk/client-sqs";
import type { AwsConfig } from "../config/config";

/** Injection token for the shared {@link SQSClient}. */
export const SQS_CLIENT = Symbol("SQS_CLIENT");

export function createSqsClient(aws: AwsConfig): SQSClient {
  return new SQSClient({
    region: aws.region,
    endpoint: aws.endpointUrl,
    // Always talk to the configured endpoint. By default the SDK sends each call to the host
    // inside the QueueUrl, and the URLs LocalStack returns are not reachable from every network
    // (for example localhost.localstack.cloud from inside another container).
    useQueueUrlAsEndpoint: false,
    // Bounded calls, so an unreachable SQS surfaces as a transient error instead of a hang. The
    // request timeout must stay above the longest long poll (20 seconds).
    requestHandler: { connectionTimeout: 3000, requestTimeout: 30_000 },
  });
}

import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";

/**
 * Resolves queue names to URLs once and remembers them. A failure is not remembered, so a
 * process that starts while SQS is unavailable resolves the URL as soon as SQS answers.
 */
export class QueueUrls {
  private readonly resolved = new Map<string, string>();

  constructor(private readonly client: SQSClient) {}

  async resolve(name: string, signal?: AbortSignal): Promise<string> {
    const known = this.resolved.get(name);
    if (known !== undefined) {
      return known;
    }
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }), {
      abortSignal: signal,
    });
    if (QueueUrl === undefined || QueueUrl === "") {
      throw new Error(`GetQueueUrl returned no URL for ${name}`);
    }
    this.resolved.set(name, QueueUrl);
    return QueueUrl;
  }
}

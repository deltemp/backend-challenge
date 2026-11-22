import { describe, expect, test } from "bun:test";
import { WagerTransactionProcessed } from "../../../src/domain/events/events";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { FullJitterBackoff } from "../../../src/domain/shared/backoff";
import { InvariantViolationError } from "../../../src/domain/shared/errors";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction";
import { apply, at, MIDDLE, openWallet, submit, WALLET } from "./fixtures";

const HASH = "a".repeat(64);

describe("InboxMessage", () => {
  test("is received unprocessed and processed exactly once", () => {
    const message = InboxMessage.receive({
      messageId: "message-1",
      consumerName: "wager-transactions",
      payloadHash: HASH,
      receivedAt: at(0),
    });

    expect(message.isProcessed()).toBe(false);
    message.markProcessed(at(1));
    expect(message.processedAt).toEqual(at(1));
    expect(() => message.markProcessed(at(2))).toThrow(InvariantViolationError);
  });

  test("needs a message id and a consumer", () => {
    const props = { messageId: "m", consumerName: "c", payloadHash: HASH, receivedAt: at(0) };

    expect(() => InboxMessage.receive({ ...props, messageId: "" })).toThrow(
      InvariantViolationError,
    );
    expect(() => InboxMessage.receive({ ...props, consumerName: "" })).toThrow(
      InvariantViolationError,
    );
  });

  test("rehydrates as persisted", () => {
    const message = InboxMessage.rehydrate({
      messageId: "message-1",
      consumerName: "wager-transactions",
      payloadHash: HASH,
      receivedAt: at(0),
      processedAt: at(1),
    });

    expect(message.isProcessed()).toBe(true);
  });
});

describe("OutboxMessage", () => {
  const backoff = FullJitterBackoff.create({ baseMs: 1000, capMs: 60_000, random: MIDDLE });

  function enqueued(): OutboxMessage {
    const wallet = openWallet("100.00");
    const loss = submit({ kind: WagerTransactionKind.Loss });
    apply(wallet, loss);
    return OutboxMessage.enqueue(
      WagerTransactionProcessed.from(loss, {
        eventId: "event-1",
        correlationId: "correlation-1",
        occurredAt: at(1),
      }),
    );
  }

  test("stores the event envelope under the event id, keyed by the wallet", () => {
    const message = enqueued();

    expect(message.id).toBe("event-1");
    expect(message.orderingKey).toBe(WALLET);
    expect(message.eventType).toBe("WagerTransactionProcessed");
    expect(message.payload).toMatchObject({ eventId: "event-1", version: 1 });
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
  });

  test("is due as soon as the event occurred", () => {
    const message = enqueued();

    expect(message.isDue(at(1))).toBe(true);
    expect(message.isDue(new Date(at(1).getTime() - 1))).toBe(false);
  });

  test("a failed publication is rescheduled with full-jitter backoff", () => {
    const message = enqueued();

    message.scheduleRetry(at(2), backoff);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date(at(2).getTime() + 500));
    expect(message.isDue(at(2))).toBe(false);

    message.scheduleRetry(at(3), backoff);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(new Date(at(3).getTime() + 1000));
  });

  test("is never dropped: there is no attempt limit", () => {
    const message = enqueued();

    for (let attempt = 1; attempt <= 50; attempt += 1) {
      message.scheduleRetry(at(attempt), backoff);
    }

    expect(message.attempts).toBe(50);
    expect(message.isPending()).toBe(true);
    // The delay stays under the cap: random(0, 60 s), so 30 s with the middle random value.
    expect(message.nextAttemptAt).toEqual(new Date(at(50).getTime() + 30_000));
  });

  test("once published, it is neither due nor retried", () => {
    const message = enqueued();

    message.markPublished(at(2));

    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(99))).toBe(false);
    expect(message.publishedAt).toEqual(at(2));
    expect(() => message.markPublished(at(3))).toThrow(InvariantViolationError);
    expect(() => message.scheduleRetry(at(3), backoff)).toThrow(InvariantViolationError);
  });
});

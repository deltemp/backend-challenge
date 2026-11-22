import { describe, expect, test } from "bun:test";
import { resolveCorrelationId } from "../../src/infrastructure/observability/request-context";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("resolveCorrelationId", () => {
  test("keeps a caller id made of safe characters", () => {
    expect(resolveCorrelationId("provider-a:txn_123.retry")).toBe("provider-a:txn_123.retry");
  });

  test("generates a UUIDv7 when the caller sends none", () => {
    expect(resolveCorrelationId(undefined)).toMatch(UUID_V7);
  });

  test("replaces ids that could inject content into the logs", () => {
    expect(resolveCorrelationId('abc"}\n{"level":"fatal')).toMatch(UUID_V7);
    expect(resolveCorrelationId("with space")).toMatch(UUID_V7);
  });

  test("replaces ids longer than 128 characters", () => {
    expect(resolveCorrelationId("a".repeat(128))).toBe("a".repeat(128));
    expect(resolveCorrelationId("a".repeat(129))).toMatch(UUID_V7);
  });
});

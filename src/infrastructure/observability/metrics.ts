import { collectDefaultMetrics, Histogram, Registry } from "prom-client";

/**
 * Prometheus registry for this process. A dedicated registry, instead of prom-client's global
 * one, keeps metric registration explicit and safe to repeat.
 *
 * Label values must stay bounded: never amounts, and never raw ids or paths.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration, by method, matched route and status code.",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}

// k6 smoke run that proves the load-test wiring: k6 container → nginx → 3 replicas.
// The real load test (wagering traffic, percentiles, conflicts, outbox lag) comes after the
// mandatory requirements. Run with: bun run test:load

import { check } from "k6";
import http from "k6/http";

export const options = {
  vus: 10,
  duration: "10s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<200"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const response = http.get(`${baseUrl}/health/live`);
  check(response, { "status is 200": (r) => r.status === 200 });
}

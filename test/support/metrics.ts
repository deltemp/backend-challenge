const SERIES = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/;
const LABEL = /(\w+)="((?:[^"\\]|\\.)*)"/g;

/**
 * The sum of the series of a metric whose labels include `labels`, read from one instance's
 * `/metrics`. Zero when no series matches.
 */
export async function metricValue(
  baseUrl: string,
  name: string,
  labels: Readonly<Record<string, string>> = {},
): Promise<number> {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  let sum = 0;
  for (const line of text.split("\n")) {
    const match = SERIES.exec(line);
    if (match === null || match[1] !== name) {
      continue;
    }
    const found = new Map(
      [...(match[2] ?? "").matchAll(LABEL)].map((label) => [label[1], label[2]]),
    );
    if (Object.entries(labels).every(([key, value]) => found.get(key) === value)) {
      sum += Number(match[3]);
    }
  }
  return sum;
}

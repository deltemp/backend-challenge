import { expect, test } from "bun:test";
import { join } from "node:path";

const DOMAIN = join(import.meta.dirname, "..", "..", "..", "src", "domain");
// decimal.js inside Money; node:crypto (built in) for the payload hash. Nothing else.
const ALLOWED = new Set(["decimal.js", "node:crypto"]);
// `… from "x"` (import and re-export), side-effect `import "x"`, and dynamic `import("x")`.
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g;

test("the domain depends on nothing but decimal.js and built-in modules", async () => {
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: DOMAIN })) {
    const source = await Bun.file(join(DOMAIN, file)).text();
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? "";
      if (!specifier.startsWith(".") && !ALLOWED.has(specifier)) {
        offenders.push(`${file}: ${specifier}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});

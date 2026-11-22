// Stop hook: runs `bun run typecheck` when TypeScript sources have uncommitted changes.
//
// On failure it exits with code 2, which blocks the stop and sends the compiler
// errors back to the agent. It never blocks twice in a row (`stop_hook_active`),
// so errors the agent cannot fix do not turn into a loop.
//
// Does nothing until the project has a `typecheck` script and TypeScript installed.

import { existsSync } from "node:fs";
import { join } from "node:path";

interface HookInput {
  stop_hook_active?: boolean;
}

interface PackageJson {
  scripts?: Record<string, string>;
}

const MAX_REPORTED_LINES = 80;
const WATCHED_PATHS = ["*.ts", "*.tsx", "*.mts", "*.cts", "tsconfig*.json", "package.json"];

function readInput(raw: string): HookInput {
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

const input = readInput(await Bun.stdin.text());
if (input.stop_hook_active) {
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const packageJsonPath = join(projectDir, "package.json");

if (!existsSync(packageJsonPath) || !existsSync(join(projectDir, "node_modules", "typescript"))) {
  process.exit(0);
}

const packageJson = (await Bun.file(packageJsonPath).json()) as PackageJson;
if (!packageJson.scripts?.typecheck) {
  process.exit(0);
}

const changes = Bun.spawnSync(
  ["git", "status", "--porcelain", "--untracked-files=all", "--", ...WATCHED_PATHS],
  { cwd: projectDir, stdout: "pipe", stderr: "ignore" },
);
if (changes.exitCode !== 0 || changes.stdout.toString().trim() === "") {
  process.exit(0);
}

const typecheck = Bun.spawnSync([process.execPath, "run", "typecheck"], {
  cwd: projectDir,
  stdout: "pipe",
  stderr: "pipe",
});
if (typecheck.exitCode === 0) {
  process.exit(0);
}

const lines = `${typecheck.stdout.toString()}\n${typecheck.stderr.toString()}`
  .trim()
  .split(/\r?\n/);
const omitted = lines.length - MAX_REPORTED_LINES;
const report = lines.slice(0, MAX_REPORTED_LINES).join("\n");
const suffix = omitted > 0 ? `\n... ${omitted} more lines omitted` : "";

console.error(
  `Typecheck failed (bun run typecheck). Fix these errors before finishing:\n${report}${suffix}`,
);
process.exit(2);

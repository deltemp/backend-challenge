// PostToolUse hook for Edit and Write: formats the edited TypeScript file with Biome.
//
// Formatting only. Lint fixes are left out on purpose: removing a "not yet used"
// import between two edits would break changes that span several edits.
//
// Never blocks and never reports an error: a file that fails to format is caught
// later by `bun run lint`. Does nothing until Biome is installed in the project.

import { existsSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

interface HookInput {
  tool_input?: { file_path?: string };
  tool_response?: { filePath?: string };
}

const FORMATTABLE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function readInput(raw: string): HookInput {
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

const input = readInput(await Bun.stdin.text());
const filePath = input.tool_response?.filePath ?? input.tool_input?.file_path;
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

if (!filePath || !FORMATTABLE_EXTENSIONS.has(extname(filePath))) {
  process.exit(0);
}

const absolutePath = resolve(projectDir, filePath);
const pathInProject = relative(projectDir, absolutePath);
const isOutsideProject = pathInProject.startsWith("..") || isAbsolute(pathInProject);

// Biome's own launcher, run directly. Going through `bunx biome` could resolve an
// unrelated package from the registry when the local binary is missing.
const biomeLauncher = join(projectDir, "node_modules", "@biomejs", "biome", "bin", "biome");

if (isOutsideProject || !existsSync(biomeLauncher) || !existsSync(absolutePath)) {
  process.exit(0);
}

Bun.spawnSync(
  [process.execPath, biomeLauncher, "format", "--write", "--no-errors-on-unmatched", absolutePath],
  { cwd: projectDir, stdout: "ignore", stderr: "ignore" },
);

process.exit(0);

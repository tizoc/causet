import { fileURLToPath } from "node:url";
import { buildGuide, GuideError } from "./build.ts";

try {
  // pnpm runs scripts from the repository root; INIT_CWD is where it was run.
  const { pages, out } = buildGuide(
    fileURLToPath(new URL("..", import.meta.url)),
    process.argv.slice(2),
    process.env.INIT_CWD || process.cwd(),
  );
  console.log(`built ${pages} pages into ${out}`);
} catch (error) {
  const problems = error instanceof GuideError ? error.problems : [String(error)];
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exitCode = 1;
}

// Writes coverage/badge.json from Vitest's coverage/coverage-summary.json,
// after `bun run test:coverage`. CI publishes it to the "badges" branch.
//
//   bun run coverage:badge
import { readFile, writeFile } from "node:fs/promises";
import { coverageBadge } from "./badge.ts";

async function main(): Promise<void> {
  const summary = JSON.parse(await readFile("coverage/coverage-summary.json", "utf8")) as {
    total: { lines: { pct: number } };
  };
  const badge = coverageBadge(summary.total.lines.pct);
  await writeFile("coverage/badge.json", `${JSON.stringify(badge)}\n`);
  console.log(`Coverage badge: ${badge.message} (${badge.color})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

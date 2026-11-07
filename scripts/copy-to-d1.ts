// Copies existing users' data from Supabase into D1 (GSB-7).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GITHUB_TOKEN=... \
//     bun run migrate:copy -- --env=production --mode=shadow
//
// --mode=full   the final copy at the switch: D1 becomes an exact copy, and
//               every subscription starts at Supabase's star count.
// --mode=shadow the daily copy during the shadow run: chats and subscriptions
//               are mirrored, the Worker's own star counts are kept.
// --env=production|staging  required: the D1 database the SQL is for (shadow
//               mode reads its current subscriptions).
// --out=<file>  where to write the SQL (default: your temp folder).
// --local       the local D1 instead of the remote one.
//
// Take a Supabase backup (pg_dump) before a full copy. This script only reads
// Supabase and GitHub and writes a SQL file; it prints the wrangler command
// that applies it. The file contains chat IDs: delete it afterwards.
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNever } from "../src/result.ts";
import { copyMode, d1Target, option, requiredEnv, runCommand, runMain, starEventsSince, today } from "./migration/cli.ts";
import { exportSupabase, lookUpNodeIds, readD1Snapshot, wranglerTargetArgs, type D1Target } from "./migration/io.ts";
import { buildD1Sql, type CopyOptions } from "./migration/to-d1.ts";
import type { CopyMode } from "./migration/types.ts";

/** Full: the gains window. Shadow: D1's current subscriptions, so only the differences are written. */
async function copyOptions(mode: CopyMode, day: string, target: D1Target): Promise<CopyOptions> {
  switch (mode) {
    case "full":
      return { mode, today: day };
    case "shadow":
      return { mode, current: (await readD1Snapshot(runCommand, target)).subscriptions };
    default:
      return assertNever(mode);
  }
}

async function main(): Promise<void> {
  const mode = copyMode();
  const target = d1Target();
  const day = today();
  const out = option("out") ?? join(tmpdir(), `d1-copy-${target.environment}-${mode}.sql`);
  const supabase = { url: requiredEnv("SUPABASE_URL"), serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY") };

  const now = new Date().toISOString();
  const data = await exportSupabase(supabase, { starEventsSince: mode === "full" ? starEventsSince(day) : null, now });
  console.log(
    `Supabase: ${data.chats.length} chats, ${data.repositories.length} repositories, ` +
      `${data.subscriptions.length} subscriptions, ${data.starEvents.length} star events`,
  );
  const nodeIds = await lookUpNodeIds({ token: requiredEnv("GITHUB_TOKEN") }, data.repositories.map((r) => r.github_id));
  const gone = [...nodeIds.values()].filter((id) => id === null).length;
  console.log(`GitHub: ${nodeIds.size - gone} node IDs found, ${gone} repositories gone or private (stored as archived)`);

  const sql = buildD1Sql(data, nodeIds, await copyOptions(mode, day, target));
  if (!sql.ok) {
    console.error("The export has problems; nothing was written:");
    for (const problem of sql.error) {
      console.error(`  ${JSON.stringify(problem)}`);
    }
    process.exitCode = 1;
    return;
  }

  await writeFile(out, sql.value, { mode: 0o600 });
  console.log(`\nWrote ${out}. Next:`);
  const local = target.location === "local" ? " --local" : "";
  console.log(`  bunx wrangler d1 execute DB ${wranglerTargetArgs(target).join(" ")} --file ${out}`);
  console.log(`  bun run migrate:verify -- --env=${target.environment} --mode=${mode} --today=${day}${local}`);
  console.log(`  rm ${out}   # it contains chat IDs`);
}

runMain(main);

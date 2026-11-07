// Copies existing users' data from Supabase into D1 (GSB-7).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GITHUB_TOKEN=... \
//     bun run migrate:copy -- --mode=shadow
//
// --mode=full   the final copy at the switch: D1 becomes an exact copy, and
//               every subscription starts at Supabase's star count.
// --mode=shadow the daily copy during the shadow run: chats and subscriptions
//               are mirrored, the Worker's own star counts are kept.
// --out=<file>  where to write the SQL (default: your temp folder).
//
// Take a Supabase backup (pg_dump) before a full copy. This script only reads
// Supabase and GitHub and writes a SQL file; it prints the wrangler command
// that applies it. The file contains chat IDs: delete it afterwards.
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyMode, option, requiredEnv, runMain, today } from "./migration/cli.ts";
import { exportSupabase, lookUpNodeIds } from "./migration/io.ts";
import { buildD1Sql } from "./migration/to-d1.ts";

async function main(): Promise<void> {
  const mode = copyMode();
  const out = option("out") ?? join(tmpdir(), `d1-copy-${mode}.sql`);
  const supabase = { url: requiredEnv("SUPABASE_URL"), serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY") };

  const data = await exportSupabase(supabase);
  console.log(
    `Supabase: ${data.chats.length} chats, ${data.repositories.length} repositories, ` +
      `${data.subscriptions.length} subscriptions, ${data.starEvents.length} star events`,
  );
  const nodeIds = await lookUpNodeIds({ token: requiredEnv("GITHUB_TOKEN") }, data.repositories.map((r) => r.github_id));
  const gone = [...nodeIds.values()].filter((id) => id === null).length;
  console.log(`GitHub: ${nodeIds.size - gone} node IDs found, ${gone} repositories gone or private (stored as archived)`);

  const sql = buildD1Sql(data, nodeIds, { mode, today: today() });
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
  console.log(`  bunx wrangler d1 execute DB --remote --file ${out}`);
  console.log(`  bun run migrate:verify -- --mode=${mode}`);
  console.log(`  rm ${out}   # it contains chat IDs`);
}

runMain(main);

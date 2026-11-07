// Compares Supabase and D1 in full and fails on any difference (GSB-7).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     bun run migrate:verify -- --env=production --mode=full [--local]
//
// --mode=full   after the final copy: also star counts and the last 90 days
//               of gains.
// --mode=shadow during the shadow run: chats, subscriptions and names only;
//               star counts and gains are the Worker's own.
// --today=YYYY-MM-DD  full only: the day the copy ran (copy-to-d1 prints it),
//               so the 90-day gains window is the same one the copy used.
// --env=production|staging  required: the D1 database to compare.
// --local       read the local D1 (a dry run) instead of the remote one.
// Read-only.
import { copyMode, d1Target, requiredEnv, runCommand, runMain, starEventsSince, today } from "./migration/cli.ts";
import { exportSupabase, readD1Snapshot } from "./migration/io.ts";
import { compareCopies } from "./migration/verify.ts";

const SHOWN = 20;

async function main(): Promise<void> {
  const mode = copyMode();
  const target = d1Target();
  const day = today();
  const supabase = { url: requiredEnv("SUPABASE_URL"), serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY") };
  const exportOptions = { starEventsSince: mode === "full" ? starEventsSince(day) : null, now: new Date().toISOString() };
  const [source, d1] = await Promise.all([exportSupabase(supabase, exportOptions), readD1Snapshot(runCommand, target)]);

  const differences = compareCopies(source, d1, { mode, today: day });
  if (differences.length === 0) {
    console.log(
      `Supabase and D1 (${target.environment}) match (${mode}): ${d1.chats.length} chats, ${d1.repositories.length} repositories, ` +
        `${d1.subscriptions.length} subscriptions.`,
    );
    return;
  }
  console.error(`${differences.length} differences between Supabase and D1 (${mode}):`);
  for (const difference of differences.slice(0, SHOWN)) {
    console.error(`  ${difference}`);
  }
  if (differences.length > SHOWN) {
    console.error(`  ... and ${differences.length - SHOWN} more`);
  }
  process.exitCode = 1;
}

runMain(main);

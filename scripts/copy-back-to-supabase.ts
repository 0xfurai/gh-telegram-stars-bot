// Copies D1 back to Supabase, for a rollback to the old app (GSB-7, GSB-11).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     bun run migrate:copy-back -- [--dry-run] [--local]
//
// Copies chats, repositories with their current star counts, and
// subscriptions (adding new ones, deleting removed ones). The star counts
// matter: without them the old app would re-send every notification the
// Worker already sent. Star gains aren't copied back.
//
// --dry-run  print what would change, write nothing.
// --local    read the local D1 instead of the remote one.
// Then verify: bun run migrate:verify -- --mode=shadow
import { d1Target, flag, requiredEnv, runCommand, runMain } from "./migration/cli.ts";
import { deleteSubscriptions, readD1Snapshot, selectAll, upsert, type Supabase } from "./migration/io.ts";
import { planChatsAndRepositories, planSubscriptions, type SupabaseSubscriptionKey } from "./migration/to-supabase.ts";

async function currentSupabaseState(supabase: Supabase) {
  const [repositories, subscriptions] = await Promise.all([
    selectAll<{ id: number; github_id: number }>(supabase, "repositories", { columns: "id,github_id", order: "id" }),
    selectAll<SupabaseSubscriptionKey>(supabase, "chat_repositories", {
      columns: "chat_id,repository_id",
      order: "chat_id,repository_id",
    }),
  ]);
  return { repositories, subscriptions };
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const supabase = { url: requiredEnv("SUPABASE_URL"), serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY") };
  const d1 = await readD1Snapshot(runCommand, d1Target());
  const { chats, repositories } = planChatsAndRepositories(d1);
  console.log(`D1: ${chats.length} chats, ${repositories.length} repositories, ${d1.subscriptions.length} subscriptions`);

  if (!dryRun) {
    await upsert(supabase, "chats", "id", chats);
    await upsert(supabase, "repositories", "github_id", repositories);
  }
  // After the upserts, every repository has a Supabase ID (in a dry run, new ones show as unmapped).
  const state = await currentSupabaseState(supabase);
  const plan = planSubscriptions(d1, state.repositories, state.subscriptions);
  console.log(`Subscriptions: ${plan.add.length} to add, ${plan.remove.length} to delete`);
  if (dryRun) {
    if (plan.unmapped.length > 0) {
      console.log(`${plan.unmapped.length} repositories are new to Supabase; the real run adds them first.`);
    }
    console.log("Dry run: nothing was written.");
    return;
  }
  if (plan.unmapped.length > 0) {
    // Writing the rest would leave Supabase with some subscriptions deleted and others missing.
    console.error(`Repositories without a Supabase ID: ${plan.unmapped.join(", ")}. No subscriptions were changed.`);
    process.exitCode = 1;
    return;
  }

  await upsert(supabase, "chat_repositories", "chat_id,repository_id", plan.add);
  await deleteSubscriptions(supabase, plan.remove);
  console.log("Done. Verify with: bun run migrate:verify -- --mode=shadow");
}

runMain(main);

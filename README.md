# Telegram GitHub Stars Bot

A Telegram bot that notifies subscribers about new stars on GitHub repositories.

> **Migration in progress.** `main` is being rebuilt as a Cloudflare Worker with D1.
> Production still runs the old Node.js app from the [`legacy`](../../tree/legacy) branch, which has its own README.
>
> To read the old code while porting, without switching branches:
>
> ```sh
> git show origin/legacy:src/services/polling.ts
> git worktree add ../gh-stars-legacy legacy   # full checkout next to this one
> ```

## Development

Requires:

* **Bun** for installing packages and running scripts. The version is in `packageManager` in `package.json`.
* **Node.js 24** to run the tools (Wrangler, Vitest, ESLint, tsc). See `.nvmrc`; run `nvm use`.

```sh
bun install
cp .dev.vars.example .dev.vars
bun run dev            # local Worker on http://localhost:8787 (GET /health)
bun run dev:scheduled  # same, plus GET /__scheduled to trigger the star check
bun run typecheck
bun run lint           # includes a complexity limit of 10 per function
bun run test           # Vitest inside the Workers runtime
bun run typegen        # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

Use `bun run test`, not `bun test`: `bun test` starts Bun's own test runner instead of Vitest.

### Local settings and secrets

* Local values go in `.dev.vars`. It's ignored by git; never commit it. `.dev.vars.example` lists every setting; use a test bot, never the production one.
* Every setting is validated at startup (`src/config.ts`). With an invalid or missing setting, the Worker answers every request with 503, fails scheduled runs, and logs which settings are wrong (never their values). `NOTIFICATIONS` has no default on purpose.
* Settings without a default are secrets, declared in `wrangler.jsonc` under `secrets.required` and set with `wrangler secret put <NAME>`. Secrets survive deploys, and changing one (for example `NOTIFICATIONS=off` in an emergency) takes effect without a code deploy.
* Settings with a default (`MAX_REPOS_PER_CHAT`, `ALLOWED_CHAT_IDS`, `ADMIN_CHAT_ID`) live in `wrangler.jsonc` under `vars`. Change them there, never in the Cloudflare dashboard: `wrangler deploy` removes plain settings that aren't in the file.
* `wrangler dev` only loads `.dev.vars` keys that are declared in `secrets.required` or `vars`. Generated types come from those lists too, not from your local files, so CI and your machine always agree.
* Wrangler falls back to a root `.env` when `.dev.vars` is missing. Keep a `.dev.vars` file, and don't keep a root `.env` in this repo.

### Database (D1)

The schema lives in `migrations/`, one numbered SQL file per change. Never edit a migration that has been applied anywhere; add a new one.

```sh
bunx wrangler d1 migrations create DB <name>   # new empty migration file
bunx wrangler d1 migrations apply DB --local   # apply to the local dev database
bunx wrangler d1 execute DB --local --command "SELECT * FROM chats"
```

Tests apply the same migrations to a fresh database (`test/apply-migrations.ts`).

D1 bills rows written (index entries included) and rows read. The free plan allows 100k written and 5M read per day. So:

* Add an index only when a query needs it: each one adds a written row to every write of its columns.
* Keep tables that queries scan small. Star gains are stored per repository per day (`daily_star_gains`), not per event.

`test/schema.test.ts` pins the list of tables and indexes, SQLite's automatic ones included, and checks that the writes the star check repeats cost one row each.

### Dependency install scripts

Bun only runs install scripts for packages listed in `trustedDependencies` in `package.json`: `esbuild` and `workerd`, which download native binaries. After adding a dependency, check that nothing else needs its scripts:

```sh
bun pm untrusted
```

## Telegram webhook

Telegram sends updates to `POST /webhook` on the Worker. Requests without the right `X-Telegram-Bot-Api-Secret-Token` (the `WEBHOOK_SECRET` setting) get 401.

To point a bot at a deployed Worker and register its command menu:

```sh
TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://<worker-host> bun run telegram:setup
```

Use the same token and secret as the Worker's secrets. The script:

1. Checks the token (`getMe`) and prints the `BOT_INFO` value to store with `wrangler secret put BOT_INFO`.
2. Refuses to continue unless the Worker's `/health` answers 200. A 503 means a setting is missing or invalid: store it and run the script again.
3. Sets the webhook, keeping pending updates so messages sent during a switch reach the Worker, and registers the command menu.

Every webhook request gets 200 once the secret checks out, so Telegram never redelivers an update:

* A handler that throws (a bug, a D1 outage) is logged as `"Update failed"` with the update ID, and the user gets "Something went wrong" instead of silence, unless the handler had already replied. Membership updates get no reply.
* A reply Telegram refuses (blocked, rate-limited, chat gone) is logged as `"Reply not sent"` with the reason.
* A body that isn't JSON is logged as `"Webhook request failed"`.
* An update that takes over 20 seconds gets its 200 early.

## Star check

A Cron Trigger runs `src/star-check.ts` every 5 minutes:

1. Checks subscribed repositories on GitHub, 100 per GraphQL request, continuing from where the last run stopped.
2. Saves what changed (stars, names, descriptions) and today's gains.
3. Sends due notifications: one message per chat, listing every repository that gained stars since that chat was last told. A chat is only marked notified after Telegram accepts the message, so a failed send is retried next run.

`NOTIFICATIONS` controls step 3:

| Mode | What happens |
|---|---|
| `on` | Sends. With `ALLOWED_CHAT_IDS` set, only to those chats. |
| `dry-run` | Logs each notification (`"Notification skipped"`) and marks it sent. Used for the shadow run. |
| `off` | Sends and marks nothing; everything stays due. The emergency stop: `wrangler secret put NOTIFICATIONS`, no deploy. |

Limits and safety:

* **Subrequest budget.** Each run stays within 45 subrequests (the free plan allows about 50; fetch calls and D1 queries both count).
  * GitHub gets up to 10 requests (1,000 repositories).
  * Messages get what's left, at most 20, at 2 subrequests each: the send, then one D1 batch marking it sent.
  * Everything else waits for the next run. The summary's `subrequests` field shows what a run used.
* **Run lock.** Two runs never overlap. A run that finds the lock held skips. A crashed run's lock expires after 10 minutes. If a failed run can't release the lock either (D1 down), that's logged, and the run reports its own error. If only the release fails, the run fails, so it's recorded and alerted on.
* **Telegram failures.**
  * A rate limit or outage stops sending for that run.
  * A message Telegram rejects (likely a bug on our side) is logged and dropped.
  * If marking a sent message fails, sending stops, and the possible duplicate is logged.
* **Retention.** The first run after midnight UTC deletes star gains older than 90 days.

Every run logs a `"Star check finished"` summary.

Run one locally with `bun run dev:scheduled`, then open `/__scheduled`.

## Monitoring

* **Run log.** Every star check run is saved in `star_check_runs` (kept 7 days), with its summary as JSON.
* **Alerts** go to `ADMIN_CHAT_ID`, at most once an hour, when something needs a person:
  * **At once:** GitHub rejected the token, or answered something unexpected (likely a bug). The Cron invocation fails too, so Cloudflare shows it.
  * **Only when star checks go stale** (no successful run in 15 minutes): temporary problems such as rate limits, timeouts, or GitHub or D1 outages, and crashes. These usually heal by themselves.
  * A run that hit a temporary GitHub error after making some progress counts as successful.
  * Failed Telegram sends don't count: they're retried.
  * A crash is rethrown with its original error, so Cloudflare's logs show the stack.
  * If D1 is down, so neither staleness nor the throttle can be read, the alert goes out anyway. If Telegram refuses it, the next failing run tries again.
* **`GET /health/star-check`** answers 503 when the last successful run is more than 15 minutes old, or there hasn't been one yet, or (`"status": "unknown"`) D1 can't be read. Point an uptime monitor (UptimeRobot, Better Stack) at it, checking every 5 minutes.
* **`GET /health`** only checks that the Worker runs with valid settings. `telegram:setup` uses it.

```sh
bunx wrangler d1 execute DB --remote --command \
  "SELECT scheduled_at, ok, summary FROM star_check_runs ORDER BY id DESC LIMIT 5"
```

## Copying users from the old app (Supabase)

Existing users keep their subscriptions, don't need to send `/start` again, and get neither old stars nor a gap.

All three scripts need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; the copy also needs `GITHUB_TOKEN`. Exports and generated SQL contain chat IDs: never commit them, and delete them when done.

```sh
# 0. Before a full copy: a Supabase backup (pg_dump), kept outside the repo.

# --env is required on every script: production or staging, the D1 database to use.

# 1. Build the SQL. Only reads Supabase, GitHub and (shadow) D1; writes a file to your temp folder.
bun run migrate:copy -- --env=production --mode=shadow   # daily during the shadow run
bun run migrate:copy -- --env=production --mode=full     # the final copy at the switch
bun run migrate:copy -- --env=staging --mode=full        # production data into staging, for the rehearsal

# 2. Apply it (the script prints the exact commands, including step 3's).
bunx wrangler d1 execute DB --remote [--env staging] --file <file>

# 3. Verify: compares every chat, subscription and repository; fails on any difference.
#    --today is the day the copy ran, so a copy just before midnight UTC verifies after it.
bun run migrate:verify -- --env=production --mode=full --today=<day>   # or --mode=shadow; --local for a dry run

# Rollback only: copy D1 back to Supabase (chats, subscriptions, star counts).
bun run migrate:copy-back -- --env=production --dry-run   # see what would change
bun run migrate:copy-back -- --env=production
bun run migrate:verify -- --env=production --mode=shadow
```

The two copy modes:

* **`full`** makes D1 an exact copy of Supabase. Every subscription starts at Supabase's star count, and the last 90 days of star events become daily gains.
* **`shadow`** mirrors chats and subscriptions, but keeps the star counts and gains the Worker tracks itself. New subscriptions start at D1's count. It reads D1's current subscriptions first and writes only what differs (`--local` reads the local D1).

During the final full copy and its verification, pause the Cron Trigger, so the Worker doesn't change star counts between the copy and the check.

The copy back sends each repository's lowest count that any subscriber was last told. The old app keeps one count per repository, so gains that were still due get sent instead of lost; some subscribers may hear about them twice. If any repository still has no Supabase ID after the first step, it stops before changing any subscription.

Repositories that are gone from GitHub, or private, are stored without a node ID and archived. GitHub IDs and Telegram chat IDs are the keys, so running a copy again updates rather than duplicates.

## Environments and deploys

| | Staging | Production |
|---|---|---|
| Worker | `gh-telegram-stars-bot-staging` | `gh-telegram-stars-bot` |
| D1 | `gh-telegram-stars-bot-staging` | `gh-telegram-stars-bot` |
| Bot | a test bot, never the production one | the production bot |
| Deployed | on every push to `main`, after the checks pass | by hand: Actions → **Deploy to production** → Run workflow on `main`, then approve |

Both run `.github/workflows/deploy.yml`: apply D1 migrations, `wrangler deploy` with the commit SHA as the version message, then check that `/health` answers 200 (a missing or invalid setting makes it 503, and fails the deploy). Nobody deploys from a laptop.

* **Settings.** Secrets are set per environment: `bunx wrangler secret put <NAME> --env staging` (leave out `--env` for production).
* **Chat IDs.** They are personal data, and this repo and its Actions logs are public, so `ALLOWED_CHAT_IDS` and `ADMIN_CHAT_ID` aren't in `wrangler.jsonc`. They are secrets of the GitHub environments (masked in logs), passed to `wrangler deploy --var`.
* **Staging only messages allowed chats.** It holds a copy of production data during the rehearsal. With `ENVIRONMENT=staging`, the settings are invalid (and the Worker answers 503) unless `ALLOWED_CHAT_IDS` is set and contains `ADMIN_CHAT_ID`. `ENVIRONMENT` has no default, so a missing one fails too instead of counting as production. Admin alerts name the environment.
* **Staging checks GitHub on the same schedule as production**, so the rehearsal behaves like the real thing. That's about 120 GraphQL points an hour per environment, out of 5,000; give staging its own token anyway.
* **GitHub environments** (Settings → Environments) accept deploys from `main` only; `production` also requires an approval. Each has:
  * secrets `CLOUDFLARE_API_TOKEN`, `ADMIN_CHAT_ID`, and for staging `ALLOWED_CHAT_IDS`
  * variable `WORKER_URL`, for the health check

### Undoing a bad deploy

```sh
bunx wrangler deployments list                       # recent versions, with their commit
bunx wrangler rollback [<version-id>] -m "why"       # production; add --env staging for staging
```

A rollback restores the previous code in seconds. It doesn't touch D1 or secrets, so roll back the code first, then fix data separately. Migrations only add to the schema, so older code keeps working after one.

## CI

GitHub Actions runs on the self-hosted `nexus-runner`, for pull requests from forks too. Its runners are ephemeral: each job gets a fresh pod, so nothing a pull request's job does is left behind for a deploy job. A pull request can change the workflow files, so before approving a run from an outside contributor, check that it doesn't touch `.github/`. The repo requires approval for runs from all outside contributors.

## Migration plan

Tracked in Linear: [Move to Cloudflare Workers + D1](https://linear.app/yvtech/project/move-to-cloudflare-workers-d1-e4176ddbb8e4).

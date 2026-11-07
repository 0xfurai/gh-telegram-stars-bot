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

* A handler that throws is logged as `"Update failed"` with the update ID.
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

Each run stays under the free plan's ~50 subrequests: at most 10 GitHub requests and 20 messages, and the rest waits for the next run. A Telegram rate limit or outage stops sending for that run. The first run after midnight UTC deletes star gains older than 90 days. Every run logs a `"Star check finished"` summary.

Run one locally with `bun run dev:scheduled`, then open `/__scheduled`.

## CI

GitHub Actions runs on the self-hosted `nexus-runner`, for pull requests from forks too. A pull request can change the workflow files, so before approving a run from an outside contributor, check that it doesn't touch `.github/`. The repo requires approval for runs from all outside contributors.

## Migration plan

Tracked in Linear: [Move to Cloudflare Workers + D1](https://linear.app/yvtech/project/move-to-cloudflare-workers-d1-e4176ddbb8e4).

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

* Local values go in `.dev.vars`. It's ignored by git; never commit it.
* Secret names are declared in `wrangler.jsonc` under `secrets.required`. Generated types come from that list, not from your local files, so CI and your machine always agree.
* Wrangler falls back to a root `.env` when `.dev.vars` is missing. Keep a `.dev.vars` file, and don't keep a root `.env` in this repo.

### Dependency install scripts

Bun only runs install scripts for packages listed in `trustedDependencies` in `package.json`: `esbuild` and `workerd`, which download native binaries. After adding a dependency, check that nothing else needs its scripts:

```sh
bun pm untrusted
```

## CI

GitHub Actions runs on the self-hosted `nexus-runner`, for pull requests from forks too. A pull request can change the workflow files, so before approving a run from an outside contributor, check that it doesn't touch `.github/`. The repo requires approval for runs from all outside contributors.

## Migration plan

Tracked in Linear: [Move to Cloudflare Workers + D1](https://linear.app/yvtech/project/move-to-cloudflare-workers-d1-e4176ddbb8e4).

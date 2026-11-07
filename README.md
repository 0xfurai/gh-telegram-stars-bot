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

Requires Node.js 24 (see `.nvmrc`; run `nvm use`).

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev            # local Worker on http://localhost:8787 (GET /health)
npm run dev:scheduled  # same, plus GET /__scheduled to trigger the star check
npm run typecheck
npm run lint           # includes a complexity limit of 10 per function
npm test               # Vitest inside the Workers runtime
npm run typegen        # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

### Local settings and secrets

* Local values go in `.dev.vars`. It's ignored by git; never commit it.
* Secret names are declared in `wrangler.jsonc` under `secrets.required`. Generated types come from that list, not from your local files, so CI and your machine always agree.
* Wrangler falls back to a root `.env` when `.dev.vars` is missing. Keep a `.dev.vars` file, and don't keep a root `.env` in this repo.

### Dependency install scripts

npm only runs install scripts for packages listed in `allowScripts` in `package.json`. After bumping `wrangler`, approve the new `workerd` and `esbuild` versions:

```sh
npm install-scripts approve workerd esbuild
```

## CI

GitHub Actions runs on the self-hosted `nexus-runner`, for pull requests from forks too. A pull request can change the workflow files, so before approving a run from an outside contributor, check that it doesn't touch `.github/`. The repo requires approval for runs from all outside contributors.

## Migration plan

Tracked in Linear: [Move to Cloudflare Workers + D1](https://linear.app/yvtech/project/move-to-cloudflare-workers-d1-e4176ddbb8e4).

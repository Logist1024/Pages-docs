# AGENTS.md

Product-docs site as a single Cloudflare Worker (Hono API + SSR reading pages + static assets). Content lives in D1, rendered per-request; "publish" is just a DB pointer change. Full docs: `README.md` (architecture/deploy), `TESTING.md` (manual acceptance on a deployed instance), `PLAN.md` (design decisions).

## Commands

Toolchain: Node >= 22, pnpm (pinned via `packageManager`). On this machine `pnpm` is not on PATH — use `corepack pnpm ...`. In non-interactive shells pnpm may abort purging `node_modules`; prefix with `$env:CI="true"` (PowerShell) or set `CI=true`.

| Command | What it does |
|---|---|
| `pnpm dev` | Vite + workerd dev server at http://localhost:5173 (D1/KV/R2 are local simulators, no real IDs needed) |
| `pnpm check` | `tsc --noEmit` — the only static gate (no ESLint/Prettier configured) |
| `pnpm test` | Vitest, node environment |
| `pnpm build` | Injects build variables into wrangler.jsonc, then builds Worker + client |
| `pnpm deploy` | Build + `wrangler deploy` (needs wrangler login and real resource IDs) |

- Single test file: `pnpm exec vitest run tree.test.ts`. Note `pnpm test -- <file>` does **not** filter (runs the whole suite).
- Before finishing TypeScript changes: `pnpm check` then `pnpm test` (~3s total). There is no CI — nothing else will catch breakage.

## Critical: wrangler.jsonc is mutated by dev/build

`pnpm dev` and `pnpm build` run `scripts/inject-wrangler.mjs`, which **rewrites `wrangler.jsonc` in place**: JSONC comments are stripped, `kv_namespaces`/`r2_buckets` blocks are deleted unless `KV_NAMESPACE_ID`/`R2_BUCKET_NAME` env vars are set, and `__D1_DATABASE_ID__` gets replaced if `D1_DATABASE_ID` is set. Never commit the injected file — the repo must always keep the `__D1_DATABASE_ID__` placeholder. Restore it (`git checkout -- wrangler.jsonc`) after running dev/build locally.

## Architecture

- Entrypoint: `src/server/index.ts` (Worker `main` in wrangler.jsonc). Route registration happens there; route handlers in `src/server/routes/`.
- URL map: `/docs/*` SSR reading pages, `/api/*` JSON API (session auth except login), `/search`, `/setup` (env self-check), `/f/*` R2 media, everything else → static assets.
- Client has two Vite entries (`vite.config.ts`): `admin.html` → `/admin` SPA, `src/client/read/main.ts` → read-page progressive enhancement. Entry chunks deliberately use **stable unhashed names** (`assets/[name].js`) because SSR HTML references them directly — don't enable hashing for entries.
- Bindings (`src/server/env.ts`): `DB` (D1, required); `PAGE_CACHE` (KV), `MEDIA` (R2), `LOGIN_LIMITER` are optional — server code must gracefully degrade when they're absent (missing KV falls back to Cache API).
- Schema migrations are embedded SQL in `src/server/db/migrations.ts`, auto-applied idempotently on first request via `PRAGMA user_version` (`src/server/db/migrate.ts`). There is no `wrangler d1 migrations apply` step; put schema changes in that file.
- Draft/published split: `documents.content_md` is the working draft; anonymous readers see the `revisions` snapshot pointed to by `current_revision_id`. Publishing = insert revision + update pointer + invalidate cache. FTS5 indexes published snapshots only.
- Requests carrying the `pd-theme` cookie bypass the page cache and render live (cache key excludes theme to avoid cross-theme leaks).

## Setup & conventions

- Local dev needs `cp .dev.vars.example .dev.vars` (gitignored) — without it `/admin` login fails. Format: `name:password` per line or JSON array; first entry is the admin role.
- Docs, code comments, and UI copy are written in Chinese — match that when editing existing files.
- Unit tests cover pure logic only (markdown rendering, tree building, auth parsing, settings, slugify); there are no route/integration tests. Verify end-to-end behavior manually via `pnpm dev`.

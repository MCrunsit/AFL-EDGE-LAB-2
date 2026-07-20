# Working rules for this project

- The user is not an experienced developer — explain root causes clearly. Never say "fixed" without verifying through the actual interface/build.
- Don't rewrite working features. Fix root causes with the smallest complete change.
- Don't invent database tables, columns, or APIs — inspect the actual schema first (read migrations in `supabase/migrations/`, or query the live DB).
- After any fix: state exactly what changed, what was tested, and what's still uncertain.
- Before changing code that touches a suspected bug, explain the root cause and get confirmation before editing.

# Project structure

- Vite + React + TypeScript + Tailwind, Supabase backend (Postgres + Edge Functions).
- `src/pages/` — route-level pages (Match Hub, EV Calculator, Multi Builder, Player Search/Profile, Bet Tracker, Import, Data Freshness Audit, etc.)
- `src/lib/` — data access and domain logic (fixtures, odds normalization/repair, EV engine, player matching, round management, stats sync). No ORM — direct `supabase-js` queries per function.
- `src/components/` — shared UI (panels, badges, comboboxes, error boundary).
- `supabase/migrations/` — append-only SQL migration history (~60 files), the source of truth for actual schema. Don't assume a column/table exists — check here.
- `supabase/functions/` — Edge Functions for ingest/sync (odds-sync, player-props-ingest/sync, bookmaker-odds-ingest, stats backfill/sync).

# Gotchas

- `src/lib/types.ts` `Database` type: every table Row/Insert/Update MUST be wrapped in the local `Simplify<T>` mapped type, and the schema MUST expose `Tables` + `Views` + `Functions` with `Relationships: []` on each entry. Reason: postgrest-js 1.21+ requires each Row to satisfy `Record<string, unknown>`, which TS `interface` types do NOT (no implicit index signature) — only mapped/alias object types do. If any Row/Insert is a raw interface, the WHOLE schema silently degrades and every `.from().select()` infers `never` (hundreds of TS2339 "does not exist on type 'never'" errors). This is invisible at runtime (build passes), only `npm run typecheck` catches it.

# Commands

- `npm run dev` — Vite dev server
- `npm run build` — production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint

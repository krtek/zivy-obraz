# AGENTS.md

## Agent behaviour

- Never commit or push changes without explicitly asking the user first.

## What this repo is

Syncs data from external APIs (Golemio transit, Bakaláři school system) to the [Živý Obraz](https://zivyobraz.eu) digital display platform. Each script runs once and exits; scheduling is handled entirely by GitHub Actions cron.

## Commands

```bash
npm install        # install deps
npm ci             # install locked (CI)
npx prettier --write .  # format
```

There are **no test, lint, or typecheck scripts**. Prettier is the only dev tool.

## Scripts

The only script currently in `src/` is `dashboard-sync.mjs`. The `npm run start:*` shortcuts in `package.json` reference files that do not exist (`traffic-sync.mjs`, `proverb-sync.mjs`, etc.) — run scripts directly with `node src/<file>.mjs`.

## Local testing

Store credentials in `.env.local` (not committed). Load with `set -a && source .env.local && set +a`, then pass as named args (preferred) or positionals:

```bash
set -a && source .env.local && set +a

node src/dashboard-sync.mjs \
  --bakalari-base-url="$BAKALARI_BASE_URL" \
  --bakalari-username="$BAKALARI_USERNAME" \
  --bakalari-password="$BAKALARI_PASSWORD" \
  --golemio-token="$GOLEMIO_API" \
  --stop-id-1="U40Z2P" \
  --stop-id-2="U40Z1P"
```

Positional order (fallback): matches the usage message printed on missing args. `--output` defaults to `dashboard.png`.

## Architecture

- All files are ES Modules (`.mjs`). No TypeScript, no bundler.
- Utilities use a **factory function pattern**: `createUploader(importKey)`, `createBakalariClient(config)`, etc.
- **RxJS 7** pipelines are used in utils — call `.toPromise()` to integrate with `Promise.all`.
- `dashboard-sync.mjs` renders a 480×800 PNG via `canvas` (e-ink optimised: black/white/red only, no grays below `#333`).

## Bakaláři API field name quirks

The real API response shapes differ from what you might expect — verified against the live API:

- **Subjects** (`/api/3/subjects`): key is `SubjectID` (uppercase `ID`), fields are `SubjectName` / `SubjectAbbrev`. IDs have **leading spaces** (e.g. `" 2"`) — always `.trim()` before map lookup.
- **Timetable atoms** (`/api/3/timetable/actual`): lesson order is `HourId`, subject ref is `SubjectId` (lowercase `d`). Days are under `Atoms`, not `Lessons`.
- **Marks** (`/api/3/marks`): grouped by subject under `Subjects`, each with nested `Marks[]`. Mark date is `MarkDate`, value is `MarkText`, description is `Caption`.
- **Homeworks** (`/api/3/homeworks`): subject name available inline at `Subject.Name` / `Subject.Abbrev` — no separate lookup needed.
- Bakaláři auth uses `client_id: 'ANDR'` (Android client workaround for the unofficial API).

## Gotchas

- `dotenv` is listed as a dependency but **not used** — all scripts use `node:util` `parseArgs` for CLI args. `source .env.local` does not export vars; use `set -a && source .env.local && set +a`.
- `timetable-sync.mjs` is referenced in `package.json` scripts but the file **does not exist** — do not rely on `npm run` shortcuts.
- Prettier config references `@trivago/prettier-plugin-sort-imports` options but that plugin is **not installed** — those keys are silently ignored.
- The `npm run copy` script hardcodes a private server IP (`felix@192.168.88.63`) — personal deployment helper only.

## Prettier config (`.prettierrc`)

```
singleQuote: true
printWidth: 120
arrowParens: "avoid"
trailingComma: "none"
```

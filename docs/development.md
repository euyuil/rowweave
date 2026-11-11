# Development

Use Node.js 24.22.1 and npm 11.19.1. The repository uses strict TypeScript and ESM. Run commands from the repository root.

```sh
npm ci
npm run check
npm run build
npm test
```

On Windows, use `npm.cmd` if PowerShell execution policy prevents `npm` from running.

## Standalone service

Set `ROWWEAVE_TOKEN` to a random secret of at least 32 characters, then run `npm run start:server`. Do not commit this value or put it in a URL. `ROWWEAVE_DB` optionally selects the database (default: `.data/prototype.sqlite`), and `ROWWEAVE_PORT` selects the port (default: 4317). The prototype listens only on 127.0.0.1.

Requests use `Authorization: Bearer <token>`:

- `GET /tables/prototype`: field definitions and record count.
- `GET /tables/prototype/records?offset=0&limit=100`: records in a stable order, with at most 500 per page.
- `PATCH /tables/prototype/records`: a JSON array of `{ id, expectedVersion, values }` updates, where `values` maps stable field IDs to strings or null. The entire batch commits or rolls back together. Successful records return their incremented versions. A stale version returns HTTP 409; reload before explicitly resolving the conflict.

Write limits are 2,000 distinct records, 20,000 changed cells, 10,000 UTF-16 code units per text value, and an 8 MiB JSON request body. Duplicate IDs and unknown fields are rejected. Empty strings and nulls remain distinct in storage.

A new database is seeded deterministically with 10,000 rows and 20 text fields. Existing databases retain their schema and data. Node's built-in SQLite driver runs only in the service; the JSON row representation is a prototype choice, not a decision about the future dynamic schema engine.

Tests create and remove isolated temporary databases. No test opens a working database.

## Shared client

`packages/client` exposes an HTTP adapter and a host-independent table model. Its default page size is 100 records, its LRU cache holds at most 12 pages, and it permits at most four page requests in flight. Pending edits are retained separately within the service's batch limits, so scrolling cannot silently discard them.

Saving is explicit. A failed request retains the pending values; version conflicts require deliberate resolution. Discard-and-reload replaces local drafts with the latest stored values. The UI must confirm before invoking that operation when edits are pending. Responses from an older cache generation cannot overwrite a completed save.

## Prototype PR sequence

1. SQLite persistence, paginated HTTP reads, and reproducible tooling.
2. Validated atomic batch writes and optimistic version checks.
3. A bounded client cache and explicit pending-edit/save state.
4. An Electron host and shared React grid with keyboard editing and clipboard support.
5. Packaging, deterministic pressure datasets, and recorded validation.

Each change is based on the preceding PR so it can be reviewed separately. The desktop target for this prototype is Windows; the service tests also run on Linux.

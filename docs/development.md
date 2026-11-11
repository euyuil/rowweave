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

Merge each PR after its checks pass, then start the next dependent change from the updated `main`. The desktop target for this prototype is Windows; the service tests also run on Linux.

## Desktop

Run `npm start` to build the production renderer, install the pinned Electron binary if needed, and open the app. Electron's binary download requires network access on the first run. Use `npm run test:desktop` for the interactive desktop smoke test; it uses a temporary workspace and the native clipboard. Avoid interacting with the app or changing the clipboard during this test.

The Electron host starts the HTTP/SQLite service in a separate utility process. Its narrow preload bridge supplies the connection and host dialogs to the shared React UI; the renderer has no Node.js integration. SQLite never runs in the main or renderer process. The default database is `prototype.sqlite` under Electron's RowWeave user-data directory. `ROWWEAVE_DATA_DIR` selects an isolated workspace and browser profile.

Double-click a cell or press Enter to edit. Enter commits a draft, Escape cancels it, arrow keys move the selection, and Shift+arrows extend it. Copy and paste use plain-text TSV, preserving Unicode, quoted multiline cells, and trailing empty values. Save explicitly with Ctrl+S or **Save changes**. Closing with drafts requires confirmation. On conflict, drafts stay visible for copying before a deliberate discard/reload.

The grid's default TSV parser confuses Unicode code points with UTF-16 offsets; the UI intercepts spreadsheet paste with a bounded parser and tests this behavior. Transitive minimatch and glob dependencies are overridden to patched versions for the grid and packaging tools; dependency upgrades must preserve the audit check, clipboard tests, and packaged-app smoke test.

The automated smoke test covers editing, cancellation, unsaved-close protection (including text still in the editor), keyboard selection, the Windows clipboard, 1,000 × 10 paste/save, a synthetic composition guard, conflict feedback, restart persistence, and service failure. Synthetic composition events do not establish native Chinese IME compatibility.

Native Chinese input was separately exercised on Windows on 2026-11-12 with the installed Pinyin input method: its candidate window appeared, Space selected a Chinese candidate, Escape canceled composition without closing the editor, and Enter confirmed composition without prematurely submitting the cell. Ctrl+S saved the mixed Chinese/Latin value, and a separate read-only SQLite connection verified persistence. This is one-machine verification, not coverage of every IME or platform.

## Windows package

```sh
npm run package:win
npm run test:packaged
```

Build on Windows x64. Each build creates a timestamped directory under `release/`, containing the application folder, a portable ZIP, and its SHA-256 checksum. `release/latest.json` identifies the latest executable and archive, the source revision, and whether the build used uncommitted changes. Extract the entire ZIP, then open `RowWeave.exe`; Node.js is not required on the target machine. This prototype is unsigned and portable; it does not install shortcuts or provide automatic updates.

Packaging stages only compiled runtime files and third-party notices, with no test databases or development dependencies. A verified Electron ZIP in `.artifacts/` can be reused; otherwise the packager downloads the pinned runtime. The packaged smoke test verifies the archive checksum, extracts it to a temporary directory outside the repository, and runs the same edit/save/restart checks from that location with an isolated workspace.

Windows CI packages and tests the app, then publishes the `rowweave-windows-prototype` artifact for 14 days. Download it from the successful [workflow run](https://github.com/euyuil/rowweave/actions), extract the inner application ZIP, and launch the executable. Performance benchmarks are local measurements, not CI timing thresholds.

## Reproducible pressure datasets

Build once before generating data. These commands require new destination files and refuse to overwrite existing workspaces:

```sh
npm run build
npm run dataset -- .artifacts/data-10k/prototype.sqlite 10000 20
npm run dataset -- .artifacts/data-100k/prototype.sqlite 100000 100
```

Set `ROWWEAVE_DATA_DIR` to the containing directory before launching the desktop app to inspect a dataset. Values deterministically include Chinese, emoji, nulls, and long text. Generation constructs one row at a time and uses prepared inserts in a single transaction so an interrupted initialization cannot expose a partially seeded table.

After packaging, run `npm run benchmark`. It creates fresh databases under a timestamped `.artifacts/benchmarks/` directory, performs three instrumented launches per size, and records startup, input-to-frame, 1,000 × 10 paste/save, five scrolling circuits, per-process memory/CPU, display settings, and runtime versions in `results.json`. A separate forced-GC diagnostic follows the timed scrolling workload. It opens test windows and uses the clipboard. Avoid other workloads and clipboard changes during measurement. Generated datasets and raw reports stay out of Git; summarized measurements and their limits belong in [validation.md](validation.md).

For memory attribution, run `npm run benchmark:memory -- <results.json>` using that report's path. It reuses only those generated workspaces and performs five scrolling circuits through the main-process Node inspector, without attaching a renderer debugger or recording HTTP response bodies. It writes `memory-without-renderer-debugger.json` beside the original report. Keep these measurements separate from the Playwright run; summed process working sets include shared pages and are not unique physical RAM usage.

Use `npm run benchmark -- --timings-only` to repeat startup, input, paste, and save measurements without the scrolling workload. A failed memory run can resume completed dataset checkpoints with `--resume`, provided the packaged archive checksum is unchanged.

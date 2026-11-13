# RowWeave TypeScript SDK

`@rowweave/sdk` is the typed HTTP client for RowWeave. It manages tables, fields, records, saved views, queries, and CSV exchange through the same service used by the desktop. It contains no React, Electron, SQLite, or other runtime dependencies.

Use Node.js 24.22.1 or later in the 24.x line and ESM. The SDK uses the runtime's `fetch` and supports an injected fetch implementation as the second argument to `createWorkspaceClient`.

## Install from a build

From the RowWeave repository root, run:

```sh
npm ci
npm run package:sdk
```

The archive is written to `release/sdk/rowweave-sdk-0.1.0.tgz`. Copy it into your application and install it:

```sh
npm install ./rowweave-sdk-0.1.0.tgz
```

This is a locally distributed package, not a claim of publication to npm. Its `private` flag prevents registry publication; [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/) creates the installable archive.

## Connect and work with records

Start the standalone RowWeave service and supply its URL and bearer token through your application's configuration. Never place a real token in source control.

```ts
import { createWorkspaceClient, ApiFailure } from '@rowweave/sdk';

const api = createWorkspaceClient({
  url: process.env.ROWWEAVE_URL!,
  token: process.env.ROWWEAVE_TOKEN!,
});

let table = await api.createTable({ name: 'Projects' });
table = await api.createField(table.id, {
  expectedVersion: table.version,
  name: 'Budget',
  type: 'number',
  defaultValue: 0,
});
const budgetId = table.fields[1]!.id;
const { records } = await api.createRecords(table.id, [{
  values: { [table.primaryFieldId]: 'Launch', [budgetId]: 1200 },
}]);
const record = records[0]!;

try {
  await api.updateRecords(table.id, [{
    id: record.id,
    expectedVersion: record.version,
    values: { [budgetId]: 1500 },
  }]);
} catch (error) {
  if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
    const current = await api.getRecord(table.id, record.id);
    // Compare current values with the user's intended edit before submitting again.
    console.log(current);
  } else throw error;
}
```

Always use IDs returned by the service, including select-option IDs and linked-record IDs. Names are display values and can change. Schema changes, record updates/deletions, and view updates/deletions use the corresponding `expectedVersion`.

## Preview formulas

`api.refreshCalculations()` explicitly updates stored NOW/TODAY results and their dependents across the workspace. It returns the captured minute, changed record count and affected table IDs. This atomic operation advances changed record versions, so reread before editing; it preserves user edit times and history. See [current-time semantics](../../docs/formulas.md#current-time-and-explicit-refresh).

Use `api.previewFormula(tableId, { expectedVersion, formula: { expression, resultType }, fieldId?, recordId? })` to validate a draft and calculate it against one saved record without changing the workspace. Expressions reference field IDs. Include `fieldId` when editing an existing formula; omit `recordId` for the first saved record. An empty table returns `sample: null`; otherwise inspect `sample.value` and `sample.error`. Preview is informational and does not reserve the schema or records. See [formula preview semantics](../../docs/formulas.md#preview-before-saving).

## Query and exchange data

```ts
const page = await api.queryRecords(table.id, {
  limit: 100,
  filter: { conjunction: 'and', conditions: [
    { fieldId: budgetId, operator: 'gte', value: 1000 },
  ] },
  sort: [{ fieldId: budgetId, direction: 'desc' }],
});

const next = await api.queryRecords(table.id, {
  limit: 100,
  offset: 100,
  expectedRevision: page.revision,
  filter: { conjunction: 'and', conditions: [
    { fieldId: budgetId, operator: 'gte', value: 1000 },
  ] },
  sort: [{ fieldId: budgetId, direction: 'desc' }],
});

const csv = await api.exportCsv(table.id);
const input = { expectedVersion: table.version, hasHeader: true, csv };
const preview = await api.previewCsv(table.id, input);
if (preview.validated && preview.invalid === 0 && preview.total > 0) {
  // This explicitly appends new records; it does not update the originals.
  await api.importCsv(table.id, { ...input, mapping: preview.mapping });
}
```

Keep the same query and pass `expectedRevision` for subsequent pages; `DATA_CHANGED` means restart from the first page. `queryView` also accepts `expectedViewVersion`. Query, view-query, CSV preview, and CSV export methods accept an optional `AbortSignal` as their last argument.

Requests time out after 15 seconds, except explicit `refreshCalculations()` which allows 120 seconds. `calculationStatus()` reports automatic scheduling, current progress and the last result/error. Production services recalculate clock formulas at startup and every minute; reads see committed snapshots while writes wait and retain version checks. After an uncertain refresh, inspect status and saved state. `ApiFailure` exposes `code`, `message`, and HTTP `status` for service errors; network/abort errors remain runtime errors. Writes are never retried automatically. After an uncertain create/import result, inspect the service before resubmitting. A validation preview does not reserve a schema or target records.

All request/response interfaces and service limit constants are exported alongside `createWorkspaceClient`. See the [HTTP API reference](https://github.com/euyuil/rowweave/blob/main/docs/http-api.md) and [CSV semantics](https://github.com/euyuil/rowweave/blob/main/docs/data-exchange.md) for operations, values, constraints, and recovery.

`recordHistory` reads bounded change metadata, `recordChange` fetches one before/after snapshot, and `restoreRecord` restores saved writable values into an existing record using its current version. Restoration preserves the UUID, applies current schema constraints, recalculates formulas and creates a new history entry. See [history and retention semantics](https://github.com/euyuil/rowweave/blob/main/docs/record-history.md) before restoring or distributing a workspace backup.

`recordTrash` reads bounded pages of deleted records and their latest deletion IDs. `restoreDeletedRecords` atomically restores an array of `{ id, deletionId, values? }`, preserving UUIDs with newer versions and appending them to the table. Optional writable values repair incompatible historical fields; current schema and linked-target constraints apply. Repeated restores and stale deletion IDs fail with `VERSION_CONFLICT` and are never retried automatically.

`recordBatches` lists transaction receipts affecting a table; `recordBatchChanges` pages through all affected tables' change metadata. Receipts preserve the original change count when a related table is later deleted. Compare `recordCount` with `remainingCount` before treating a batch as complete. `recordWrite` distinguishes record mutations from schema side effects. Receipt history starts at workspace format 18; older individual record history remains readable.

`undoRecordBatch(tableId, batchId)` reverses a reviewed complete saved record operation across all affected tables. Current versions, schema constraints and deletion dependencies apply; one conflict rolls back the entire undo. The result's `batchId` identifies the new transaction and can itself be undone for redo. See [saved undo limits and concurrency rules](https://github.com/euyuil/rowweave/blob/main/docs/record-history.md#undo-a-saved-batch). The SDK never retries uncertain writes automatically.

The repository's package regression installs the actual archive offline into an isolated application, checks its public TypeScript declarations, and runs a schema/record/view/CSV workflow against a real temporary service.

`uploadAttachment(tableId, { filename, mediaType, data })` stores canonical base64 file bytes and returns immutable metadata with an ID and SHA-256. `listAttachments`, `getAttachment`, `downloadAttachment` and `deleteAttachment` share the same authentication and table ownership; download returns `Uint8Array`. Files are bounded to `maxAttachmentBytes` (8 MiB) and included in workspace backups. See [attachment lifecycle and limits](https://github.com/euyuil/rowweave/blob/main/docs/attachments.md). Uploading a file does not itself edit a record. Save its ID in an attachment field to attach it. Only never-attached uploads can be deleted individually; saved files remain available for history and recovery until their owning table is deleted.

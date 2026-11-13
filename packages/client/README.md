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

Requests time out after 15 seconds. `ApiFailure` exposes `code`, `message`, and HTTP `status` for service errors; network/abort errors remain runtime errors. Writes are never retried automatically. After an uncertain create/import result, inspect the service before resubmitting. A validation preview does not reserve a schema or target records.

All request/response interfaces and service limit constants are exported alongside `createWorkspaceClient`. See the [HTTP API reference](https://github.com/euyuil/rowweave/blob/main/docs/http-api.md) and [CSV semantics](https://github.com/euyuil/rowweave/blob/main/docs/data-exchange.md) for operations, values, constraints, and recovery.

`recordHistory` reads bounded change metadata, `recordChange` fetches one before/after snapshot, and `restoreRecord` restores saved writable values into an existing record using its current version. Restoration preserves the UUID, applies current schema constraints, recalculates formulas and creates a new history entry. See [history and retention semantics](https://github.com/euyuil/rowweave/blob/main/docs/record-history.md) before restoring or distributing a workspace backup.

`recordTrash` reads bounded pages of deleted records and their latest deletion IDs. `restoreDeletedRecords` atomically restores an array of `{ id, deletionId, values? }`, preserving UUIDs with newer versions and appending them to the table. Optional writable values repair incompatible historical fields; current schema and linked-target constraints apply. Repeated restores and stale deletion IDs fail with `VERSION_CONFLICT` and are never retried automatically.

`recordBatches` lists transaction receipts affecting a table; `recordBatchChanges` pages through all affected tables' change metadata. Receipts preserve the original change count when a related table is later deleted. Compare `recordCount` with `remainingCount` before treating a batch as complete. `recordWrite` distinguishes record mutations from schema side effects. Receipt history starts at workspace format 18; older individual record history remains readable.

The repository's package regression installs the actual archive offline into an isolated application, checks its public TypeScript declarations, and runs a schema/record/view/CSV workflow against a real temporary service.

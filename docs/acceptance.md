# Product candidate acceptance

This walkthrough is for the first usable RowWeave product described in [completion-plan.md](completion-plan.md). Automated checks establish the evidence below; the owner still decides whether the complete workflow meets their needs. This is a private evaluation build, not a formal public release.

## Candidate and verification

The Windows ZIP, checksum and exact source revision are identified by `release/latest.json`. Extract the whole ZIP and start `RowWeave.exe`; the desktop includes its runtime. Use a fresh workspace for acceptance. To isolate it from an existing profile, set `ROWWEAVE_DATA_DIR` to a new directory before launch. The default database filename `prototype.sqlite` is retained for compatibility; fresh workspaces contain no sample records.

Source/service setup is in [development.md](development.md) and [service.md](service.md). The SDK, CLI, MCP and Harness archives are built with the corresponding `package:*` scripts; [agent Skills](agent-skills.md) are installed from the repository. No npm publication or AI account is required for RowWeave itself.

The delivered 2026-11-12 candidate is `release/0.1.0-20261112T144603147Z/rowweave-0.1.0-win32-x64.zip`, built cleanly from `5091d04e4b2f77f9595225abd414513422b9f813` (merged through PR #38). SHA-256: `91d0543a2c020031f07dbb49cf390a9e047c14bc5aa37e039bbddb3145c9167f`. Windows and Linux CI passed that revision, including the extracted-package cross-interface workflow. Local Node checks passed 119 tests; the IPv6 loopback test could not bind in the local environment and passed in CI. The final documentation-only PR does not change this binary.

| Scenario | Automated evidence |
| --- | --- |
| Tables, typed schema, records and restart persistence | Workspace/schema desktop workflows; SQLite schema/typed-record tests; migrations from earlier formats. |
| Conversion preview, failed-apply rollback and stale schema | Field-conversion and HTTP-schema tests; concurrent desktop conversion workflow. |
| Saved views, query identity and retained conflicting drafts | View/query/index tests, client query-model tests and desktop view/grid workflows. |
| Relations, lookup values and deletion dependencies | SQLite relation/lookup tests and desktop record-picker/lookup workflows. |
| Clipboard batches and CSV validation/round trips | Client paste/undo tests, packaged smoke test, SQLite/HTTP CSV tests and desktop CSV workflow. |
| One service used by all interfaces | `test:interfaces`: extracted desktop ZIP, SDK bundle, CLI subprocess, MCP protocol client and Harness UI exchange the same versioned record. Official Harness CLI/Web-host installation was also exercised separately. |
| Outages, authentication, backups and recovery | Standalone process and network tests, backup/restore tests, desktop connection workflow and package extraction/restart checks. |

Run `npm test` for Node regressions, `npm run test:desktop` for source desktop checks, and `npm run test:harness` for host integration. After `npm run package:win`, run `npm run test:packaged` and `npm run test:interfaces`. Windows and Linux CI run the configured checks; native interaction and reference-machine performance are separate evidence.

See [product-performance.md](product-performance.md) for exact production artifacts, methods, results and limits. Its native-interaction section records successful Pinyin and Excel clipboard checks, the discovered/fixed multiline-copy defect and Windows line-ending normalization. Synthetic composition or DOM clipboard events alone are not native verification.

## Owner walkthrough

1. **Model your own work.** Create `Projects` and `Tasks`. Give Projects a currency-formatted Budget, a date, and a single-select Status with your own options. Add a checkbox and multiline Notes to Tasks. Rename/reorder fields and change an option label; existing data must remain intact.
2. **Edit and persist.** Create, duplicate and delete records. Use Enter, Tab, arrows, selection, Undo/Redo and Ctrl+S. Enter Chinese through your normal IME, including canceling a composition. Close and reopen the app; saved schema, records and views must remain.
3. **Check an unsafe conversion.** Add a text Code field with `10` and `not a number`. Preview a conversion to Number: the invalid record must be identified and application must leave stored data unchanged. Correct it to `20`, then preview/apply successfully.
4. **Keep useful views.** Save a view with more than one filter and sort key. Hide, reorder and resize columns, search, and reopen the view. Edit a sorted record and confirm that the intended record changes. Make a conflicting update through a second client; the first client's unsaved draft must remain available for deliberate resolution.
5. **Connect records.** Add a Tasks → Projects relation and a lookup of Project Budget. Select a project by its name and open its details. Rename the project and update its budget; refresh Tasks and verify the label and lookup. Try deleting a referenced record/field and check the stated dependency policy.
6. **Exchange real data.** Copy/paste a rectangle from your spreadsheet, including Chinese, emoji, quoted text, blank cells and multiline text. Copy it back and compare. Import a mapped UTF-8 CSV, export the current view, and reimport supported values. Try an invalid typed value: the batch must fail without partial stored changes. Use an isolated pressure workspace for the optional 1,000 × 10 paste check.
7. **Connect an agent or application.** Follow the [MCP](mcp.md), [CLI](../apps/cli/README.md), [SDK](../packages/client/README.md), or [Harness](harness.md) guide. Point it at the same service as the desktop. Discover schema, add a record, query a saved view, then verify the change in the other interface. Use current versions for writes.
8. **Recover deliberately.** With an isolated remote service, stop it during editing and confirm the draft/error behavior. Restart it and inspect stored data before repeating a write with an uncertain outcome. Create an online backup, restore it to a new path, and connect to the restored workspace using the [backup guide](backup.md).

Record the candidate checksum, OS/display refresh rate/input method/spreadsheet versions, the failing step if any, expected versus observed behavior, and a screenshot or minimal sample without private data. Include scrolling on your normal display: the earlier full reference run used 60 Hz, while the final-binary rerun encountered a 32 Hz desktop session and cannot establish a 60 Hz frame-interval result. The product is ready for owner acceptance only after the required implementation and verification items in the completion plan are complete; this document does not accept it on the owner's behalf.

## Current boundaries

- Windows x64 portable desktop; one workspace per service. The bearer token grants full workspace access. This is not enterprise authorization or live collaborative editing.
- Explicit saves, version conflicts and refreshes; no offline replication or automatic retry of writes.
- Supported field types, relations, lookups and grid views; no general formula engine, attachments, dashboards, additional view families or built-in AI runtime.
- Saved scalar filter/sort indexes cover the documented performance workloads. Relation/lookup/array searches remain supported scan paths; arbitrary queries are not covered by those timing claims.
- Spreadsheet formats and input methods vary. Use the CSV guide's empty-value, date/time and formula-like-text semantics, and include your normal applications in final manual acceptance.

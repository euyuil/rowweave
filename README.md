# RowWeave

English | [简体中文](README.zh-CN.md)

**Tables that fit your work. Data your apps and agents can use.**

Build a project tracker, customer list, or inventory without writing a schema in code. RowWeave combines customizable tables, a responsive desktop grid, and open interfaces for the software you already use.

- **Make the structure your own.** Create tables with text, numbers, dates, checkboxes, and choices. Calculate values with formulas, keep related records connected from either table, and bring their values or totals into your view with lookups.
- **Find the view that matters.** Switch between focused grids, status boards, calendars, Gantt timelines, and galleries with image covers. Adjust schedules, browse cards, and save filters and layouts for each workflow. See counts, totals, and averages across your whole view.
- **Move through work quickly.** Edit with the keyboard, paste a block of cells, and undo or redo your automatically saved edits. Bring data in and out with CSV.
- **Keep files with their records.** Attach documents and other files, reuse uploads, and recover saved attachments with record history.
- **Connect your tools.** Use the HTTP API, TypeScript SDK, CLI, MCP, or agent Skills. A DeepSeek Harness panel provides the same table workspace inside your host.
- **Choose where your data lives.** Start locally on Windows or connect to a service you operate. People and software share validation and version checks.

## Try RowWeave

Windows evaluation builds are available from successful [CI runs](https://github.com/euyuil/rowweave/actions). Download **rowweave-windows**, extract the application ZIP, and open `rowweave.exe`. No separate Node.js installation is needed for the desktop. Check the [candidate report](docs/final-candidate-validation.md) for completed and pending verification.

Start with an empty workspace: create a table, add fields, and enter or import records. Cell edits save when editing finishes; record details save after a short typing pause. Other clients' changes synchronize automatically. [Live editing](docs/live-editing.md) explains conflict protection and session undo/redo.

When coming from an earlier workspace format, use a separate directory for a new local workspace. See [workspace versions](docs/backup.md#changing-versions).

[Desktop connections](docs/connections.md) · [CSV guide](docs/data-exchange.md) · [Acceptance walkthrough](docs/acceptance.md)

## Connect your software

[Run a service](docs/service.md) · [HTTP API reference](docs/http-api.md) · [OpenAPI specification](docs/openapi.yaml) · [TypeScript SDK](packages/client/README.md) · [CLI](apps/cli/README.md) · [MCP](docs/mcp.md) · [Agent Skills](docs/agent-skills.md) · [Harness](docs/harness.md)

This release focuses on flexible structured tables and reliable data operations. Custom forms, pivot tables, dashboards, map views and automation are not implemented in this scope. Built-in AI chat, enterprise permissions and real-time collaborative editing are also outside its scope.

For measured performance and current limits, see the [candidate report](docs/final-candidate-validation.md). For source builds and architecture, see [development](docs/development.md) and [design](docs/design.md). Share your workflows and feedback in [Issues](https://github.com/euyuil/rowweave/issues).

# RowWeave

English | [简体中文](README.zh-CN.md)

**Tables that fit your work. Data your apps and agents can use.**

Build a project tracker, customer list, or inventory without writing a schema in code. RowWeave combines customizable tables, a responsive desktop grid, and open interfaces for the software you already use.

- **Make the structure your own.** Create tables with text, numbers, dates, checkboxes, and choices. Calculate values with formulas, link related records, and bring their values into your view with lookups.
- **Find the view that matters.** Switch between focused grids and status boards. Save filters and layouts, move cards between groups, and see counts, totals, and averages across your whole view.
- **Move through work quickly.** Edit with the keyboard, paste a block of cells, undo drafts, and save changes together. Bring data in and out with CSV.
- **Connect your tools.** Use the HTTP API, TypeScript SDK, CLI, MCP, or agent Skills. A DeepSeek Harness panel provides the same table workspace inside your host.
- **Choose where your data lives.** Start locally on Windows or connect to a service you operate. People and software share validation and version checks.

## Try RowWeave

The first product candidate is ready for evaluation. Download **rowweave-windows** from a successful [CI run](https://github.com/euyuil/rowweave/actions), extract the application ZIP, and open `rowweave.exe`. No separate Node.js installation is needed for the desktop.

Start with an empty workspace: create a table, add fields, and enter or import records. Save explicitly with **Save changes** or **Ctrl+S**.

[Desktop connections](docs/connections.md) · [CSV guide](docs/data-exchange.md) · [Acceptance walkthrough](docs/acceptance.md)

## Connect your software

[Run a service](docs/service.md) · [TypeScript SDK](packages/client/README.md) · [CLI](apps/cli/README.md) · [MCP](docs/mcp.md) · [Agent Skills](docs/agent-skills.md) · [Harness](docs/harness.md)

This release focuses on flexible structured tables and reliable data operations. Built-in AI chat, enterprise permissions, and real-time collaborative editing remain outside its scope.

For measured performance and current limits, see the [verification report](docs/product-performance.md). For source builds and architecture, see [development](docs/development.md) and [design](docs/design.md). Share your workflows and feedback in [Issues](https://github.com/euyuil/rowweave/issues).

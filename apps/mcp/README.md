# RowWeave MCP

Connect an MCP host to a running RowWeave service through stdio. This private package bundles its runtime dependencies and third-party license notices; it requires Node.js 24.22.1 or newer in the 24.x line.

Install the supplied archive with `npm install /absolute/path/rowweave-mcp-0.1.0.tgz`. Configure the host to run `node /absolute/path/node_modules/@rowweave/mcp/dist/rowweave-mcp.js`, with `ROWWEAVE_URL` and `ROWWEAVE_TOKEN` in its environment. The executable takes no arguments. Keep credentials out of command arguments and source control.

The server provides tools for tables, fields, records, recovery, attachments, views, CSV and calculation preview/refresh/status, plus current schema resources. It uses the same validation and version checks as the desktop. Read `rowweave://usage` and the current schema before writing. JSON results are text content; CSV export returns CSV text. Writes are never retried automatically.

See the [configuration and protocol guide](https://github.com/euyuil/rowweave/blob/main/docs/mcp.md) for tool arguments, limits and failure recovery. No database, HTTP service or AI runtime is bundled in this adapter.

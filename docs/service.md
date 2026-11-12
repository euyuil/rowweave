# Operating the RowWeave service

The standalone service owns one SQLite workspace and serves the same schemas, records, views, queries, and CSV operations as the desktop. The SDK, CLI, and other clients connect over authenticated HTTP. Run one service process per database; point every client at that service instead of opening the database in multiple hosts.

## Start from source

Use Node.js 24.22.1 and npm 11.19.1. From the repository root:

```sh
npm ci
npm run build
```

Set the environment variables below in the process that starts the service, then run `npm run start:server`. For a supervisor, use `node /absolute/path/to/rowweave/dist/apps/server/src/cli.js` directly. Use absolute database paths so a working-directory change cannot select another workspace. New databases start empty; no demo data is inserted.

| Variable | Meaning | Default |
| --- | --- | --- |
| `ROWWEAVE_TOKEN` | Required bearer secret: at least 32 printable ASCII characters, without spaces. Generate it randomly and pass it through your process's environment/secret configuration. | None |
| `ROWWEAVE_DB` | Database path. Parent directories are created as needed. | `.data/prototype.sqlite` relative to the working directory; the historical filename is retained for existing installations. |
| `ROWWEAVE_PORT` | Listen port, 0–65535. Port 0 selects an ephemeral port for tests. | `4317` |
| `ROWWEAVE_HOST` | Explicit IPv4 or IPv6 bind address, without brackets. | `127.0.0.1` |
| `ROWWEAVE_ALLOWED_HOSTS` | Comma-separated HTTP Host authorities, including non-default ports, with no schemes, paths, or wildcards. Required for binding outside `127.0.0.1` / `::1`. | The actual loopback bind address and port. |
| `ROWWEAVE_ALLOWED_ORIGINS` | Comma-separated exact HTTP(S) browser origins, or `null` for the desktop file renderer. No paths, trailing slash, or wildcards. Set an empty value to disable browser origins. | `null` on loopback; no allowed browser origins on other bind addresses. |

For example, an independently operated local service can use port 4317 and an absolute database path with the default loopback binding. Set `ROWWEAVE_URL=http://127.0.0.1:4317` and the same `ROWWEAVE_TOKEN` in the [CLI](../apps/cli/README.md) process. `rowweave tables list` verifies authentication and the workspace connection. The startup message contains the listening address, never the token.

Keep the secret outside source files, URLs, command arguments, and logs. Anyone with the token has full access to this workspace; this release does not implement accounts or per-user permissions. Rotate a token by restarting the service with a new value and updating clients. RowWeave does not read `.env` automatically.

## Remote access

Example configuration for a service listening on a private interface:

```text
ROWWEAVE_HOST=192.168.1.20
ROWWEAVE_PORT=4317
ROWWEAVE_ALLOWED_HOSTS=192.168.1.20:4317
ROWWEAVE_ALLOWED_ORIGINS=null,https://workspace.example.com
ROWWEAVE_DB=/absolute/path/to/workspace.sqlite
```

Supply `ROWWEAVE_TOKEN` separately. Use your actual interface address, client-facing authority, origins, and filesystem path. A `0.0.0.0` or `::` bind address listens on all corresponding interfaces; it is not the address to enter in a client. Listing a Host does not bind another interface or change DNS.

For encrypted remote access, put a TLS reverse proxy in front of the HTTP service and connect clients through its HTTPS address. Bind the backend to loopback when the proxy runs on the same machine. For example, allow `tables.example.com` and configure the proxy to forward `Host: tables.example.com`. If the proxy forwards `Host: 127.0.0.1:4317` instead, allow that exact backend authority. RowWeave checks the received Host and does not trust `Forwarded` or `X-Forwarded-Host`. Restrict access to the backend port using the deployment's network rules. Direct HTTP carries the bearer token without transport encryption.

The proxy must forward Authorization, Origin, Content-Type, and OPTIONS requests without injecting credentials. Preserve request paths, or strip a configured URL prefix before forwarding. Allow the documented 64 MiB JSON limit on CSV import/preview requests, 8 MiB on other JSON requests, and 32 MiB CSV responses. Do not configure automatic retries of mutations. TLS, service supervision, and network access rules belong to the deployment; RowWeave does not provision them.

## Host, origin, and authentication behavior

- Host matching is exact and case-insensitive; ports are part of the authority. A supplied allowlist replaces the default, so include every direct/proxy address clients actually use. IPv6 authorities use brackets, for example `[::1]:4317`.
- Browser origins are exact, including scheme and non-default port. `https://workspace.example.com` does not permit its subdomains, HTTP counterpart, or another port.
- The desktop's file renderer sends `Origin: null`. This value also represents other opaque browser origins; it is not a desktop identity. Bearer authentication is still required for every data operation.
- CLI/SDK/server clients normally send no Origin. They still require an allowed Host and the bearer token; CORS is a browser rule, not authorization.
- Allowed browser preflights receive 204 without a token. Requested methods are GET, POST, PATCH, and DELETE; requested headers are Authorization and Content-Type. The actual request still requires authentication. Invalid hosts, origins, or preflights return 403; a missing/incorrect token returns 401.
- CORS response headers accompany errors for an allowed origin, so clients can display authentication or validation failures. Cookies and wildcard origins are not used.

These preflight semantics follow the [Fetch CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol). See the [HTTP API](http-api.md) for request bodies, bounded operations, revisions, and error recovery. A timed-out write may already have committed; inspect current data before repeating it.

## Lifecycle and storage

Keep the process running while clients use the workspace. SIGINT/SIGTERM closes the listener, waits for active requests, and closes SQLite. Windows terminal Ctrl+C requests normal shutdown; force termination is not a clean-stop confirmation. Restarting the service preserves stable IDs, schemas, values, record versions, and saved views. If a port is already occupied or configuration is invalid, startup fails rather than selecting another port.

SQLite uses WAL transactions and migrations. Opening an older supported database upgrades it transactionally; newer unsupported formats are rejected. Keep an upgrade backup. Never copy only the main SQLite file while the service is running: recent committed data can still be in its WAL. A supported backup/restore workflow and desktop connection settings are subsequent delivery items in the [completion plan](completion-plan.md).

Network regression tests exercise real IPv4/IPv6 sockets, exact Host/origin checks, authenticated operations, and preflights. A separate test starts the actual standalone process with environment settings and verifies schema, records, and views after restarting it. Tests use temporary databases, never a user's workspace.

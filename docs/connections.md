# Desktop workspace connections

RowWeave can open the workspace on your device or connect to an independently operated RowWeave service. Use **Connection** in the top-right corner to choose. Each workspace keeps its own tables and records; changing a connection does not copy data between them.

## On this device

Choose **On this device**, then **Connect and save**. RowWeave starts its bundled data service in a separate process and opens the existing local workspace. The first launch uses this mode automatically. Closing RowWeave stops that bundled service.

The local database is `prototype.sqlite` in the RowWeave user-data directory. `ROWWEAVE_DATA_DIR` selects another profile and local workspace directory. The historical filename is retained for existing users; new workspaces start empty. See [backup and restore](backup.md) to move or recover a workspace without mixing database journal files.

## Independent service

1. Start a service using the [service operations guide](service.md). Keep it running independently of the desktop.
2. Save or discard any edits in the current workspace. Open **Connection** and choose **Independent service**.
3. Enter the HTTP(S) service URL and its access token. For a service on this computer, the usual URL is `http://127.0.0.1:4317`. For remote access, use the service's HTTPS address.
4. Select **Connect and save**. RowWeave reads the workspace to verify access before saving the connection and switching the interface.

The configured service must allow the desktop's `null` origin, for example `ROWWEAVE_ALLOWED_ORIGINS=null`. Remote binding also requires an explicit Host allowlist. URLs may contain a proxy path prefix, but must not contain credentials, query parameters, or a fragment. Enter the final service URL rather than a redirect. The token requires at least 32 printable ASCII characters without spaces, matching the service configuration.

The header shows **Remote workspace** after switching. No bundled database service runs in this mode. Closing the desktop or changing back to local mode does not stop the independently operated service. The last saved connection is reopened on the next launch.

For the CLI, SDK, MCP, and desktop to share a workspace, connect them to the same independently operated service. Use the same URL/token configuration rather than launching several services against one SQLite file. The desktop's bundled service uses an ephemeral port/token and is managed by the application.

## Saved credentials

Connection settings live in `connection.json` inside the selected desktop profile. The remote URL is readable; its token is encrypted using Electron's asynchronous [safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage). On the supported Windows desktop, this uses OS protection tied to the Windows account. It does not protect against other applications running as that same user, and the profile is not a portable credential bundle for another account.

The password field masks the token. RowWeave does not put it in localStorage, URLs, or application logs. If encryption or saving fails, the previous connection and settings remain active; there is no plaintext-storage fallback. Choosing local mode replaces the saved remote credentials with the local preference.

## Failures and recovery

- **Unsaved edits or a save in progress:** finish the save or use the existing discard workflow before changing connections. Opening connection settings does not discard drafts.
- **Wrong token, disallowed origin, unreachable service, or encryption failure:** the dialog reports the failure and keeps the current workspace and saved settings. Correct the inputs and explicitly connect again; writes are not retried.
- **Remote service unavailable at startup:** RowWeave displays a connection error with **Retry**. Restart the service, then retry, or use **Connection** to choose another workspace. It does not open an empty local workspace as a substitute.
- **A connection fails while saving records:** drafts remain visible. Restore the service connection and inspect/refresh current records before deciding whether to save again; a lost response may have followed a successful commit. Version checks still protect against a stale update.
- **Unreadable settings or an undecryptable token:** a recovery screen lets you choose local mode or re-enter the remote URL/token. The old settings are replaced only after a successful connection save.
- **The bundled local service stops:** saved data remains in the local database. Keep/copy any unsaved values before closing and reopening RowWeave, or reconnect after resolving drafts. The app does not silently start another workspace.

Connection changes are completed before the window can close. The renderer remains sandboxed with Node integration disabled. HTTP(S) requests from the renderer are restricted to the active service's origin; connection testing and credential storage use narrow main-process operations, while all database work remains in a separate service.

Automated offscreen tests exercise local/remote switching, real Windows encrypted credential persistence across restarts, wrong tokens/origins, encryption failure, remote outages with retained drafts, unavailable-service startup, corrupted settings, blocked foreign-origin requests, and process ownership. The same workflow runs against the extracted portable package in Windows CI. This does not replace final native input and human acceptance checks.

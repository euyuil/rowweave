# RowWeave in DeepSeek Harness

The adapter adds a **RowWeave** sidebar entry to the Harness Web profile. It uses the same workspace, schema, typed grid, views, relations, record forms, and CSV workflows as the desktop. All reads and mutations go through the shared HTTP client to your independently operated RowWeave service. Harness does not open the database, and the adapter adds no AI runtime.

## Install

The supported baseline is **DeepSeek Harness 0.2.2-rc.2**, Web profile, with its layout, sidebar, slots, and UI renderer plugins enabled. The archive declares this exact Harness version. Other versions and the Harness Desktop carrier are not verified targets.

From the RowWeave repository, use the pinned [development toolchain](development.md):

```sh
npm ci
npm run package:harness
```

This creates `release/harness/rowweave-harness-0.1.0.tgz`. Linux CI also uploads the `rowweave-harness` artifact. The package is private and is not published to npm. Its browser runtime is bundled; React and React DOM come from Harness's shared module table. Third-party notices are included in the archive.

With the supported `dsh` and its required package manager available, install into the Web profile and restart it:

```sh
dsh --version
dsh plugin --profile web add /absolute/path/rowweave-harness-0.1.0.tgz
dsh --profile web --port 8080
```

Use your actual absolute archive path. Profile package operations select the package's `dsh.bundle.patch`; it inserts the `rowweave-tables` entry. Keep existing profile bundles and settings. The Harness **Plugins** panel can disable or remove this bundle. Save RowWeave edits first: disabling a plugin disposes its UI and cannot be vetoed through the supported slot API.

## Connect

Start a [RowWeave service](service.md) before opening the panel. Add the exact Harness origin to `ROWWEAVE_ALLOWED_ORIGINS`, for example `http://localhost:8080`. An origin uses the browser's scheme, hostname, and port, without a trailing slash. `localhost` and `127.0.0.1` are different origins. Include `null` as well if the standalone desktop should use this service. Restart the service after changing its environment.

Open **RowWeave** and enter the service URL and bearer token. A connection is checked before replacing the current one. Use **Connection** to change it after saving or discarding edits. Credentials remain in page memory, including across normal panel switches; they are not written to local storage. Reloading the page or disabling the plugin requires reconnection. The token grants full workspace access under the service's existing authorization model.

For a remotely hosted Harness page, `127.0.0.1` identifies the browser user's computer, not the Harness server. Choose a service address reachable from that browser. An HTTPS Harness page needs an HTTPS service endpoint to avoid mixed-content blocking. Configure TLS and exact Host/origin allowlists as described in the service guide. No proxy, database process, or credentials are provisioned by the plugin.

## Editing and files

Save explicitly with **Save changes** or Ctrl+S. Switching to another Harness panel while edits are pending returns to RowWeave with a save/discard message. Normal page unload requests the browser's unsaved-change warning; whether it is displayed depends on the browser. Plugin removal and a host shutdown cannot guarantee draft recovery.

**Import CSV** reads a selected UTF-8 file in the browser and previews/validates it through the service. **Export CSV** starts a browser download. The panel reports that the download started, rather than claiming the file was written. Confirm completion in the browser's downloads. See [data exchange](data-exchange.md) for types, size limits, and spreadsheet semantics.

Connection errors identify the service URL/token, origin policy, or HTTPS configuration as things to check. An unavailable service leaves the shared workspace's drafts intact. A timed-out write may already have committed; inspect current data before repeating it. This is the same recovery model as the desktop, SDK, CLI, and MCP.

## Integration and verification

The host entry is a browser-only plugin's no-op Node entry. The client registers the keyed `main` panel and `sidebar.panellist` contribution through `ctx.slots.inject`, so contributions follow declaration ownership and disposal. It uses `ctx.layout.panelInfo` and `selectPanel` for the unsaved-edit guard. Shared UI receives only callbacks for confirmation, dirty state, and browser downloads. The plugin creates Glide's required portal only when the host has none, and removes only the portal it owns.

The implementation follows the official [slots contract](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/subsystems/slots.md), [client module contract](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/subsystems/client-modules.md), and [profile launcher](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/cli/README.md). Runtime APIs are pinned to the matching published packages, not copied into RowWeave.

`npm run test:harness` packs and installs the archive offline outside the repository, then runs an isolated offscreen browser with the official module loader, Cordis/slot registry, UI renderer, and layout controller against a real temporary SQLite service. It verifies authentication, table/typed-field creation, editing, unsaved navigation, clean remount, CSV import and completed browser download, failed connection replacement, declaration renewal, and module disposal/reload with both owned and pre-existing portals. This fixture supplies a small host frame and an absent conversation binding; it does not run an AI session or claim native IME verification. Windows CI runs this test and uploads its workspace screenshot.

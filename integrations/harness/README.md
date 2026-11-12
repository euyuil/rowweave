# RowWeave for DeepSeek Harness

Open your structured tables in the Harness sidebar. This plugin reuses RowWeave's workspace UI and HTTP client against an independently running RowWeave service; it does not start a database or an AI runtime.

The private package targets Harness **0.2.2-rc.2**, Web profile. Build with `npm run package:harness` from the RowWeave repository. The archive contains the browser bundle, host entry, bundle patch, and third-party notices, with no runtime npm dependencies. Install the archive into your Harness profile using `dsh plugin --profile web add /absolute/path/rowweave-harness-0.1.0.tgz`, then restart that profile.

In **RowWeave**, enter your service URL and token. The service must allow the exact Harness browser origin. Credentials stay in page memory; reconnect after a page reload. Save or discard pending edits before leaving the panel, and save before disabling the plugin. CSV export starts a browser download; check your downloads for completion.

See the [installation and operation guide](https://github.com/euyuil/rowweave/blob/main/docs/harness.md) for setup, supported host APIs, troubleshooting, and verification boundaries.

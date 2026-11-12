# Repository Guidelines

These guidelines define the contribution workflow and implementation boundaries for RowWeave. The project design is documented in `docs/design.md`; the initial product delivery scope is in `docs/completion-plan.md`, extended by the current scope and acceptance criteria in `docs/refinement-plan.md`.

## Project Structure and Boundaries

- Use **RowWeave** as the brand and product display name in prose, UI, and display metadata. Use `rowweave` as the codename for repository/package/command names, executable and artifact filenames, protocol identifiers, and process identifiers. Keep display names separate from technical names: `RowWeave` in a window title or `ProductName`, but `rowweave.exe`, `rowweave-win32-x64`, and `rowweave-data-service` in technical contexts. Follow interface casing conventions such as `ROWWEAVE_*` for environment variables.
- Platform presentation conventions may use the brand for Windows installation/user-data directories and shortcuts (`Program Files\RowWeave\rowweave.exe`, `%APPDATA%\RowWeave`, `RowWeave.lnk`), names of services registered with Windows Service Control Manager, and macOS application bundles (`RowWeave.app`). Executables inside them still use the codename. Application-managed processes and services, including Electron utility processes, use codename identifiers. Linux desktop entries use `rowweave.desktop` with `Name=RowWeave`. These naming examples do not expand the supported platform scope. Preserve user-provided filenames and exact historical artifact references.
- Follow `docs/development.md` for working commands and the completion/refinement plans for delivery scope. Create directories only when they are needed by the implementation. Do not add unrelated features or refactoring while completing that scope.
- `apps/desktop/` is the Electron entry point. `apps/server/` provides the standalone TypeScript/Node.js service and shared HTTP server.
- `packages/ui/`, `packages/client/`, and `packages/contracts/` hold shared React UI, client models and caching, and API schemas and types. Shared code must not import Electron or Harness runtime APIs; inject host-specific capabilities through narrow interfaces or callbacks.
- `packages/core/` owns business rules. `packages/storage-sqlite/` owns database access and migrations. Keep both independent of desktop and plugin hosts, and keep database work out of Electron's main and renderer threads.
- `integrations/harness/` and `skills/` provide the host adapter and agent usage guidance defined in the delivery scope. Keep them thin consumers of the shared UI/client/service. Do not add an internal AI runtime.
- Treat build output, test databases, and generated pressure-test datasets as generated artifacts, not source files.

## Build, Test, and Run

- Once tooling is introduced, use the runtime versions, package manager, lockfile, and scripts declared by this repository. Keep lockfiles in version control and use reproducible installs for verification and CI.
- Run commands from the repository root unless a package documents a different working directory. Use commands appropriate to the current shell; do not assume PowerShell or Windows.
- Document working install, type-check, build, test, and run commands when adding the corresponding tooling.
- Run the checks relevant to a change. State which checks passed and identify any checks that could not run. Distinguish compilation, automated testing, GUI verification, and performance measurements.

## Coding Style

- Use strict TypeScript and ESM. Use two-space indentation, single quotes, semicolons, camelCase for functions and variables, and PascalCase for types and classes.
- In TypeScript modules emitted as Node.js ESM, use `.js` extensions in relative imports. For bundled React code, follow the package's configured module resolution and lint rules.
- Keep user-facing wording and test descriptions consistent with their target language and existing conventions.
- Write documentation and code comments in English by default. Use Chinese proper nouns where English cannot convey them accurately. Write localized documentation in its target language. Keep `README.md` in English and `README.zh-CN.md` in Simplified Chinese, with their user-facing content aligned.
- Keep table, field, and record identities separate from display names and row or column positions. Perform authoritative validation and data mutations in the service layer.
- Call the record-label field the **primary display field** in product copy and documentation. A record's immutable UUID is its primary key; a column has a separate stable field UUID. Selecting a display field does not imply uniqueness or a required value.
- Validate untrusted input at real system boundaries and rely on checked types and invariants internally. Avoid speculative abstractions, redundant checks, silent fallbacks, and retries of non-idempotent writes. Add compatibility paths only for concrete supported consumers.

## Testing

- Add regression tests for meaningful behavior changes and bug fixes. Test observable behavior rather than duplicating implementation details.
- Keep regression tests and reusable helpers in the relevant package's `tests/` directory, or the root `tests/` directory for cross-package tests, once the test layout is established.
- For Node.js tests, prefer `node:test` and `node:assert/strict` unless the repository adopts another runner. Use appropriate component or desktop integration tools for UI behavior.
- Reuse helpers for temporary SQLite databases and deterministic fixtures. Isolate test data, clean it up, and never run tests against a user's working database.
- Stub external services and host integrations in unit tests. Use targeted integration tests to verify real SQLite transactions, persistence, HTTP behavior, and host adapters.
- For grid changes, verify the affected keyboard navigation, selection, clipboard, and Chinese IME behavior. Do not treat headless tests as proof that native input-method interactions work.
- Prefer automated validation during implementation. Defer Computer Use, native IME checks, and external spreadsheet interoperability to the final release candidate; record those checks as pending until performed. Invite the user to perform final end-to-end acceptance once the complete candidate is ready.
- Validate business-only changes primarily with Node, SQLite, HTTP, CLI and protocol tests. Add automated UI acceptance for changed UI behavior. Describe new features in RowWeave's own terms; do not add reference-product names or comparisons to repository content.
- Measure performance with production builds and reproducible datasets. Record hardware, OS, display settings, dependency versions, data scale, and test steps. Report measured results separately from estimates and unverified claims.
- Do not assume a Windows-only CI environment or an existing coverage threshold. Follow the CI configuration actually present in the repository.

## Commits and Pull Requests

- Follow Conventional Commits for commit messages and PR titles, for example `feat: add batch record updates`. Write commit messages, PR titles, and PR descriptions in English. Use Chinese proper nouns where English cannot convey them accurately.
- Keep PRs focused on one coherent change that can be reviewed, validated, and merged on its own. Include related tests and documentation. Separate unrelated cleanup and broad refactoring. Use diff size as a review signal, not a hard limit; explain why unusually large changes cannot reasonably be split.
- Merge every change into `main` through a PR using squash merge. Direct pushes and force pushes to `main` are prohibited.
- Unless the user explicitly asks to keep a PR open, merge it as soon as its CI and relevant validation pass and any blocking review findings are resolved. Do not wait for another confirmation or accumulate completed PRs. Start the next dependent PR from the updated `main`.
- Use descriptive feature branch names such as `feat/record-editing` or `docs/add-repository-guidelines`. Agent-branded prefixes such as `codex/`, `claude/`, `copilot/`, and `cursor/` are prohibited. Never include agent credits anywhere in a branch name.
- In PRs, describe the concrete problem, resulting behavior, affected components, and how the change was verified. Link relevant issues and include screenshots for desktop UI changes when available; state when visual verification was not possible.
- Preserve the repository's configured human Git identity. Verify author and committer identities before committing, and PR author identity before creating a PR.

## Secrets and Local Data

- Keep real credentials, private configuration, SQLite data and journal files, generated datasets, and build output out of Git. Add appropriate ignore rules when introducing these files, and use placeholders in example configuration.
- Install Gitleaks and scan staged changes before committing. Never bypass a detected secret or claim a scan ran when the tool was unavailable.
- When version-controlled hooks are added under `.githooks/`, enable the staged secret scan with `git config --local core.hooksPath .githooks`. The directory and hook must exist before enabling this setting; until then, run the staged scan explicitly.

### Coding Agent Attribution

- Never credit coding agents or models in commit messages, including merge and squash messages, or in PR titles or descriptions. Never use coding-agent identities as Git authors, committers, or PR authors, including bot accounts and email aliases.
- The ban applies regardless of capitalization or formatting. It covers `Co-Authored-By: Claude <noreply@anthropic.com>`, Claude model-name variants, and any agent credit in `Co-authored-by:`, `Assisted-by:`, `Generated-by:`, `Committed-By-Agent:`, `Signed-off-by:`, `Reviewed-by:`, or other trailers.
- Omit agent attribution in footers such as `🤖 Generated with Claude Code` and `Made with Cursor`, badges, hidden HTML comments, and session links or IDs such as `Claude-Session:`.
- Disable automatic attribution where supported. Verify branch names, Git identities, commit messages, and raw PR text before publishing or merging. Use a different workflow if a tool cannot comply.

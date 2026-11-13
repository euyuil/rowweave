# Workspace UI candidate verification

This report covers the four bounded UI improvements in [refinement-plan.md](refinement-plan.md). Use [acceptance.md](acceptance.md) for the owner's final walkthrough. The package is ready for user evaluation; this report does not accept it on the owner's behalf.

## Exact candidate

- Clean source: `b9c0dd03b6d688453d63f5cea2bc9e6ec59ef5ff`, from main after the four UI PRs merged.
- Package: `release/0.1.0-20261113T024525899Z/rowweave-0.1.0-win32-x64.zip` (161,497,613 bytes).
- SHA-256: `639f97ea514d68a903208d73ee782ef0a73b5b5052e1a106d83c166af2efb4fa`, independently checked against the ZIP.
- Executable inside the extracted archive: `rowweave-win32-x64/rowweave.exe`. `release/latest.json` records the same source revision and `uncommittedChanges: false`.

Each feature was squash merged independently after its required Linux and Windows checks passed: [view tabs (#49)](https://github.com/euyuil/rowweave/pull/49), [filter and sort panels (#50)](https://github.com/euyuil/rowweave/pull/50), [record side panels (#51)](https://github.com/euyuil/rowweave/pull/51), and [column field settings (#52)](https://github.com/euyuil/rowweave/pull/52). The subsequent verification documentation does not alter the packaged application.

## Automated and visual evidence

Type checking, production builds and the complete configured CI passed. The unchanged business layer remains covered by all 150 Node tests on both CI platforms, including the IPv6 fixture unavailable in the local environment. Every implementation and documentation commit passed its staged Gitleaks scan.

| Changed workflow | Acceptance evidence |
| --- | --- |
| Workspace and view tabs | Arrow/Home/End focus and explicit Enter activation, retained search/grid drafts, persisted selected view, horizontal overflow with 13 views at 1024 × 768, and bounded page width. |
| Filters and sorting | Typed nested groups, independent rule updates, preserved temporary search and saved search, Cancel/Escape, focus restoration, empty OR indicators, Ctrl+S and retained concurrent-update drafts. |
| Record side panels | Grid/board entry points, many-field scrolling, long and formatted display titles, fixed title/save controls, explicit cancellation/discard choices, typed saves and retained version conflicts. |
| Column field settings | Column-relative placement, 12-option scrolling, no schema writes on cancellation, invalid conversion blocking, explicit successful apply, stale-schema draft retention and grid focus restoration. |

The final extracted ZIP passed `npm run test:packaged`: complete workspace lifecycle, connections, editing/cancellation, keyboard selection, clipboard, 1,000 × 10 paste/save, synthetic composition guards, conflicts, restart persistence and service failure. `npm run test:interfaces` passed shared versioned-record operations through that extracted desktop, the SDK bundle, CLI subprocess, MCP protocol client and Harness UI, plus Harness archive/module lifecycle, typed editing and CSV exchange. All data was isolated from working profiles.

Final logs: `.artifacts/ui-candidate-package.log`, `.artifacts/ui-candidate-packaged.log` and `.artifacts/ui-candidate-interfaces.log`. Candidate screenshots are retained under `.artifacts/ui-candidate-screenshots/`.

Screenshots were visually reviewed for the view tabs, populated workspace, filter/sort panels, grid/board record panels, and field options/conversion preview. The new layout checks include 1024 × 768 windows. These are automated desktop interactions and screenshot review, not native input-method verification.

## Performance and remaining manual acceptance

No new performance benchmark is claimed for this UI-only candidate. The previous [workflow report](refinement-validation.md) and [initial product report](product-performance.md) retain their exact binary revisions, datasets, hardware and measured limits. In particular, the earlier 32 Hz run did not establish the 60 Hz scrolling target, and the linked-summary scan exceeded the scalar-query target. Those results must not be presented as measurements of this package.

Native Chinese IME, external spreadsheet clipboard round trips and scrolling on the owner's normal display remain final manual checks. The owner should also assess navigation density, schema flexibility, panel behavior, and complete workflows using the current package. The UI iteration adds no new business types, automation runtime, collaboration, or platform scope.

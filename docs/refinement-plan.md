# Everyday table workflows

This bounded iteration extends the first product release in [completion-plan.md](completion-plan.md), following the owner's 2026-11-13 acceptance feedback. The aim is a flexible, usable table workspace with complete workflows, not a collection of isolated settings. Only the items below expand the original scope.

## Delivery and acceptance

Each item is one coherent, independently validated improvement. Split an item further only when each resulting PR is useful on its own. Merge passing PRs before starting dependent changes.

- [x] **Display identity.** Say primary display field throughout the product. Explain the difference between record UUIDs, field UUIDs and display values. Show actual IDs in optional detail disclosures. Automated desktop identity and schema workflows passed; PR #41 merged.
- [x] **Grouped summaries.** Count all matching records and calculate numeric sums, averages, minima and maxima. Group scalar values without conflating null and empty text. Honor saved-view filters and search, paginate groups and reject stale continuation. Expose the same operation in desktop, HTTP, SDK, CLI and MCP. Twelve targeted Node tests passed; automated desktop acceptance verified 501 records, group totals, averages, saved-view filters and recovery from changed views. The summary screenshot was visually reviewed.
- [x] **Direct column workflows.** Configure fields and arrange a view from column-level actions; make filtering/sorting discoverable without a long sequence of modal navigation. Preserve draft, schema-version and view-version guarantees. Automated desktop acceptance covers column dropdowns, right-click and keyboard access, focus restoration, sorting/filter preservation, reordering with keyboard/copy/paste, hidden fields, direct schema editing, drafts and concurrent view changes. The column-action screenshot was visually reviewed.
- [ ] **Saved display settings.** Persist row density and frozen leading columns per view. Reconcile hidden/deleted columns, preserve defaults for existing workspaces and verify keyboard/selection/clipboard behavior.
- [ ] **Status boards.** Provide a saved board view over a single-select field, with bounded loading, counts, record details and explicit versioned moves between options. Preserve filters, empty status, option IDs and draft behavior.
- [ ] **Computed fields.** Support a defined expression language for arithmetic and useful text/conditional functions, with field-ID references that survive renaming, explicit errors, dependency validation and consistent service-side reads. Do not execute arbitrary JavaScript or download whole tables into the renderer to calculate them.
- [ ] **Linked summaries.** Summarize numeric values from linked records with count/sum/average/min/max, preserve missing-value semantics and propagate source changes through reads and view queries. Extend the existing lookup model with a concrete supported operation rather than adding a second calculation runtime.

This iteration keeps the existing Windows desktop, standalone service and shared host interfaces. Enterprise organization management, a built-in AI runtime, cloud collaboration, public forms, billing and new operating systems remain outside scope. Formulas and a status-board view are explicit additions to the original release boundaries.

## Verification

Business rules use Node, SQLite, HTTP and protocol/subprocess regression tests. UI changes add automated desktop or component acceptance cases; use screenshots to assess layout when available. Test data stays isolated. Avoid Computer Use for routine implementation validation.

For each feature, record what was actually verified. Reuse the original performance baseline only for unchanged behavior; do not claim a new production measurement without running it. Once these workflows are implemented, required CI passes, and the final extracted package is verified, invite the owner to repeat end-to-end acceptance. Owner acceptance remains a human decision.

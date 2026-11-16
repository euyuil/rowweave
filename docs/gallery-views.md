# Gallery views

Create a **Gallery** view to browse records as cards. Choose **Small**, **Medium** or **Large** cards, optionally select an attachment cover, and choose whether images fill the cover or fit inside it. **Display** saves these settings and the card fields' order and visibility.

Cards use the primary display field as their title and show the first six visible fields other than the title and cover. The title and configured cover remain available even when hidden from the ordinary view projection. Open a title or cover to edit the complete record, including hidden fields. Arrow keys navigate cards, Home/End selects the first/last card on the page, and Enter opens details. Returning from details retains the card's keyboard focus; if it no longer matches the view, focus returns to the gallery.

Saved filters, sorting and search work as they do in other views. Record UUIDs remain the identities used for edits. Gallery presentation does not copy records or create another attachment store.

## Attachment covers

The cover field can be an attachment field or an attachment-valued lookup. Covers use the first JPEG, PNG, WebP, GIF, AVIF or BMP file in the field's order. A lookup keeps its original file and source table identity. SVG and other files show a filename placeholder; an empty field shows **No cover**. Invalid images and failed downloads show **Preview unavailable** with guidance to open the record. They are not silently replaced by a different image.

Images come from the authenticated attachment endpoint, never an external image URL. Covers load near the visible viewport; leaving that area cancels outstanding reads and releases their object URLs. Changing unrelated record values does not download an unchanged cover again. The existing 8 MiB attachment limit still applies. This bounds file size and loading scope; it is not a measured image-decoding or renderer-memory guarantee.

## Shared configuration

Use the existing HTTP view endpoints, SDK `createView`/`updateView`, CLI `views create/update` or MCP `views_create/views_update`:

```json
{
  "name": "Collection",
  "type": "gallery",
  "gallery": {
    "cardSize": "medium",
    "coverFit": "cover",
    "coverFieldId": "attachment-field-uuid"
  }
}
```

`cardSize` is `small`, `medium` or `large`; `coverFit` is `cover` or `contain`. `coverFieldId` is optional. Omitting the entire configuration on creation gives medium cards with crop-to-fill and no cover. An update without `gallery` keeps the saved configuration; an explicit `gallery` object replaces it, so omitting `coverFieldId` from that object removes the cover. Partial or invalid objects are rejected with `INVALID_VIEW`.

Normal columns, query settings and view versions apply. Gallery does not use grouping or board lanes. Renaming the cover field retains its UUID; deleting or changing it incompatibly returns `VIEW_DEPENDENCY` until the cover is removed or changed. Switching view types removes the prior type's settings. Database format 37 gates gallery configurations while preserving existing records, views and versions; workspace backups include covers and settings.

`queryView`/`views query`/`views_query` remain the shared read operation. Their default projection follows visible columns; a client rendering covers must explicitly request title/cover fields if hidden. The UI reads 40 records per gallery page, including title, cover and up to six card fields, with a complete matching count. The model's initial read is separately bounded to 100 records. CSV export follows the saved visible columns and complete matching query, independent of card pagination.

## Refresh and verification

External updates publish the schema, view and projected page together. Active drafts and composition prevent background replacement. Refresh retains scroll and focused record identity, clamps a removed last page, and rejects an obsolete response after navigation. Failed reads keep the last complete snapshot with an actionable error. Normal record/view version checks reject stale writes without automatic retries.

SQLite and client tests cover saved configuration, attachment lookups, field dependencies, projection, filters/sort/CSV, cancellation, stale versions, migration, backup and restart. Real SDK/CLI/MCP tests compare configuration and projected attachment metadata. Automated desktop and installed Harness tests cover cards, configuration, lazy covers, file failures, keyboard editing, search, paging and external refresh. Native input methods and current performance measurements remain part of final-candidate acceptance in the [active inventory](gap-closure-plan.md).

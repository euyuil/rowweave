import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { valueField, isLookupSummary, type Field, type GroupCollapse, type GroupLayout, type GroupWindow, type ScalarValue, type Table } from '../../contracts/src/index.js';
import { fieldText } from '../../core/src/field-display.js';
import { lookupSql } from './lookups.js';
import { groupOrder } from './query-sql.js';

export function groupLayout(db: DatabaseSync, table: Table, field: Field, collapse: GroupCollapse,
  where: string, parameters: Record<string, SQLInputValue>, offset: number, limit: number, window: GroupWindow): GroupLayout {
  const selected = valueField(field);
  const configured = selected.type === 'singleSelect' ? [...selected.options!.map(option => option.id), null]
    : selected.type === 'checkbox' ? [false, true, null] : [null];
  const expression = isLookupSummary(field) ? lookupSql(field) : 'json_extract(r.values_json, :groupPath)';
  const order = groupOrder(field, 'key').join(', ');
  const range = window === 'expandedRecords'
    ? 'NOT collapsed AND count > 0 AND expandedOffset < :groupOffset + :groupLimit AND expandedOffset + count > :groupOffset'
    : 'rowStart < :groupOffset + :groupLimit AND rowStart + span > :groupOffset';
  // Prefix sums keep record offsets independent of collapsed display rows; only intersecting groups leave SQLite.
  const row = db.prepare(`WITH input AS MATERIALIZED (
      SELECT ${expression} AS key FROM records r WHERE ${where}
    ), actual AS MATERIALIZED (SELECT key, COUNT(*) AS count FROM input GROUP BY key),
    groups AS MATERIALIZED (
      SELECT * FROM actual UNION ALL SELECT value, 0 FROM json_each(:groupConfigured) configured
      WHERE NOT EXISTS (SELECT 1 FROM actual WHERE actual.key IS configured.value)
    ), exceptions AS MATERIALIZED (SELECT value AS key, 1 AS toggled FROM json_each(:groupExceptions)),
    flags AS (
      SELECT groups.*, CASE WHEN chosen.toggled THEN NOT :groupCollapsed ELSE :groupCollapsed END AS collapsed
      FROM groups LEFT JOIN exceptions chosen ON chosen.key IS groups.key
    ), spans AS (SELECT *, 1 + CASE WHEN collapsed THEN 0 ELSE count END AS span FROM flags),
    layout AS MATERIALIZED (
      SELECT *, SUM(count) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) - count AS recordOffset,
        SUM(span) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) - span AS rowStart,
        SUM(span - 1) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) - span + 1 AS expandedOffset FROM spans
    )
    SELECT SUM(count) AS totalRecords, COUNT(*) AS totalGroups, SUM(span) AS totalRows,
      (SELECT json_group_array(json_object('key', key, 'count', count, 'recordOffset', recordOffset,
        'rowStart', rowStart, 'expandedOffset', expandedOffset, 'collapsed', collapsed)) FROM (
        SELECT * FROM layout WHERE ${range}
        ORDER BY rowStart LIMIT :groupLimit
      )) AS segments FROM layout`).get({ ...parameters,
        ...(!isLookupSummary(field) ? { ':groupPath': `$.${JSON.stringify(field.id)}` } : {}),
        ':groupConfigured': JSON.stringify(configured), ':groupExceptions': JSON.stringify(collapse.exceptions),
        ':groupCollapsed': Number(collapse.defaultCollapsed), ':groupOffset': offset, ':groupLimit': limit })!;
  const segments = JSON.parse(row['segments'] as string) as Array<{ key: ScalarValue; count: number; recordOffset: number; rowStart: number; expandedOffset: number; collapsed: number }>;
  return { window, groups: segments.map(segment => {
    const key = selected.type === 'checkbox' && segment.key !== null ? Boolean(segment.key) : segment.key;
    return { ...segment, key, label: fieldText(field, key), collapsed: Boolean(segment.collapsed) };
  }), totalRecords: row['totalRecords'] as number, totalGroups: row['totalGroups'] as number,
  totalRows: row['totalRows'] as number, offset, revision: table.revision, schemaVersion: table.version };
}

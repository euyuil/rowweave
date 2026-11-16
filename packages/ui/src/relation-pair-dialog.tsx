import React, { useEffect, useRef, useState } from 'react';
import { maxLinkedRecords, type Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { Dialog } from './dialog.js';

export function RelationPairDialog({ tableId, fieldId, api, setDirty, onRead, onClose, onSaved, restoreFocus }: {
  tableId: string; fieldId: string; api: WorkspaceApi; setDirty(value: boolean): void;
  onRead(table: Table): void; onClose(): void; onSaved(table: Table): Promise<void>; restoreFocus(): void;
}) {
  const [source, setSource] = useState<Table>();
  const [target, setTarget] = useState<Table>();
  const [selected, setSelected] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [needsRead, setNeedsRead] = useState(false);
  const [error, setError] = useState<string>();
  const picker = useRef<HTMLSelectElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const field = source?.fields.find(candidate => candidate.id === fieldId);
  const choices = target?.fields.filter(candidate => candidate.id !== fieldId && candidate.type === 'relation'
    && candidate.relation!.tableId === tableId && !candidate.relation!.inverseFieldId) ?? [];
  const selectedField = choices.find(candidate => candidate.id === selected);
  useEffect(() => { setDirty(!!selected || busy); return () => setDirty(false); }, [selected, busy, setDirty]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined); setTarget(undefined);
    void (async () => {
      const current = await api.getTable(tableId, controller.signal);
      if (controller.signal.aborted) return;
      setSource(current); onRead(current);
      const currentField = current.fields.find(candidate => candidate.id === fieldId);
      if (currentField?.type !== 'relation') throw new Error('This linked field no longer exists. Close this dialog and choose a current field.');
      if (currentField.relation!.inverseFieldId) throw new Error('This field is already paired. Close this dialog to review its current configuration.');
      const linked = currentField.relation!.tableId === tableId ? current : await api.getTable(currentField.relation!.tableId, controller.signal);
      if (!controller.signal.aborted) { setTarget(linked); setNeedsRead(false); }
    })().catch(error => { if (!controller.signal.aborted) { setError(error.message); setNeedsRead(true); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, tableId, fieldId, refresh, onRead]);
  useEffect(() => {
    if (error) alert.current?.focus();
    else if (!loading) picker.current?.focus();
  }, [error, loading]);
  const pair = async () => {
    setBusy(true); setError(undefined);
    try {
      const next = await api.pairRelationFields(tableId, fieldId, {
        expectedVersion: source!.version, targetFieldId: selected, expectedTargetVersion: target!.version,
      });
      setDirty(false); await onSaved(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The pairing could not be confirmed.');
      setNeedsRead(true);
    } finally { setBusy(false); }
  };
  return <Dialog title="Pair existing linked fields" onClose={onClose} busy={busy} restoreFocus={restoreFocus}>
    <p>Connect <strong>{field?.name ?? 'this field'}</strong>{source && <> in <strong>{source.name}</strong></>} to an existing reverse field.</p>
    <p className="form-note">Keep both sets of links and both columns. After pairing, saved changes on either side update the other.</p>
    <p className="form-note">If the combined links exceed either field's record limit, nothing is changed. Resolve those links before pairing.</p>
    {loading && <p role="status">Reading current fields…</p>}
    {target && <>
      <label className="form-field">Reverse field in {target.name}<select ref={picker} aria-label="Existing reverse field"
        disabled={busy || loading || needsRead} value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">Choose a field…</option>
        {selected && !selectedField && <option value={selected} disabled>Previously selected field is unavailable</option>}
        {choices.map(candidate => <option key={candidate.id} value={candidate.id}>
          {candidate.name}{choices.filter(other => other.name === candidate.name).length > 1 ? ` (${candidate.id})` : ''}
          {candidate.relation!.multiple ? ' · Multiple records' : ' · One record'}
        </option>)}
      </select></label>
      {!choices.length && <p role="status">No compatible reverse fields. Add an unpaired linked-record field in {target.name} that points to {source!.name}, then read current fields.</p>}
      {selectedField && <p className="form-note">{field!.name}: {field!.relation!.multiple ? `up to ${maxLinkedRecords} records` : 'one record'}. {selectedField.name}: {selectedField.relation!.multiple ? `up to ${maxLinkedRecords} records` : 'one record'}.</p>}
    </>}
    {error && <p ref={alert} tabIndex={-1} className="form-error" role="alert">{error}{target && needsRead && ' Read current fields before trying again.'}</p>}
    <div className="dialog-actions">
      <button disabled={busy} onClick={onClose}>Cancel</button>
      <button disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>Read current fields</button>
      <button className="primary" disabled={busy || loading || needsRead || !selectedField} onClick={() => void pair()}>{busy ? 'Pairing…' : 'Pair fields'}</button>
    </div>
  </Dialog>;
}

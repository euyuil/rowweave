import React, { useEffect, useId, useRef, useState } from 'react';
import type { Rectangle } from '@glideapps/glide-data-grid';
import type { Field, GridView } from '../../contracts/src/index.js';

export type ColumnAction = 'configure' | 'asc' | 'desc' | 'clearSort' | 'left' | 'right' | 'hide';

export function ColumnActions({ field, view, bounds, disabled, onAction, onClose }: {
  field: Field; view: GridView; bounds: Rectangle; disabled: boolean;
  onAction(action: ColumnAction): Promise<void>; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const visible = view.columns.filter(column => !column.hidden);
  const position = visible.findIndex(column => column.fieldId === field.id);
  const sorted = view.query.sort?.find(rule => rule.fieldId === field.id);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const size = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(bounds.x, window.innerWidth - size.width - 8))}px`;
    const top = Math.max(8, Math.min(bounds.y + bounds.height, window.innerHeight - size.height - 8));
    element.style.top = `${top}px`;
    element.style.maxHeight = `${window.innerHeight - top - 8}px`;
    return () => element.close();
  }, [bounds]);
  const close = () => { dialog.current!.close(); onClose(); };
  const run = async (action: ColumnAction) => {
    setBusy(true);
    setError(undefined);
    try { await onAction(action); }
    catch (failure) {
      setError(`${failure instanceof Error ? failure.message : 'The column could not be changed.'} Close this menu and reload before trying again.`);
      setBusy(false);
    }
  };
  return <dialog ref={dialog} className="column-actions" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div className="column-actions-content"><h2 id={title}>{field.name} column actions</h2>
      {field.description && <p className="form-note field-description">{field.description}</p>}
      <fieldset disabled={busy || disabled}>
        <button onClick={() => void run('configure')}>Configure field</button>
        <hr />
        <button aria-pressed={sorted?.direction === 'asc'} onClick={() => void run('asc')}>Sort ascending</button>
        <button aria-pressed={sorted?.direction === 'desc'} onClick={() => void run('desc')}>Sort descending</button>
        <button disabled={!sorted} onClick={() => void run('clearSort')}>Clear sorting for this field</button>
        <hr />
        <button disabled={position === 0} onClick={() => void run('left')}>Move left</button>
        <button disabled={position === visible.length - 1} onClick={() => void run('right')}>Move right</button>
        <button disabled={visible.length === 1} onClick={() => void run('hide')}>Hide in this view</button>
      </fieldset>
      {error && <p role="alert" className="form-error">{error}</p>}
      <button disabled={busy} onClick={close}>Close</button>
    </div>
  </dialog>;
}

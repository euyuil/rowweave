import React, { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import type { GridCell, ProvideEditorComponent, TextCell } from '@glideapps/glide-data-grid';
import type { CellValue, Field, RecordLink } from '../../contracts/src/index.js';
import { sameValue } from '../../client/src/cell-values.js';
import { FieldInput } from './field-input.js';
import { fromFormValue, toFormValue, type FormValue } from './field-input-values.js';
import { AttachmentContext } from './attachment-context.js';

export interface EditableCell extends TextCell { field: Field; rawValue: CellValue; row: number; gridRow: number }
type Movement = readonly [-1 | 0 | 1, -1 | 0 | 1];
export interface EditorHandle { finish(commit: boolean, movement?: Movement): boolean; contains(target: Node): boolean }
interface EditorBridge {
  save(): void;
  setDirty(value: boolean): void;
  register(handle: EditorHandle | undefined): void;
  commit(row: number, field: Field, value: CellValue, links?: RecordLink[]): string | undefined;
}
export const EditorContext = createContext<EditorBridge | undefined>(undefined);

export const CellEditor: ProvideEditorComponent<GridCell> = ({ value: gridValue, onFinishedEditing, isHighlighted }) => {
  const value = gridValue as EditableCell;
  const bridge = useContext(EditorContext)!;
  const attachments = useContext(AttachmentContext);
  const transferring = useRef(false); transferring.current = !!attachments?.pending;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const closed = useRef(false);
  const links = useRef<RecordLink[]>();
  const text = ['text', 'multiline', 'number'].includes(value.field.type);
  const descriptionId = useId();
  const initial = useRef<FormValue>(text ? value.copyData ?? value.data : toFormValue(value.field, value.rawValue));
  const [draft, setDraft] = useState<FormValue>(text ? value.data : initial.current);
  const [error, setError] = useState<string>();
  const latest = useRef({ value, draft, onFinishedEditing });
  latest.current = { value, draft, onFinishedEditing };
  const finish: EditorHandle['finish'] = (commit, movement = [0, 0]) => {
    if (closed.current) return true;
    if (transferring.current) return false;
    if (commit && composing.current) return false;
    const current = latest.current;
    if (commit && !sameValue(current.draft, initial.current)) {
      try {
        const parsed = fromFormValue(current.value.field, current.draft);
        const failure = bridge.commit(current.value.row, current.value.field, parsed, links.current);
        if (failure) { setError(failure); return false; }
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Enter a valid value.'); return false; }
    }
    closed.current = true;
    current.onFinishedEditing(undefined, movement);
    return true;
  };
  useLayoutEffect(() => {
    bridge.setDirty(!sameValue(latest.current.draft, initial.current));
    bridge.register({ finish, contains: target => root.current!.contains(target) });
    return () => { bridge.register(undefined); bridge.setDirty(false); };
  }, [bridge]);
  useLayoutEffect(() => {
    if (input.current) {
      input.current.focus();
      if (isHighlighted) input.current.select();
      else input.current.setSelectionRange(input.current.value.length, input.current.value.length);
    } else root.current!.querySelector<HTMLElement>('input, select, textarea')!.focus();
  }, [isHighlighted]);
  const change = (next: FormValue, labels?: RecordLink[]) => {
    links.current = labels;
    setDraft(next);
    setError(undefined);
    bridge.setDirty(!sameValue(next, initial.current));
  };
  return <div ref={root} className={`rowweave-cell-editor${text ? '' : ' typed-cell-editor'}`}
    onCompositionStart={() => { composing.current = true; bridge.setDirty(true); }}
    onCompositionEnd={event => {
      composing.current = false;
      if (text && event.target instanceof HTMLTextAreaElement) change(event.target.value);
      else bridge.setDirty(!sameValue(latest.current.draft, initial.current));
    }}
    onKeyDownCapture={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        event.stopPropagation();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopPropagation(); bridge.save();
      } else if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) {
        event.stopPropagation();
      } else if (event.key === 'Escape' || event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault(); event.stopPropagation();
        finish(event.key !== 'Escape', event.key === 'Tab' ? [event.shiftKey ? -1 : 1, 0] : event.key === 'Enter' ? [0, 1] : [0, 0]);
      }
    }}>
    {text ? <textarea ref={input} aria-label="Cell value" aria-describedby={value.field.description ? descriptionId : undefined} value={draft as string}
      rows={Math.min(6, (draft as string).split('\n').length)} inputMode={value.field.type === 'number' ? 'decimal' : undefined}
      onChange={event => change(event.target.value)} />
      : <FieldInput field={{ ...value.field, name: 'Cell value' }} value={draft} onChange={change} />}
    {text && value.field.description && <small id={descriptionId} className="field-description cell-description">{value.field.description}</small>}
    {error && <div role="alert" className="cell-error">{error}</div>}
    {!text && <div className="cell-editor-actions"><button disabled={!!attachments?.pending} onClick={() => finish(false)}>Cancel</button><button disabled={!!attachments?.pending} onClick={() => finish(true)}>Apply</button></div>}
  </div>;
};

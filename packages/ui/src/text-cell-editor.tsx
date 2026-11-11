import React, { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { GridCellKind, type ProvideEditorComponent, type GridCell } from '@glideapps/glide-data-grid';

export type FinishEditor = (commit: boolean) => boolean;
export const EditorContext = createContext({
  save: () => {},
  setDirty: (_dirty: boolean) => {},
  register: (_finish: FinishEditor | undefined) => {},
});

export const TextCellEditor: ProvideEditorComponent<GridCell> = ({ value, onChange, onFinishedEditing, isHighlighted }) => {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const bridge = useContext(EditorContext);
  // The grid replaces data with the first typed key, while copyData retains the original text.
  const initial = useRef(value.kind === GridCellKind.Text ? value.copyData ?? value.data : '');
  const latest = useRef({ value, onFinishedEditing });
  latest.current = { value, onFinishedEditing };
  useLayoutEffect(() => {
    bridge.setDirty(latest.current.value.kind === GridCellKind.Text && latest.current.value.data !== initial.current);
    bridge.register(commit => {
      if (commit && composing.current) return false;
      const current = latest.current;
      current.onFinishedEditing(commit && current.value.kind === GridCellKind.Text
        ? { ...current.value, data: input.current?.value ?? current.value.data } : undefined, [0, 0]);
      return true;
    });
    return () => { bridge.register(undefined); bridge.setDirty(false); };
  }, [bridge]);
  useLayoutEffect(() => {
    input.current?.focus();
    if (isHighlighted) input.current?.select();
    else if (input.current) input.current.setSelectionRange(input.current.value.length, input.current.value.length);
  }, [isHighlighted]);
  if (value.kind !== GridCellKind.Text) return null;
  return <textarea ref={input} aria-label="Cell value" value={value.data} rows={Math.min(6, value.data.split('\n').length)}
    style={{ width: '100%', minWidth: 120, resize: 'vertical', border: 0, outline: 0, font: 'inherit', color: 'inherit', background: 'transparent' }}
    onChange={event => {
      bridge.setDirty(event.target.value !== initial.current);
      onChange({ ...value, data: event.target.value });
    }}
    onCompositionStart={() => { composing.current = true; bridge.setDirty(true); }}
    onCompositionEnd={event => {
      composing.current = false;
      bridge.setDirty(event.currentTarget.value !== initial.current);
      onChange({ ...value, data: event.currentTarget.value });
    }}
    onKeyDownCapture={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        event.stopPropagation();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        bridge.save();
      }
    }} />;
};

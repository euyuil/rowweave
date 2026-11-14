import React, { useEffect, useRef } from 'react';
import type { GridView } from '../../contracts/src/index.js';

export function ViewTabs({ views, selected, disabled, panelId, onSelect, onCreate }: {
  views: GridView[]; selected: string | undefined; disabled: boolean; panelId: string;
  onSelect(view: GridView): void; onCreate(): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  return <div className="view-navigation">
    <div className="view-tabs" role="tablist" aria-label="Views" ref={list} onKeyDown={event => {
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const index = tabs.indexOf(event.target as HTMLButtonElement);
      if (disabled || index < 0) return;
      let next: number;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[next]!.focus();
      tabs[next]!.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }}>
      {views.map(view => <button key={view.id} role="tab" aria-selected={view.id === selected}
        aria-controls={panelId} tabIndex={view.id === selected ? 0 : -1} aria-disabled={disabled}
        title={`${view.name} · ${view.type === 'board' ? 'Board' : view.type === 'calendar' ? 'Calendar' : 'Grid'}`} onClick={() => { if (!disabled && view.id !== selected) onSelect(view); }}>
        <span aria-hidden="true" className="view-type-icon">{view.type === 'board' ? '▥' : view.type === 'calendar' ? '▣' : '▦'}</span>
        <span className="view-tab-name">{view.name}</span>
      </button>)}
    </div>
    <button className="new-view" aria-label="New view" title="New view" disabled={disabled} onClick={onCreate}>+</button>
  </div>;
}

import React, { useEffect, useId, useRef, type ReactNode } from 'react';

export interface DialogAnchor { x: number; y: number; width: number; height: number }

export function Dialog({ title, onClose, busy = false, wide = false, anchor, drawer = false, subtitle, children }: {
  title: string; onClose(): void; busy?: boolean; wide?: boolean; anchor?: DialogAnchor | undefined;
  drawer?: boolean; subtitle?: string | undefined; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!anchor) return;
    const element = dialog.current!;
    const position = () => {
      const top = Math.max(12, Math.min(anchor.y + anchor.height + 6, window.innerHeight - 180));
      element.style.left = `${Math.max(12, Math.min(anchor.x, window.innerWidth - element.getBoundingClientRect().width - 12))}px`;
      element.style.top = `${top}px`;
      element.style.maxHeight = `${window.innerHeight - top - 12}px`;
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [anchor]);
  return <dialog ref={dialog} className={`workspace-dialog${wide ? ' wide-dialog' : ''}${anchor ? ' anchored-dialog' : ''}${drawer ? ' drawer-dialog' : ''}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    {drawer ? <><header className="drawer-heading"><div>{subtitle && <p>{subtitle}</p>}<h2 id={titleId} title={title}>{title}</h2></div>
      <button type="button" aria-label="Close panel" disabled={busy} onClick={onClose}>×</button></header>
      <div className="drawer-body">{children}</div></> : <><h2 id={titleId}>{title}</h2>{children}</>}
  </dialog>;
}

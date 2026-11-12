import React, { useEffect, useId, useRef, type ReactNode } from 'react';

export function Dialog({ title, onClose, busy = false, children }: {
  title: string; onClose(): void; busy?: boolean; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="workspace-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </dialog>;
}

export function captureGanttFocus(root: HTMLElement): (() => boolean) | undefined {
  const focused = document.activeElement, gantt = root.querySelector('.gantt-view');
  if (!(focused instanceof HTMLElement) || !gantt?.contains(focused)) return;
  const key = focused.getAttribute('data-gantt-focus');
  const recordId = focused.closest('[data-gantt-record]')?.getAttribute('data-gantt-record');
  return () => {
    if (focused.isConnected && focused.getAttribute('data-gantt-focus') === key) return false;
    const same = key ? root.querySelector<HTMLElement>('[data-gantt-focus="' + CSS.escape(key) + '"]') : undefined;
    const title = recordId ? root.querySelector<HTMLElement>('[data-gantt-focus="title:' + CSS.escape(recordId) + '"]') : undefined;
    const target = same ?? title ?? root.querySelector<HTMLElement>('.gantt-view');
    target?.focus({ preventScroll: true });
    return !!recordId && !title;
  };
}

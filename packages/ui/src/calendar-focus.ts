export function captureCalendarFocus(root: HTMLElement): (() => boolean) | undefined {
  const focused = document.activeElement, calendar = root.querySelector('.calendar-view');
  if (!(focused instanceof HTMLElement) || !calendar?.contains(focused)) return;
  const key = focused.getAttribute('data-calendar-focus');
  const recordId = focused.closest('[data-record-id]')?.getAttribute('data-record-id');
  const date = focused.closest('[data-calendar-date]')?.getAttribute('data-calendar-date');
  return () => {
    if (focused.isConnected) return false;
    const next = key ? root.querySelector<HTMLElement>('[data-calendar-focus="' + CSS.escape(key) + '"]') : undefined;
    const moved = recordId ? root.querySelector<HTMLElement>('[data-record-id="' + CSS.escape(recordId) + '"][data-calendar-focus], [data-record-id="'
      + CSS.escape(recordId) + '"] [data-calendar-focus]') : undefined;
    const day = date ? root.querySelector<HTMLElement>('[data-calendar-day="' + CSS.escape(date) + '"]') : undefined;
    const target = next ?? moved ?? day ?? root.querySelector<HTMLElement>('.calendar-view');
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' });
    return !!recordId && !next && !moved;
  };
}

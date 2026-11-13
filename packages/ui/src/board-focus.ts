export function captureBoardFocus(root: HTMLElement): (() => boolean) | undefined {
  const focused = document.activeElement, board = root.querySelector('.board-view');
  if (!(focused instanceof HTMLElement) || !board?.contains(focused)) return;
  const recordId = focused.closest('[data-record-id]')?.getAttribute('data-record-id');
  return () => {
    if (focused.isConnected) return false;
    const next = recordId ? root.querySelector<HTMLElement>(`.board-card[data-record-id="${CSS.escape(recordId)}"] .board-card-title`) : undefined;
    const target = next ?? root.querySelector<HTMLElement>('.board-view');
    target?.focus({ preventScroll: true });
    return !!recordId && !next;
  };
}

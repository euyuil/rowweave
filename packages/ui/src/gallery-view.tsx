import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, GridView, RowRecord, Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { galleryCardFields, galleryCover, galleryImage, galleryPageSize, prepareGallerySnapshot, type GallerySnapshot, type GalleryWindow } from '../../client/src/gallery-refresh.js';
import { RecordValue, recordText } from './record-value.js';
import './gallery-view.css';

function GalleryCover({ api, file, fit }: { api: WorkspaceApi; file: Attachment | undefined; fit: 'cover' | 'contain' }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const key = file ? file.tableId + '/' + file.id : '';
  const [loaded, setLoaded] = useState<{ key: string; url?: string; error?: string }>();
  const state = loaded?.key === key ? loaded : undefined;
  const supported = file && galleryImage(file);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries[0]!.isIntersecting), {
      root: host.current!.closest('.gallery-viewport'), rootMargin: '160px',
    });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !file || !supported) return;
    const controller = new AbortController(); let url: string | undefined;
    setLoaded({ key });
    void api.downloadAttachment(file.tableId, file.id, controller.signal).then(bytes => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: file.mediaType }));
      setLoaded({ key, url });
    }).catch(error => {
      if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : 'Could not load the cover.' });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); setLoaded(undefined); };
  }, [api, key, visible, supported]);
  return <div ref={host} className="gallery-cover" style={{ '--gallery-cover-fit': fit } as React.CSSProperties}>
    {visible && state?.url && !state.error ? <img src={state.url} alt={file!.filename} decoding="async"
      onError={() => setLoaded({ key, error: 'This file could not be decoded as an image.' })} />
      : <span className="gallery-cover-placeholder" title={state?.error}>
        <span aria-hidden="true">{file ? '▧' : '◇'}</span>
        <small>{!file ? 'No cover' : !supported ? file.filename : state?.error ? 'Preview unavailable' : 'Loading cover…'}</small>
        {state?.error && <small>Open the record to download {file!.filename}.</small>}
      </span>}
  </div>;
}

export function GalleryView({ table, view, search, generation, revision, dateContext, total, api, prepared, disabled, recordOpen, onWindow, onOpen, onRefresh }: {
  table: Table; view: Extract<GridView, { type: 'gallery' }>; search: string; generation: number; revision: number;
  dateContext: string | undefined; total: number; api: WorkspaceApi; prepared: GallerySnapshot | undefined; disabled: boolean; recordOpen: boolean;
  onWindow(window: GalleryWindow | undefined): void; onOpen(record: RowRecord): void; onRefresh(): void;
}) {
  const [position, setPosition] = useState(0);
  const offset = Math.min(position, Math.max(0, Math.floor((total - 1) / galleryPageSize) * galleryPageSize));
  const key = JSON.stringify([view.id, view.version, table.version, generation, search, offset]);
  const [loaded, setLoaded] = useState<{ key: string; snapshot: GallerySnapshot }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const page = prepared?.window.offset === offset ? prepared.page : loaded?.key === key ? loaded.snapshot.page : undefined;
  const error = failure?.key === key ? failure.message : undefined;
  const viewport = useRef<HTMLDivElement>(null);
  const openedRecord = useRef<string>();
  const open = (record: RowRecord) => { openedRecord.current = record.id; onOpen(record); };
  const fields = useMemo(() => galleryCardFields(table, view), [table, view]);
  const primary = table.fields.find(field => field.id === table.primaryFieldId)!;
  useEffect(() => {
    if (prepared?.window.offset === offset) return;
    const controller = new AbortController();
    void prepareGallerySnapshot(api, table, view, { revision, total, ...(dateContext ? { dateContext } : {}) }, search, { offset }, controller.signal)
      .then(snapshot => { if (!controller.signal.aborted) setLoaded({ key, snapshot }); })
      .catch(error => { if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : 'Could not load the gallery.' }); });
    return () => controller.abort();
  }, [api, key, prepared]);
  useLayoutEffect(() => { onWindow({ offset }); return () => onWindow(undefined); }, [onWindow, offset]);
  useLayoutEffect(() => {
    if (disabled || !page || !openedRecord.current) return;
    // Restore before a newly mounted dialog captures its opener, and after its save reloads the cards.
    if (recordOpen && document.querySelector('dialog[open]')) return;
    const target = viewport.current!.querySelector<HTMLElement>('[data-gallery-title="' + CSS.escape(openedRecord.current) + '"]')
      ?? viewport.current!.closest<HTMLElement>('.gallery-view');
    target?.focus({ preventScroll: true });
    if (!recordOpen) openedRecord.current = undefined;
  }, [disabled, recordOpen, page]);
  const changePage = (next: number) => { setPosition(next); if (viewport.current) viewport.current.scrollTop = 0; };
  return <section className={'gallery-view gallery-' + view.gallery.cardSize} aria-label={view.name + ' gallery'} tabIndex={-1}>
    {error && <p className="form-error" role="alert">{error} <button disabled={disabled} onClick={onRefresh}>Reload gallery</button></p>}
    {!page && !error && <p role="status">Loading gallery…</p>}
    <div className="gallery-viewport" ref={viewport}>
      <ul className="gallery-cards" aria-label="Records" aria-busy={!page && !error}>
        {page?.records.map((record, index) => {
          const title = recordText(primary, record) || '(Untitled record)';
          return <li className="gallery-card" key={record.id} data-gallery-record={record.id}>
            {view.gallery.coverFieldId && <button className="gallery-cover-button" disabled={disabled} tabIndex={-1} aria-label={'Open ' + title} onClick={() => open(record)}>
              <GalleryCover api={api} file={galleryCover(view, record)} fit={view.gallery.coverFit} />
            </button>}
            <div className="gallery-card-body"><button className="gallery-title" data-gallery-title={record.id} disabled={disabled} onClick={() => open(record)}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                const list = event.currentTarget.closest('.gallery-cards')!;
                const columns = getComputedStyle(list).gridTemplateColumns.split(' ').length;
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? page.records.length - 1
                  : index + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns);
                event.preventDefault();
                list.querySelectorAll<HTMLButtonElement>('.gallery-title')[Math.max(0, Math.min(page.records.length - 1, next))]!.focus();
              }}>{title}</button>
              <dl>{fields.map(field => <div className="gallery-card-field" key={field.id}>
                <dt title={field.name}>{field.name}</dt><dd title={recordText(field, record)}><RecordValue field={field} record={record} /></dd>
              </div>)}</dl>
            </div>
          </li>;
        })}
      </ul>
      {page && !page.total && <p className="gallery-empty">No matching records.</p>}
    </div>
    <footer className="gallery-pages">
      <button disabled={disabled || offset === 0} onClick={() => changePage(Math.max(0, offset - galleryPageSize))}>Previous records</button>
      <span>{total ? offset + 1 : 0}–{Math.min(offset + galleryPageSize, total)} of {total.toLocaleString()} {total === 1 ? 'record' : 'records'}</span>
      <button disabled={disabled || offset + galleryPageSize >= total} onClick={() => changePage(offset + galleryPageSize)}>Next records</button>
      <small>Open a card to view every field</small>
    </footer>
  </section>;
}

export function captureGalleryFocus(root: HTMLElement): (() => boolean) | undefined {
  const focused = document.activeElement, gallery = root.querySelector('.gallery-view');
  if (!(focused instanceof HTMLElement) || !gallery?.contains(focused)) return;
  const recordId = focused.closest('[data-gallery-record]')?.getAttribute('data-gallery-record');
  return () => {
    if (focused.isConnected) return false;
    const title = recordId ? root.querySelector<HTMLElement>('[data-gallery-title="' + CSS.escape(recordId) + '"]') : undefined;
    (title ?? root.querySelector<HTMLElement>('.gallery-view'))?.focus({ preventScroll: true });
    return !!recordId && !title;
  };
}

import React, { useContext, useEffect, useRef, useState } from 'react';
import { maxAttachmentBytes, maxAttachmentsPerCell, type Attachment, type AttachmentPage } from '../../contracts/src/index.js';
import { WorkspaceContext } from './workspace-context.js';
import { AttachmentContext } from './attachment-context.js';
import { ApiFailure } from '../../client/src/http-client.js';

function fileSize(size: number): string { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`; }

export function AttachmentInput({ id, descriptionId, tableId, value, disabled, readOnly = false, allowUploads = true, onChange }: {
  id: string; descriptionId?: string | undefined; tableId: string; value: string[] | null; disabled: boolean; readOnly?: boolean;
  allowUploads?: boolean; onChange(value: string[]): void;
}) {
  const api = useContext(WorkspaceContext)!, context = useContext(AttachmentContext)!;
  const selected = value ?? [];
  const [offset, setOffset] = useState(0);
  const visible = selected.slice(offset, offset + 20), key = JSON.stringify(visible);
  const selectedKey = JSON.stringify(selected);
  useEffect(() => setOffset(0), [selectedKey]);
  const [files, setFiles] = useState<Record<string, Attachment>>({});
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [working, setWorking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [page, setPage] = useState<AttachmentPage>();
  const [before, setBefore] = useState<number>();
  const [previous, setPrevious] = useState<Array<number | undefined>>([]);
  const [loading, setLoading] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const libraryButton = useRef<HTMLButtonElement>(null);
  const latest = useRef(selected); latest.current = selected;
  useEffect(() => {
    let active = true;
    const ids = JSON.parse(key) as string[];
    void Promise.all([...new Set(ids)].map(id => api.getAttachment(tableId, id))).then(result => {
      if (active) { setFiles(Object.fromEntries(result.map(file => [file.id, file]))); setError(undefined); }
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [api, tableId, key]);
  useEffect(() => {
    if (!choosing) return;
    const controller = new AbortController(); setLoading(true);
    void api.listAttachments(tableId, { ...(before ? { before } : {}), limit: 25 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setPage(result); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, tableId, choosing, before]);
  const transfer = async (operation: () => Promise<void>, uploading = false) => {
    setWorking(true); context.transfer(1); setError(undefined); setNotice(undefined);
    try { await operation(); }
    catch (error) { setError((error instanceof Error ? error.message : 'The file operation failed.') +
      (uploading && !(error instanceof ApiFailure) ? ' Inspect uploaded files before uploading again; a response may have been lost.' : '')); }
    finally { setWorking(false); context.transfer(-1); }
  };
  const content = <div ref={container} className="attachment-input" tabIndex={readOnly ? undefined : -1}
    {...(!readOnly && !allowUploads ? { id, role: 'group', 'aria-labelledby': `${id}-label` } : {})}>
    <ul className="attachment-files">{visible.map((fileId, index) => {
      const file = files[fileId];
      return <li key={`${fileId}:${index}`}>
        <span><strong>{file?.filename ?? 'Loading file…'}</strong>{file && <small>{fileSize(file.size)}</small>}</span>
        <button type="button" disabled={!file || working} aria-label={`Download ${file?.filename ?? 'file'}`} onClick={() => void transfer(async () => {
          const bytes = await api.downloadAttachment(tableId, fileId);
          const saved = await context.saveFile(file!.filename, bytes);
          setNotice(saved === 'download-started' ? 'Download started.' : saved ? 'File saved.' : 'Download canceled.');
        })}>Download</button>
        {!readOnly && <button type="button" disabled={disabled || working} aria-label={`Remove ${file?.filename ?? 'file'}`} onClick={() => {
          onChange(selected.filter(id => id !== fileId)); libraryButton.current!.focus();
        }}>Remove</button>}
      </li>;
    })}</ul>
    {selected.length > 20 && <div className="attachment-pages"><button type="button" disabled={working || offset === 0} onClick={() => setOffset(offset - 20)}>Previous attachments</button>
      <small>{offset + 1}–{Math.min(offset + 20, selected.length)} of {selected.length} files</small>
      <button type="button" disabled={working || offset + 20 >= selected.length} onClick={() => setOffset(offset + 20)}>Next attachments</button></div>}
    {!readOnly && <>
      {allowUploads && <input id={id} aria-describedby={descriptionId} type="file" multiple disabled={disabled || working || selected.length >= maxAttachmentsPerCell}
        onChange={event => {
          const uploads = Array.from(event.target.files ?? []); event.target.value = '';
          if (!uploads.length) return;
          container.current!.focus();
          if (selected.length + uploads.length > maxAttachmentsPerCell || uploads.some(file => file.size > maxAttachmentBytes)) {
            setError('Attach at most 20 files, each up to 8 MiB.'); return;
          }
          void transfer(async () => {
            let next = [...latest.current];
            for (const file of uploads) {
              const bytes = new Uint8Array(await file.arrayBuffer());
              let binary = '';
              for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
              const uploaded = await api.uploadAttachment(tableId, { filename: file.name, mediaType: file.type || 'application/octet-stream', data: btoa(binary) });
              setFiles(current => ({ ...current, [uploaded.id]: uploaded }));
              next = [...next, uploaded.id]; onChange(next);
            }
            setNotice('Uploaded. Save the record to attach these files.');
          }, true);
        }} />}
      <button ref={libraryButton} type="button" disabled={disabled || working} onClick={() => { setChoosing(!choosing); setBefore(undefined); setPrevious([]); }}>Choose uploaded files</button>
      {choosing && <section className="attachment-library" aria-label="Uploaded files" aria-busy={loading}>
        {loading ? <p role="status">Loading files…</p> : page?.attachments.length === 0 ? <p>No uploaded files</p> : page?.attachments.map(file => <label key={file.id}>
          <input type="checkbox" checked={selected.includes(file.id)} disabled={disabled || working || (!selected.includes(file.id) && selected.length >= maxAttachmentsPerCell)}
            onChange={event => { setFiles(current => ({ ...current, [file.id]: file })); onChange(event.target.checked ? [...selected, file.id] : selected.filter(id => id !== file.id)); }} />
          {file.filename}<small>{fileSize(file.size)}</small>
        </label>)}
        <div className="attachment-pages"><button type="button" disabled={loading || !previous.length || working || disabled} onClick={() => {
          setBefore(previous.at(-1)); setPrevious(previous.slice(0, -1));
        }}>Previous files</button><button type="button" disabled={loading || !page?.nextBefore || working || disabled} onClick={() => {
          setPrevious([...previous, before]); setBefore(page!.nextBefore);
        }}>Next files</button></div>
      </section>}
      {allowUploads && <small>Up to 20 files, 8 MiB each. Removing a saved file keeps it available for history and recovery.</small>}
    </>}
    {working && <p role="status">Transferring file…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
  return readOnly ? <output id={id} aria-describedby={descriptionId}>{content}</output> : content;
}

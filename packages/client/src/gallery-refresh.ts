import type { Attachment, Field, GridView, QueryPage, RowRecord, Table, ViewPage } from '../../contracts/src/index.js';
import { ApiFailure, type WorkspaceApi } from './http-client.js';

export const galleryPageSize = 40;
export interface GalleryWindow { offset: number }
export interface GallerySnapshot { window: GalleryWindow; page: ViewPage }
type GalleryView = Extract<GridView, { type: 'gallery' }>;

export function galleryCardFields(table: Table, view: GalleryView): Field[] {
  const fields = new Map(table.fields.map(field => [field.id, field]));
  return view.columns.filter(column => !column.hidden).map(column => fields.get(column.fieldId)!)
    .filter(field => field.id !== table.primaryFieldId && field.id !== view.gallery.coverFieldId).slice(0, 6);
}
export function galleryProjection(table: Table, view: GalleryView): string[] {
  return [...new Set([table.primaryFieldId, ...(view.gallery.coverFieldId ? [view.gallery.coverFieldId] : []),
    ...galleryCardFields(table, view).map(field => field.id)])];
}
export function galleryImage(file: Attachment): boolean {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'].includes(file.mediaType);
}
export function galleryCover(view: GalleryView, record: RowRecord): Attachment | undefined {
  const files = view.gallery.coverFieldId ? record.attachments?.[view.gallery.coverFieldId] : undefined;
  return files?.find(galleryImage) ?? files?.[0];
}
export async function prepareGallerySnapshot(api: Pick<WorkspaceApi, 'queryView'>, table: Table, view: GalleryView,
  first: Pick<QueryPage, 'revision' | 'dateContext' | 'total'>, search: string, window: GalleryWindow, signal: AbortSignal): Promise<GallerySnapshot> {
  const offset = Math.min(window.offset, Math.max(0, Math.floor((first.total - 1) / galleryPageSize) * galleryPageSize));
  const page = await api.queryView(table.id, view.id, { offset, limit: galleryPageSize, fields: galleryProjection(table, view),
    expectedViewVersion: view.version, expectedRevision: first.revision, ...(first.dateContext ? { expectedDateContext: first.dateContext } : {}), search }, signal);
  if (page.schemaVersion !== table.version) throw new ApiFailure('SCHEMA_CONFLICT', 'The table schema changed while checking gallery updates.', 409);
  return { window: { offset }, page };
}

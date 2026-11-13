import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { RecordService, ServiceError } from '../../../packages/core/src/record-service.js';
import { networkPolicy, type NetworkOptions } from './network.js';
import { maxAttachmentBytes } from '../../../packages/contracts/src/index.js';

export interface ServerOptions extends NetworkOptions {
  service: RecordService;
  token: string;
}

export async function startServer({ service, token, ...options }: ServerOptions) {
  if (!/^[\x21-\x7e]{32,}$/.test(token)) throw new Error('Use an access token of at least 32 printable ASCII characters without spaces.');
  const policy = networkPolicy(options);
  const hosts = policy.hosts ?? new Set<string>();
  const methods = ['GET', 'POST', 'PATCH', 'DELETE'];
  const headers = ['authorization', 'content-type'];
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (!response.headersSent) {
        const failure = error instanceof ServiceError
          ? error : new ServiceError('INTERNAL_ERROR', 'The data service could not complete this request.', 500);
        send(response, failure.status, { error: { code: failure.code, message: failure.message } });
      } else {
        response.destroy();
      }
    });
  });

  function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host;
    if (!host || !hosts.has(host.toLowerCase())) {
      throw new ServiceError('INVALID_HOST', 'Use a configured service address.', 403);
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !policy.origins.has(origin)) {
      throw new ServiceError('INVALID_ORIGIN', 'This origin is not allowed.', 403);
    }
    response.setHeader('Vary', 'Origin');
    if (origin !== undefined) response.setHeader('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') {
      const method = request.headers['access-control-request-method'];
      const requestedHeaders = request.headers['access-control-request-headers'] ?? '';
      if (origin === undefined || typeof method !== 'string' || !methods.includes(method)
        || typeof requestedHeaders !== 'string' || requestedHeaders.split(',').some(value => value.trim() && !headers.includes(value.trim().toLowerCase()))) {
        throw new ServiceError('INVALID_PREFLIGHT', 'Request an allowed method and headers from a configured origin.', 403);
      }
      response.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      response.setHeader('Access-Control-Allow-Headers', headers.join(', '));
      response.setHeader('Cache-Control', 'no-store');
      response.writeHead(204).end();
      return;
    }
    const auth = Buffer.from(request.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      throw new ServiceError('UNAUTHORIZED', 'A valid access token is required.', 401);
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/calculations/refresh' && request.method === 'POST') {
      await readJson(request);
      send(response, 200, service.refreshCalculations());
      return;
    }
    const attachment = url.pathname.match(/^\/tables\/([^/]+)\/attachments(?:\/([^/]+)(?:\/(content))?)?$/);
    if (attachment) {
      const [, tableId, id, content] = attachment;
      if (!id && request.method === 'POST') {
        send(response, 201, service.uploadAttachment(tableId!, await readJson(request, Math.ceil(maxAttachmentBytes / 3) * 4 + 4096)));
      } else if (id === 'query' && request.method === 'POST' && !content) {
        send(response, 200, service.listAttachments(tableId!, await readJson(request)));
      } else if (id && request.method === 'GET' && content) {
        const file = service.downloadAttachment(tableId!, id);
        const filename = encodeURIComponent(file.metadata.filename).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
          'Content-Length': file.bytes.byteLength, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${filename}` });
        response.end(file.bytes);
      } else if (id && request.method === 'GET' && !content) send(response, 200, service.getAttachment(tableId!, id));
      else if (id && request.method === 'DELETE' && !content) { service.deleteAttachment(tableId!, id); send(response, 200, { deleted: id }); }
      else throw new ServiceError('NOT_FOUND', 'This endpoint does not exist.', 404);
      return;
    }
    const undo = url.pathname.match(/^\/tables\/([^/]+)\/batches\/([^/]+)\/undo$/);
    if (undo && request.method === 'POST') {
      await readJson(request);
      send(response, 200, service.undoRecordBatch(undo[1]!, undo[2]!));
      return;
    }
    const batches = url.pathname.match(/^\/tables\/([^/]+)\/batches\/([^/]+)$/);
    if (batches && request.method === 'POST') {
      const input = await readJson(request);
      send(response, 200, batches[2] === 'query' ? service.recordBatches(batches[1]!, input) : service.recordBatchChanges(batches[1]!, batches[2]!, input));
      return;
    }
    const trash = url.pathname.match(/^\/tables\/([^/]+)\/trash\/(query|restore)$/);
    if (trash && request.method === 'POST') {
      const input = await readJson(request);
      send(response, 200, trash[2] === 'query' ? service.recordTrash(trash[1]!, input) : service.restoreDeletedRecords(trash[1]!, input));
      return;
    }
    const history = url.pathname.match(/^\/tables\/([^/]+)\/records\/([^/]+)\/(history|restore)(?:\/([^/]+))?$/);
    if (history) {
      const [, tableId, recordId, action, changeId] = history;
      if (action === 'history' && changeId && request.method === 'GET') {
        send(response, 200, service.recordChange(tableId!, recordId!, Number(changeId)));
      } else if (action === 'history' && !changeId && request.method === 'POST') {
        send(response, 200, service.recordHistory(tableId!, recordId!, await readJson(request)));
      } else if (action === 'restore' && !changeId && request.method === 'POST') {
        send(response, 200, service.restoreRecord(tableId!, recordId!, await readJson(request)));
      } else throw new ServiceError('NOT_FOUND', 'This endpoint does not exist.', 404);
      return;
    }
    const view = url.pathname.match(/^\/tables\/([^/]+)\/views(?:\/([^/]+)(?:\/(query))?)?$/);
    if (view) {
      const id = view[1]!;
      const viewId = view[2];
      if (!viewId && request.method === 'GET') send(response, 200, service.listViews(id));
      else if (!viewId && request.method === 'POST') send(response, 201, service.createView(id, await readJson(request)));
      else if (viewId && view[3] && request.method === 'POST') send(response, 200, service.queryView(id, viewId, await readJson(request)));
      else if (viewId && !view[3] && request.method === 'GET') send(response, 200, service.getView(id, viewId));
      else if (viewId && !view[3] && request.method === 'PATCH') send(response, 200, service.updateView(id, viewId, await readJson(request)));
      else if (viewId && !view[3] && request.method === 'DELETE') {
        service.deleteView(id, viewId, await readJson(request));
        send(response, 200, { deleted: viewId });
      } else throw new ServiceError('NOT_FOUND', 'This endpoint does not exist.', 404);
      return;
    }
    const query = url.pathname.match(/^\/tables\/([^/]+)\/query$/);
    if (query && request.method === 'POST') {
      send(response, 200, service.queryRecords(query[1]!, await readJson(request)));
      return;
    }
    const summary = url.pathname.match(/^\/tables\/([^/]+)\/summary$/);
    if (summary && request.method === 'POST') {
      send(response, 200, service.summarizeRecords(summary[1]!, await readJson(request)));
      return;
    }
    const csvImport = url.pathname.match(/^\/tables\/([^/]+)\/import(?:\/(preview))?$/);
    if (csvImport && request.method === 'POST') {
      const body = await readJson(request, 64 * 1024 * 1024);
      send(response, csvImport[2] ? 200 : 201, csvImport[2]
        ? service.previewCsv(csvImport[1]!, body) : service.importCsv(csvImport[1]!, body));
      return;
    }
    const csvExport = url.pathname.match(/^\/tables\/([^/]+)\/export$/);
    if (csvExport && request.method === 'POST') {
      const csv = service.exportCsv(csvExport[1]!, await readJson(request));
      response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="rowweave.csv"' });
      response.end(csv);
      return;
    }
    const formulaPreview = url.pathname.match(/^\/tables\/([^/]+)\/formulas\/preview$/);
    if (formulaPreview && request.method === 'POST') {
      send(response, 200, service.previewFormula(formulaPreview[1]!, await readJson(request)));
      return;
    }
    const conversion = url.pathname.match(/^\/tables\/([^/]+)\/fields\/([^/]+)\/conversion\/(preview|apply)$/);
    if (conversion && request.method === 'POST') {
      const operation = conversion[3] === 'preview' ? service.previewConversion.bind(service) : service.applyConversion.bind(service);
      send(response, 200, operation(conversion[1]!, conversion[2]!, await readJson(request)));
      return;
    }
    const match = url.pathname.match(/^\/tables\/([^/]+)(?:\/(records|fields)(?:\/([^/]+))?)?$/);
    const id = match?.[1];
    const resource = match?.[2];
    const fieldId = match?.[3];
    if (url.pathname === '/tables' && request.method === 'GET') {
      send(response, 200, service.listTables());
    } else if (url.pathname === '/tables' && request.method === 'POST') {
      send(response, 201, service.createTable(await readJson(request)));
    } else if (id && !resource && request.method === 'GET') {
      send(response, 200, service.getTable(id));
    } else if (id && !resource && request.method === 'PATCH') {
      send(response, 200, service.updateTable(id, await readJson(request)));
    } else if (id && !resource && request.method === 'DELETE') {
      service.deleteTable(id, await readJson(request));
      send(response, 200, { deleted: id });
    } else if (id && resource === 'fields' && !fieldId && request.method === 'POST') {
      send(response, 201, service.createField(id, await readJson(request)));
    } else if (id && resource === 'fields' && fieldId && request.method === 'PATCH') {
      send(response, 200, service.updateField(id, fieldId, await readJson(request)));
    } else if (id && resource === 'fields' && fieldId && request.method === 'DELETE') {
      send(response, 200, service.deleteField(id, fieldId, await readJson(request)));
    } else if (id && resource === 'records' && !fieldId && request.method === 'GET') {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      send(response, 200, service.readPage(offset, limit, id));
    } else if (id && resource === 'records' && !fieldId && request.method === 'PATCH') {
      send(response, 200, service.updateBatch(await readJson(request), id));
    } else if (id && resource === 'records' && !fieldId && request.method === 'POST') {
      send(response, 201, service.createRecords(id, await readJson(request)));
    } else if (id && resource === 'records' && !fieldId && request.method === 'DELETE') {
      send(response, 200, service.deleteRecords(id, await readJson(request)));
    } else if (id && resource === 'records' && fieldId && request.method === 'GET') {
      send(response, 200, service.getRecord(id, fieldId));
    } else {
      throw new ServiceError('NOT_FOUND', 'This endpoint does not exist.', 404);
    }
  }

  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(policy.port, policy.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine the listening address.');
  const authority = `${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  if (!policy.hosts) hosts.add(authority);
  return {
    url: `http://${authority}`,
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function readJson(request: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ServiceError('INVALID_CONTENT_TYPE', 'Send JSON with Content-Type: application/json.', 415);
  }
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        reject(new ServiceError('PAYLOAD_TOO_LARGE', `The request body exceeds ${maxBytes / 1024 / 1024} MiB.`, 413));
      } else {
        chunks.push(chunk);
      }
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', () => reject(new ServiceError('INVALID_BODY', 'Could not read the request body.')));
  });
  try { return JSON.parse(body.toString('utf8')) as unknown; }
  catch { throw new ServiceError('INVALID_JSON', 'The request body must be valid JSON.'); }
}

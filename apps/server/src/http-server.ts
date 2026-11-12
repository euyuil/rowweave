import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { RecordService, ServiceError } from '../../../packages/core/src/record-service.js';

export interface ServerOptions {
  service: RecordService;
  token: string;
  port?: number;
}

export async function startServer({ service, token, port = 0 }: ServerOptions) {
  if (token.length < 32) throw new Error('Use an access token of at least 32 characters.');
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
    const address = server.address();
    if (!address || typeof address === 'string' || host !== `127.0.0.1:${address.port}`) {
      throw new ServiceError('INVALID_HOST', 'Use the loopback service address.', 403);
    }
    if (request.headers.origin && request.headers.origin !== 'null') {
      throw new ServiceError('INVALID_ORIGIN', 'This origin is not allowed.', 403);
    }
    if (request.headers.origin === 'null') {
      response.setHeader('Access-Control-Allow-Origin', 'null');
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.writeHead(204).end();
      return;
    }
    const auth = Buffer.from(request.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      throw new ServiceError('UNAUTHORIZED', 'A valid access token is required.', 401);
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
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
    } else {
      throw new ServiceError('NOT_FOUND', 'This endpoint does not exist.', 404);
    }
  }

  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine the listening address.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ServiceError('INVALID_CONTENT_TYPE', 'Send JSON with Content-Type: application/json.', 415);
  }
  const maxBytes = 8 * 1024 * 1024;
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        reject(new ServiceError('PAYLOAD_TOO_LARGE', 'The request body exceeds 8 MiB.', 413));
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

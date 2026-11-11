import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { tableId } from '../../../packages/contracts/src/index.js';
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
      response.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.writeHead(204).end();
      return;
    }
    const auth = Buffer.from(request.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      throw new ServiceError('UNAUTHORIZED', 'A valid access token is required.', 401);
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const root = `/tables/${tableId}`;
    if (request.method === 'GET' && url.pathname === root) {
      send(response, 200, service.getTable());
    } else if (request.method === 'GET' && url.pathname === `${root}/records`) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      send(response, 200, service.readPage(offset, limit));
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

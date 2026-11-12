import { request } from 'node:http';

// Node fetch owns the Host header; use HTTP directly to verify configured authorities.
export function httpRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: options.method ?? 'GET', headers: options.headers }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(chunk as Buffer));
      incoming.once('error', reject);
      incoming.once('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), { status: incoming.statusCode!, headers }));
      });
    });
    outgoing.once('error', reject);
    outgoing.end(options.body);
  });
}

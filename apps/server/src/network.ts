import { isIP } from 'node:net';

export interface NetworkOptions {
  host?: string;
  port?: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

export function networkPolicy({ host = '127.0.0.1', port = 0, allowedHosts, allowedOrigins }: NetworkOptions) {
  if (!isIP(host)) throw new Error('ROWWEAVE_HOST must be an IPv4 or IPv6 bind address.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ROWWEAVE_PORT must be an integer from 0 to 65535.');
  const local = host === '127.0.0.1' || host === '::1';
  if (!local && !allowedHosts?.length) throw new Error('Set ROWWEAVE_ALLOWED_HOSTS when binding beyond loopback.');
  const hosts = allowedHosts === undefined ? undefined : new Set(allowedHosts.map(value => {
    try {
      const url = new URL('http://' + value);
      if (!value || /[\s/*?#@\\]/.test(value) || url.pathname !== '/' || url.username || url.password) throw new Error();
      return value.toLowerCase();
    } catch { throw new Error('ROWWEAVE_ALLOWED_HOSTS must contain exact host names with optional ports, without schemes or paths.'); }
  }));
  if (hosts?.size === 0) throw new Error('ROWWEAVE_ALLOWED_HOSTS must not be empty.');
  const origins = new Set(allowedOrigins ?? (local ? ['null'] : []));
  for (const origin of origins) {
    if (origin === 'null') continue;
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || origin.includes('*')) throw new Error();
    } catch { throw new Error('ROWWEAVE_ALLOWED_ORIGINS must contain exact HTTP(S) origins or null, without paths or wildcards.'); }
  }
  return { host, port, hosts, origins };
}

import { maxUrlLength } from '../../contracts/src/index.js';

export function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > maxUrlLength || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.username || url.password || url.href.length > maxUrlLength ? undefined : url.href;
  } catch { return undefined; }
}

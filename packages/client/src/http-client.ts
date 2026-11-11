import { tableId, type BatchResult, type RecordPage, type RecordUpdate, type Table } from '../../contracts/src/index.js';

export interface Connection {
  url: string;
  token: string;
}

export interface TableApi {
  getTable(): Promise<Table>;
  readPage(offset: number, limit: number): Promise<RecordPage>;
  save(updates: RecordUpdate[]): Promise<BatchResult>;
}

export class ApiFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export function createHttpClient(connection: Connection, request: typeof fetch = fetch): TableApi {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await request(`${connection.url}/tables/${tableId}${path}`, {
      ...init, signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    });
    const body = await response.json();
    if (!response.ok) {
      throw new ApiFailure(body.error?.code ?? 'REQUEST_FAILED', body.error?.message ?? 'Request failed.', response.status);
    }
    return body as T;
  }
  return {
    getTable: () => call<Table>(''),
    readPage: (offset, limit) => call<RecordPage>(`/records?offset=${offset}&limit=${limit}`),
    save: updates => call<BatchResult>('/records', { method: 'PATCH', body: JSON.stringify(updates) }),
  };
}

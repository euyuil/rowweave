import { ServiceError } from './errors.js';

export function schemaObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError('INVALID_SCHEMA', 'Expected a schema operation object.');
  }
  return input as Record<string, unknown>;
}

export function schemaName(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 200) {
    throw new ServiceError('INVALID_SCHEMA', 'Names must contain between 1 and 200 characters.');
  }
  return input.trim();
}

export function schemaVersion(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ServiceError('INVALID_SCHEMA', 'A positive expectedVersion is required.');
  }
  return input as number;
}

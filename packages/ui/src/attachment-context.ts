import { createContext } from 'react';
import type { Table } from '../../contracts/src/index.js';

export const AttachmentContext = createContext<{
  table: Table | undefined;
  pending: boolean;
  transfer(delta: number): void;
  saveFile(filename: string, bytes: Uint8Array): Promise<boolean | 'download-started'>;
} | undefined>(undefined);

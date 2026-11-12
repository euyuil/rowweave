import { createContext } from 'react';
import type { WorkspaceApi } from '../../client/src/http-client.js';

export const WorkspaceContext = createContext<WorkspaceApi | undefined>(undefined);

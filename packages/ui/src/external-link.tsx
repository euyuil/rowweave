import React, { createContext, useContext, useState } from 'react';
import { webUrl } from '../../core/src/web-url.js';

export const ExternalLinkContext = createContext<(url: string) => Promise<void>>(undefined!);

export function ExternalLink({ value }: { value: unknown }) {
  const open = useContext(ExternalLinkContext);
  const [error, setError] = useState<string>();
  const url = webUrl(value);
  if (!url) return null;
  return <div className="external-link"><button type="button" title={url} onClick={() => {
    setError(undefined);
    void open(url).catch(error => setError(error.message));
  }}>Open link ↗</button>{error && <small role="alert" className="form-error">{error}</small>}</div>;
}

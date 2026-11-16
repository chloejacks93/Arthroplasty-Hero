import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Fetch `url` and re-fetch when it changes. Ignores out-of-order responses. */
export function useApi(url) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  useEffect(() => {
    if (!url) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get(url).then(
      (data) => id === seq.current && setState({ data, error: null, loading: false }),
      (error) => id === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
  }, [url]);
  return state;
}

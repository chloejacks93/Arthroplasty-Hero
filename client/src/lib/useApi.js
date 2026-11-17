import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Fetch `url` and re-fetch when it changes. Ignores out-of-order responses. */
export function useApi(url) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!url) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get(url).then(
      (data) => id === seq.current && setState({ data, error: null, loading: false }),
      (error) => id === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
  }, [url, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// Shared lookup data (teams, facilities, users, nav counts). Components call
// refreshMeta() after changes that affect the counts.
let metaCache = null;
const metaListeners = new Set();
export function refreshMeta() {
  return api.get('/meta').then((m) => {
    metaCache = m;
    metaListeners.forEach((fn) => fn(m));
    return m;
  }).catch(() => null);
}
export function useMeta() {
  const [meta, setMeta] = useState(metaCache);
  useEffect(() => {
    metaListeners.add(setMeta);
    if (!metaCache) refreshMeta();
    return () => metaListeners.delete(setMeta);
  }, []);
  return meta;
}

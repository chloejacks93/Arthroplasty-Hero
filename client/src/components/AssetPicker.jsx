import { useEffect, useState } from 'react';
import { ScanLine, Search, ArrowRight, AlertTriangle } from 'lucide-react';
import { api, qs } from '../lib/api.js';
import { QrScanner } from './QrScanner.jsx';
import { StatusBadge } from './StatusBadge.jsx';

/**
 * Choose an asset by scanning its existing QR label (default) or searching.
 * onPick(asset, { scan }) receives the asset summary and the scan response.
 */
export function AssetPicker({ onPick, allowOutOfScope = false, hint }) {
  const [mode, setMode] = useState('scan');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);

  const onScan = async (value) => {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.post('/qr/scan', { value, source: 'camera' });
      if (r.status === 'unknown') {
        setMsg('That label is not linked to an asset yet. Search for the asset instead, or link the label from Scan Asset.');
      } else if (!r.asset.in_scope && !allowOutOfScope) {
        setMsg(`${r.asset.reference} belongs to another team (${r.asset.team_name || 'unassigned'}). Use “Report a problem” if you have it.`);
      } else {
        onPick(r.asset, { scan: r });
        return;
      }
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (mode !== 'search') return undefined;
    const t = setTimeout(() => {
      api.get(`/assets${qs({ q, pageSize: 12, sort: 'reference' })}`).then((d) => setItems(d.items)).catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, mode]);

  return (
    <div className="picker">
      <div className="seg-toggle" role="tablist">
        <button role="tab" aria-selected={mode === 'scan'} className={mode === 'scan' ? 'on' : ''} onClick={() => { setMode('scan'); setMsg(''); }}>
          <ScanLine aria-hidden /> Scan label
        </button>
        <button role="tab" aria-selected={mode === 'search'} className={mode === 'search' ? 'on' : ''} onClick={() => { setMode('search'); setMsg(''); }}>
          <Search aria-hidden /> Search
        </button>
      </div>
      {hint && <p className="muted picker-hint">{hint}</p>}
      {msg && <div className="notice amber"><AlertTriangle aria-hidden /><span>{msg}</span></div>}
      {mode === 'scan' ? (
        <>
          <QrScanner onResult={onScan} paused={busy} />
          {msg && <button className="btn btn-block" onClick={() => setMsg('')}>Scan again</button>}
        </>
      ) : (
        <>
          <div className="search-inline">
            <Search aria-hidden />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tray name, lot, serial or facility" autoFocus autoComplete="off" aria-label="Search assets" />
          </div>
          <ul className="pick-list">
            {items === null && <li className="subtle">Loading…</li>}
            {items?.length === 0 && <li className="subtle">No matching assets.</li>}
            {items?.map((a) => (
              <li key={a.id}>
                <button onClick={() => onPick(a, {})}>
                  <span className="stacked">
                    <span className="cell-primary">{a.reference}</span>
                    <span className="cell-sub">{a.asset_code} · {a.facility_name || 'No location'}{a.rep_name ? ` · ${a.rep_name}` : ''}</span>
                  </span>
                  <span className="pick-right"><StatusBadge status={a.status} /><ArrowRight size={14} className="subtle" aria-hidden /></span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

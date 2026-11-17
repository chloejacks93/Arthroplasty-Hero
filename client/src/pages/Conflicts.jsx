import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, GitCompareArrows } from 'lucide-react';
import { api, qs } from '../lib/api.js';
import { useApi, refreshMeta } from '../lib/useApi.js';
import { fmtDateTime, relTime } from '../lib/format.js';

export default function Conflicts() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'open';
  const severity = params.get('severity') || '';
  const assetId = params.get('asset_id') || '';
  const { data, error, loading, reload } = useApi(`/conflicts${qs({ status, severity, asset_id: assetId })}`);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const items = data?.items || [];
  const openItems = useMemo(() => items.filter((c) => c.status === 'open'), [items]);
  const set = (k, v) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); setParams(n, { replace: true }); setSelected(new Set()); };
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allChecked = openItems.length > 0 && openItems.every((c) => selected.has(c.id));

  const resolve = async (ids, choice) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post('/conflicts/resolve', { ids, choice });
      setMsg({ tone: 'green', text: `${r.resolved} conflict${r.resolved > 1 ? 's' : ''} resolved: ${choice === 'use_proposed' ? 'spreadsheet value applied' : 'current value kept'}.` });
      setSelected(new Set());
      reload();
      refreshMeta();
    } catch (e) {
      setMsg({ tone: 'red', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import conflicts</h1>
          <p>Spreadsheet values that disagree with the live record. Nothing here was applied until someone decides.</p>
        </div>
      </div>
      {msg && <div className={`notice ${msg.tone}`} style={{ marginBottom: 16 }}>{msg.tone === 'green' ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}{msg.text}</div>}
      {error && <div className="notice red" style={{ marginBottom: 16 }}>{error.message}</div>}

      <section className="panel table-panel">
        <div className="toolbar">
          <select className="select select-sm" value={status} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)} aria-label="Status">
            <option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option>
          </select>
          <select className="select select-sm" value={severity} onChange={(e) => set('severity', e.target.value)} aria-label="Severity">
            <option value="">All fields</option><option value="critical">Location, team, rep</option><option value="normal">Other fields</option>
          </select>
          {assetId && <button className="chip-clear" onClick={() => set('asset_id', '')}>Showing one asset · clear</button>}
          <span className="spacer" />
          {selected.size > 0 && (
            <div className="bulk">
              <span className="muted">{selected.size} selected</span>
              <button className="btn btn-sm" disabled={busy} onClick={() => resolve([...selected], 'keep_current')}>Keep current</button>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => resolve([...selected], 'use_proposed')}>Use spreadsheet</button>
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="data responsive">
            <thead>
              <tr>
                {status !== 'resolved' && (
                  <th style={{ width: 36 }}>
                    <input type="checkbox" className="check" checked={allChecked} disabled={!openItems.length}
                      onChange={() => setSelected(allChecked ? new Set() : new Set(openItems.map((c) => c.id)))} aria-label="Select all" />
                  </th>
                )}
                <th>Asset</th><th>Field</th><th>Current (live) → Spreadsheet</th><th>Source</th><th className="right">{status === 'open' ? 'Decide' : 'Outcome'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  {status !== 'resolved' && (
                    <td data-hide-mobile="">
                      {c.status === 'open' && <input type="checkbox" className="check" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.reference} ${c.field_label}`} />}
                    </td>
                  )}
                  <td className="m-primary"><span className="stacked"><Link to={`/assets/${c.asset_id}`} className="cell-primary">{c.reference}</Link><span className="cell-sub mono">{c.asset_code}</span></span></td>
                  <td className="m-status">
                    <span className={`badge ${c.severity === 'critical' ? 'red' : 'amber'}`}>{c.field_label}</span>
                  </td>
                  <td className="m-full" data-label="Change">
                    <span className="stacked cmp">
                      <span className="cmp-cur" title={c.current_value || ''}>{c.current_value ?? <span className="subtle">empty</span>}</span>
                      <span className="cmp-new" title={c.proposed_value || ''}><ArrowRight size={12} aria-hidden /> {c.proposed_value ?? <span className="subtle">empty</span>}</span>
                    </span>
                  </td>
                  <td className="m-full" data-label="Source"><span className="stacked"><span className="muted trunc">{c.filename || '—'}</span><span className="cell-sub">Row {c.row_number} · {relTime(c.created_at)}</span></span></td>
                  <td className="right m-full">
                    {c.status === 'open' ? (
                      <div className="seg right-seg">
                        <button className="btn btn-sm" disabled={busy} onClick={() => resolve([c.id], 'keep_current')}>Keep current</button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => resolve([c.id], 'use_proposed')}>Use spreadsheet</button>
                      </div>
                    ) : (
                      <span className="stacked"><span>{c.resolved_value === c.proposed_value ? 'Spreadsheet applied' : 'Current kept'}</span>
                        <span className="cell-sub">{c.resolved_by_name} · {fmtDateTime(c.resolved_at)}</span></span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <div className="empty">
              <GitCompareArrows aria-hidden />
              <strong>{status === 'open' ? 'No open conflicts' : 'Nothing to show'}</strong>
              {status === 'open' ? 'Every imported value agrees with the live registry.' : 'Try a different filter.'}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

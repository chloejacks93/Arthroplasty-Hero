import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, MapPin, User, ArrowLeftRight, X, ScanLine, Search, Plus, PackageCheck } from 'lucide-react';
import { api, qs } from '../lib/api.js';
import { useMeta, refreshMeta } from '../lib/useApi.js';
import { useAuth } from '../lib/auth.jsx';
import { QrScanner } from '../components/QrScanner.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { FACILITY_TYPE } from '../lib/format.js';

const REASONS = ['Case coverage', 'Return to warehouse', 'Rebalancing inventory', 'Requested by another rep'];
const TYPE_ORDER = ['warehouse', 'hospital', 'surgery_center', 'clinic', 'other'];
const MAX_TRAYS = 100;

/**
 * Transfer one or many trays in one action.
 * Scan labels one after another (or search) to build the list, then choose
 * destination + receiving rep once. Each tray gets its own transfer and receipt.
 */
export default function Transfer() {
  const { user } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState([]); // [{ ...asset summary, problem? }]
  const [mode, setMode] = useState('scan');
  const [flash, setFlash] = useState(null); // { tone, text }
  const [facility, setFacility] = useState('');
  const [recipient, setRecipient] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const say = (tone, text) => setFlash({ tone, text, at: Date.now() });

  const add = useCallback((a) => {
    if (itemsRef.current.some((x) => x.id === a.id)) return say('amber', `${a.reference} is already in the list.`);
    if (itemsRef.current.length >= MAX_TRAYS) return say('amber', `Up to ${MAX_TRAYS} trays per transfer.`);
    setItems((cur) => [...cur, { ...a, problem: null }]);
    say('green', `Added ${a.reference}`);
    setErr('');
  }, []);

  // Pre-load a tray when opened from an asset page or scan result (?asset=…)
  const preload = params.get('asset');
  useEffect(() => {
    if (!preload) return;
    api.get(`/assets/${preload}`).then((d) => {
      if (d.openTransfer) say('amber', `${d.asset.reference} is already in transit to ${d.openTransfer.recipient_name}.`);
      else add(d.asset);
    }).catch(() => {});
    setParams({}, { replace: true });
  }, [preload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScan = useCallback(async (value) => {
    try {
      const r = await api.post('/qr/scan', { value, source: 'camera' });
      if (r.status === 'unknown') return say('amber', 'That label isn’t linked to an asset yet. Use Search to add the tray.');
      if (!r.asset.in_scope) return say('red', `${r.asset.reference} belongs to another team (${r.asset.team_name || 'unassigned'}). It can’t be sent from here.`);
      if (r.openTransfer) return say('red', `${r.asset.reference} is already in transit to ${r.openTransfer.recipient_name}.`);
      add(r.asset);
    } catch (e) {
      say('red', e.message);
    }
  }, [add]);

  const facilityGroups = useMemo(() => {
    const g = {};
    for (const f of meta?.facilities || []) (g[f.facility_type] ||= []).push(f);
    return TYPE_ORDER.filter((t) => g[t]).map((t) => [t, g[t]]);
  }, [meta]);
  const people = useMemo(() => {
    const u = (meta?.users || []).filter((x) => x.id !== user.id);
    return { reps: u.filter((x) => x.role === 'rep'), others: u.filter((x) => x.role !== 'rep') };
  }, [meta, user.id]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.post('/transfers', {
        asset_ids: items.map((a) => a.id), to_facility_id: facility, recipient_id: recipient, reason: reason.trim() || undefined,
      });
      setDone(r);
      setItems([]);
      refreshMeta();
    } catch (e2) {
      const problems = e2.details?.problems || [];
      if (problems.length) {
        setItems((cur) => cur.map((a) => ({ ...a, problem: problems.find((p) => p.asset_id === a.id)?.reason || null })));
        setErr(`${problems.length} tray${problems.length > 1 ? 's' : ''} can’t be sent (marked below). Remove ${problems.length > 1 ? 'them' : 'it'} and try again.`);
      } else setErr(e2.message);
    } finally { setBusy(false); }
  };

  if (done) {
    const t = done.transfers;
    const toMe = t[0].recipient_id === user.id;
    return (
      <div className="flow-page">
        <section className="panel flow-panel">
          <div className="done-state">
            <CheckCircle2 aria-hidden />
            <strong>{t.length === 1 ? `${t[0].reference} is in transit` : `${t.length} trays are in transit`}</strong>
            <span>To <b>{t[0].to_facility}</b>{done.shipment ? ` · shipment S-${done.shipment.batch_no}` : ''}. {toMe
              ? 'Scan each tray when you arrive to confirm receipt.'
              : <>{t[0].recipient_name} has been notified and must scan {t.length === 1 ? 'it' : 'each tray'} to confirm receipt.</>}</span>
            {t.length > 1 && <ul className="done-list">{t.map((x) => <li key={x.id}>{x.reference}</li>)}</ul>}
            <div className="seg" style={{ justifyContent: 'center' }}>
              <button className="btn btn-lg" onClick={() => navigate('/')}>Done</button>
              <button className="btn btn-primary btn-lg" onClick={() => { setDone(null); setFacility(''); setRecipient(''); setReason(''); }}>Send more</button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="flow-page">
      <div className="page-head">
        <div>
          <h1>Transfer</h1>
          <p>Scan every tray you’re sending, then choose where they’re going once. Each stays <strong>In Transit</strong> until the receiver scans it.</p>
        </div>
      </div>

      <div className="transfer-layout">
        <section className="panel">
          <div className="panel-head"><h2>1 · Add trays</h2><span className="meta">{items.length} added</span></div>
          <div className="panel-body picker">
            <div className="seg-toggle" role="tablist">
              <button role="tab" aria-selected={mode === 'scan'} className={mode === 'scan' ? 'on' : ''} onClick={() => setMode('scan')}><ScanLine aria-hidden /> Scan labels</button>
              <button role="tab" aria-selected={mode === 'search'} className={mode === 'search' ? 'on' : ''} onClick={() => setMode('search')}><Search aria-hidden /> Search</button>
            </div>
            {mode === 'scan' ? <QrScanner onResult={onScan} paused={busy} continuous /> : <SearchAdd onAdd={add} inList={items} />}
            {flash && <div key={flash.at} className={`notice ${flash.tone} flash`} role="status">{flash.tone === 'green' ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}<span>{flash.text}</span></div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>2 · Trays to send</h2>
            {items.length > 0 && <button className="linkish" onClick={() => { setItems([]); setErr(''); }}>Clear all</button>}
          </div>
          {items.length === 0 ? (
            <div className="empty"><PackageCheck aria-hidden /><strong>No trays yet</strong>Scan each tray’s label. They’ll appear here.</div>
          ) : (
            <ul className="basket">
              {items.map((a, i) => (
                <li key={a.id} className={a.problem ? 'bad' : ''}>
                  <span className="b-n num">{i + 1}</span>
                  <div className="b-main">
                    <strong>{a.reference}</strong>
                    <span className="as-meta"><span><MapPin size={12} aria-hidden /> {a.facility_name || 'No location'}</span><span><User size={12} aria-hidden /> {a.custodian_name || a.rep_name || '—'}</span></span>
                    {a.problem && <span className="b-problem"><AlertTriangle size={12} aria-hidden /> {a.problem}</span>}
                  </div>
                  <StatusBadge status={a.status} />
                  <button className="icon-btn" aria-label={`Remove ${a.reference}`} onClick={() => setItems((cur) => cur.filter((x) => x.id !== a.id))}><X /></button>
                </li>
              ))}
            </ul>
          )}

          {items.length > 0 && (
            <form onSubmit={submit} className="flow-form" style={{ borderTop: '1px solid var(--border)' }}>
              <h2 className="form-title">3 · Where are they going?</h2>
              <div className="field">
                <label htmlFor="dest">Destination facility</label>
                <select id="dest" className="select select-lg" value={facility} onChange={(e) => setFacility(e.target.value)} required>
                  <option value="" disabled>Choose a facility…</option>
                  {facilityGroups.map(([type, list]) => (
                    <optgroup key={type} label={FACILITY_TYPE[type]}>{list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</optgroup>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rcpt">Receiving representative</label>
                <select id="rcpt" className="select select-lg" value={recipient} onChange={(e) => setRecipient(e.target.value)} required>
                  <option value="" disabled>Who will receive {items.length > 1 ? 'them' : 'it'}?</option>
                  <option value={user.id}>Me ({user.full_name}): I’m taking {items.length > 1 ? 'them' : 'it'} there</option>
                  <optgroup label="Representatives">{people.reps.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</optgroup>
                  {people.others.length > 0 && <optgroup label="Inventory & management">{people.others.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</optgroup>}
                </select>
              </div>
              <div className="field">
                <label htmlFor="why">Reason <span className="subtle">(optional)</span></label>
                <div className="chips">
                  {REASONS.map((r) => <button type="button" key={r} className={`chip${reason === r ? ' on' : ''}`} onClick={() => setReason(reason === r ? '' : r)}>{r}</button>)}
                </div>
                <input id="why" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type a reason" maxLength={300} />
              </div>
              {err && <div className="form-error" role="alert">{err}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || !facility || !recipient || items.some((a) => a.problem)}>
                <ArrowLeftRight aria-hidden /> {busy ? 'Starting…' : items.length === 1 ? 'Start transfer' : `Start transfer of ${items.length} trays`}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

function SearchAdd({ onAdd, inList }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get(`/assets${qs({ q, pageSize: 12, sort: 'reference' })}`).then((d) => setList(d.items)).catch(() => setList([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const added = new Set(inList.map((a) => a.id));
  return (
    <>
      <div className="search-inline">
        <Search aria-hidden />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tray name, lot or facility" autoComplete="off" aria-label="Search trays" />
      </div>
      <ul className="pick-list">
        {list === null && <li className="subtle">Loading…</li>}
        {list?.length === 0 && <li className="subtle">No matching trays.</li>}
        {list?.map((a) => {
          const transit = a.status === 'in_transit';
          return (
            <li key={a.id}>
              <button onClick={() => !transit && !added.has(a.id) && onAdd(a)} disabled={transit || added.has(a.id)}>
                <span className="stacked"><span className="cell-primary">{a.reference}</span><span className="cell-sub">{a.asset_code} · {a.facility_name || 'No location'}</span></span>
                <span className="pick-right">
                  {added.has(a.id) ? <span className="tag">Added</span> : transit ? <StatusBadge status="in_transit" /> : <Plus size={16} className="subtle" aria-hidden />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function AssetStrip({ a, onChange }) {
  return (
    <div className="asset-strip">
      <div className="as-main">
        <span className="mono subtle">{a.asset_code}</span>
        <strong>{a.reference}</strong>
        <span className="as-meta">
          <span><MapPin size={13} aria-hidden /> {a.facility_name || 'No location'}</span>
          <span><User size={13} aria-hidden /> {a.custodian_name || a.rep_name || 'No custodian'}</span>
        </span>
      </div>
      <StatusBadge status={a.status} />
      {onChange && <button className="icon-btn" onClick={onChange} aria-label="Choose a different asset" title="Choose a different asset"><X /></button>}
    </div>
  );
}

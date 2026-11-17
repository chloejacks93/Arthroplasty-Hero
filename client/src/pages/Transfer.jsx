import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, MapPin, User, ArrowLeftRight, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useMeta, refreshMeta } from '../lib/useApi.js';
import { useAuth } from '../lib/auth.jsx';
import { AssetPicker } from '../components/AssetPicker.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { FACILITY_TYPE, relTime } from '../lib/format.js';

const REASONS = ['Case coverage', 'Return to warehouse', 'Rebalancing inventory', 'Requested by another rep'];
const TYPE_ORDER = ['warehouse', 'hospital', 'surgery_center', 'clinic', 'other'];

export default function Transfer() {
  const { user } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const assetId = params.get('asset');
  const [asset, setAsset] = useState(null);
  const [openTransfer, setOpenTransfer] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [facility, setFacility] = useState('');
  const [recipient, setRecipient] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => {
    setAsset(null); setOpenTransfer(null); setLoadErr(''); setDone(null); setErr('');
    if (!assetId) return;
    api.get(`/assets/${assetId}`).then((d) => { setAsset(d.asset); setOpenTransfer(d.openTransfer); }).catch((e) => setLoadErr(e.message));
  }, [assetId]);

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
      const r = await api.post('/transfers', { asset_id: asset.id, to_facility_id: facility, recipient_id: recipient, reason: reason.trim() || undefined });
      setDone(r.transfer);
      refreshMeta();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  return (
    <div className="flow-page">
      <div className="page-head">
        <div>
          <h1>Transfer asset</h1>
          <p>The tray stays <strong>In Transit</strong> until the receiving rep scans it and confirms receipt.</p>
        </div>
      </div>

      {!assetId && (
        <section className="panel flow-panel">
          <div className="panel-head"><h2>1 · Which tray or tote?</h2></div>
          <div className="panel-body">
            <AssetPicker onPick={(a) => setParams({ asset: a.id })} />
          </div>
        </section>
      )}

      {assetId && loadErr && <div className="notice red"><AlertTriangle aria-hidden />{loadErr}</div>}
      {assetId && !asset && !loadErr && <div className="center-fill"><div className="spinner" /></div>}

      {asset && !done && (
        <section className="panel flow-panel">
          <AssetStrip a={asset} onChange={() => setParams({})} />
          {openTransfer ? (
            <div className="panel-body">
              <div className="notice amber"><AlertTriangle aria-hidden />
                <span>Already in transit to <strong>{openTransfer.recipient_name}</strong> at {openTransfer.to_facility} (T-{openTransfer.transfer_no}, started {relTime(openTransfer.initiated_at)}). It must be received or cancelled first.</span></div>
              <div className="seg" style={{ marginTop: 12 }}><Link className="btn" to={`/assets/${asset.id}`}>Open asset</Link></div>
            </div>
          ) : (
            <form onSubmit={submit} className="flow-form">
              <div className="field">
                <label htmlFor="dest">Destination facility</label>
                <select id="dest" className="select select-lg" value={facility} onChange={(e) => setFacility(e.target.value)} required>
                  <option value="" disabled>Choose a facility…</option>
                  {facilityGroups.map(([type, list]) => (
                    <optgroup key={type} label={FACILITY_TYPE[type]}>
                      {list.map((f) => <option key={f.id} value={f.id}>{f.name}{f.id === asset.current_facility_id ? ' (current)' : ''}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rcpt">Receiving representative</label>
                <select id="rcpt" className="select select-lg" value={recipient} onChange={(e) => setRecipient(e.target.value)} required>
                  <option value="" disabled>Who will receive it?</option>
                  <option value={user.id}>Me ({user.full_name}): I’m taking it there</option>
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
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || !facility || !recipient}>
                <ArrowLeftRight aria-hidden /> {busy ? 'Starting transfer…' : 'Start transfer'}
              </button>
            </form>
          )}
        </section>
      )}

      {done && (
        <section className="panel flow-panel">
          <div className="done-state">
            <CheckCircle2 aria-hidden />
            <strong>{done.reference} is in transit</strong>
            <span>To <b>{done.to_facility}</b>. {done.recipient_id === user.id
              ? 'Scan it when you arrive to confirm receipt.'
              : <>{done.recipient_name} has been notified and must scan it to confirm receipt.</>}</span>
            <span className="subtle">T-{done.transfer_no} · confirm by {new Date(done.accept_by).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
            <div className="seg" style={{ justifyContent: 'center' }}>
              <button className="btn btn-lg" onClick={() => navigate('/')}>Done</button>
              <button className="btn btn-primary btn-lg" onClick={() => setParams({})}>Transfer another</button>
            </div>
          </div>
        </section>
      )}
    </div>
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


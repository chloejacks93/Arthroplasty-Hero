import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Keyboard, ScanLine, MapPin, PackageCheck, ArrowLeftRight, Flag, User, Users, Clock, ArrowRight, QrCode, Search, CheckCircle2, AlertTriangle, Link2, Send, X,
} from 'lucide-react';
import { api, qs } from '../lib/api.js';
import { useMeta, refreshMeta } from '../lib/useApi.js';
import { QrScanner } from '../components/QrScanner.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { ConfirmModal } from './Receive.jsx';
import * as beep from '../lib/beep.js';
import { ASSET_TYPE, relTime, fmtDateTime } from '../lib/format.js';

export default function Scan() {
  const [params, setParams] = useSearchParams();
  const linkTarget = params.get('link'); // link mode: attach the next scanned code to this asset
  const backTo = params.get('back') === 'unlinked' ? '/unlinked' : null;
  const meta = useMeta();
  const navigate = useNavigate();
  const [phase, setPhase] = useState('scanning'); // scanning | loading | result
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState('');
  const [target, setTarget] = useState(null);

  useEffect(() => {
    if (!linkTarget) return setTarget(null);
    api.get(`/assets/${linkTarget}`).then((d) => setTarget(d.asset)).catch(() => setTarget(null));
  }, [linkTarget]);

  const resolve = useCallback(async (value, source = 'camera') => {
    setPhase('loading');
    setError('');
    try {
      const r = await api.post('/qr/scan', { value, source });
      if (r.status !== 'matched') beep.error(); // capture beep already played
      setResult(r);
      setPhase('result');
    } catch (e) {
      beep.error();
      setError(e.message);
      setPhase('result');
      setResult(null);
    }
  }, []);

  const again = () => { setResult(null); setError(''); setCode(''); setPhase('scanning'); };
  // On phones the result replaces the camera view; bring it into view.
  useEffect(() => { if (phase !== 'scanning') window.scrollTo({ top: 0, behavior: 'smooth' }); }, [phase]);
  const submitManual = (e) => { e.preventDefault(); if (code.trim()) resolve(code, 'manual'); };

  return (
    <div className="scan-page">
      <div className="page-head">
        <div>
          <h1>{linkTarget ? 'Link a QR code' : 'Scan asset'}</h1>
          <p>{linkTarget
            ? <>Scan the existing Arthrex label on <strong>{target ? `${target.asset_code} · ${target.reference}` : 'this asset'}</strong>.</>
            : 'Scan the existing Arthrex QR label on any tray or tote.'}</p>
        </div>
        {linkTarget && (backTo
          ? <Link className="btn" to={backTo}><X aria-hidden /> Back to Missing QR list</Link>
          : <button className="btn" onClick={() => { setParams({}); again(); }}><X aria-hidden /> Exit link mode</button>)}
      </div>

      <div className={`scan-layout${phase !== 'scanning' ? ' has-result' : ''}`}>
        <section className="scan-camera">
          <QrScanner onResult={resolve} paused={phase !== 'scanning'} />
          <div className="scan-manual">
            {!manual ? (
              <button className="btn btn-block btn-lg" onClick={() => setManual(true)}><Keyboard aria-hidden /> Enter code manually</button>
            ) : (
              <form onSubmit={submitManual} className="manual-form">
                <label htmlFor="qrcode" className="sr-only">QR code value</label>
                <input id="qrcode" className="input" placeholder="Paste or type the code on the label" value={code}
                  onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} />
                <button className="btn btn-primary" disabled={!code.trim() || phase === 'loading'}>Look up</button>
              </form>
            )}
          </div>
        </section>

        <section className="scan-result" aria-live="polite">
          {phase === 'scanning' && !result && (
            <div className="panel scan-hint">
              <ScanLine aria-hidden />
              <strong>Ready to scan</strong>
              <span>Hold the phone about 20–30 cm (8–12 in) from the label. It beeps the moment it reads it.</span>
            </div>
          )}
          {phase === 'loading' && <div className="panel scan-hint"><div className="spinner" /><span>Looking up code…</span></div>}
          {phase === 'result' && error && (
            <div className="panel">
              <div className="notice red" style={{ margin: 16 }}><AlertTriangle aria-hidden />{error}</div>
              <div className="panel-foot"><span /><button className="btn btn-primary" onClick={again}>Scan again</button></div>
            </div>
          )}
          {phase === 'result' && result?.status === 'matched' && (
            <MatchedCard r={result} linkTarget={linkTarget} target={target} onAgain={again} facilities={meta?.facilities || []}
              onOpen={() => navigate(`/assets/${result.asset.id}`)}
              onReceived={() => refreshMeta()} />
          )}
          {phase === 'result' && result?.status === 'unknown' && (
            <UnknownCard r={result} canLink={!!meta?.permissions.linkQr} linkTarget={target} backTo={backTo}
              onDone={() => { refreshMeta(); }} onAgain={again} />
          )}
        </section>
      </div>
    </div>
  );
}

function MatchedCard({ r, linkTarget, target, onAgain, onOpen, onReceived, facilities }) {
  const a = r.asset;
  const t = r.openTransfer;
  const navigate = useNavigate();
  const [receiving, setReceiving] = useState(false);
  const [received, setReceived] = useState('');
  const wrongLink = linkTarget && linkTarget !== a.id;
  return (
    <div className="panel asset-card">
      {linkTarget && (
        wrongLink ? (
          <div className="notice red" style={{ margin: '16px 16px 0' }}><AlertTriangle aria-hidden />
            <span>This code already belongs to another asset, so it can't be linked to {target?.asset_code || 'the selected asset'}. One code, one asset.</span></div>
        ) : (
          <div className="notice green" style={{ margin: '16px 16px 0' }}><CheckCircle2 aria-hidden /><span>This code is already linked to this asset.</span></div>
        )
      )}
      <div className="asset-card-head">
        <div className="ac-icon"><QrCode aria-hidden /></div>
        <div className="ac-title">
          <span className="mono subtle">{a.asset_code} · {ASSET_TYPE[a.asset_type]}</span>
          <h2>{a.reference}</h2>
          {a.description && <span className="muted">{a.description}</span>}
        </div>
        <StatusBadge status={a.status} />
      </div>
      <dl className="ac-facts">
        <Fact icon={MapPin} k="Current location" v={a.facility_name || 'Unassigned'} />
        <Fact icon={User} k="Representative" v={a.rep_name || 'Unassigned'} />
        <Fact icon={Users} k="Team" v={a.team_name || '—'} />
        <Fact icon={Clock} k="Previous scan" v={r.previousScanAt ? `${relTime(r.previousScanAt)} · ${fmtDateTime(r.previousScanAt)}` : 'First scan'} />
      </dl>
      {received && <div className="notice green" style={{ margin: '0 16px 16px' }}><CheckCircle2 aria-hidden /><span>{received}</span></div>}
      {t && !received && (
        <div className={`notice ${t.isRecipient ? 'blue' : 'amber'}`} style={{ margin: '0 16px 16px' }}><ArrowLeftRight aria-hidden />
          <span>{t.isRecipient
            ? <>In transit <strong>to you</strong> at {t.to_facility}, sent by {t.sender_name}. Confirm receipt now that you have it.</>
            : <>In transit to <strong>{t.recipient_name}</strong> at {t.to_facility} (T-{t.transfer_no}){t.overdue ? '. Past its receipt deadline' : ''}.</>}</span></div>
      )}
      {!a.in_scope && (
        <div className="notice blue" style={{ margin: '0 16px 16px' }}><AlertTriangle aria-hidden />
          <span>This asset belongs to another team. Your scan has been recorded in its history.</span></div>
      )}
      <div className="ac-actions">
        {t?.isRecipient && !received && (
          <button className="btn btn-primary btn-lg" onClick={() => setReceiving(true)}><PackageCheck aria-hidden /> Confirm receipt</button>
        )}
        {!t && a.in_scope && (
          <button className="btn btn-lg" onClick={() => navigate(`/transfer?asset=${a.id}`)}><ArrowLeftRight aria-hidden /> Transfer</button>
        )}
        <button className="btn btn-lg" onClick={() => navigate(`/report?asset=${a.id}`, { state: { asset: a } })}><Flag aria-hidden /> Report a problem</button>
      </div>
      <div className="ac-foot">
        <span className="subtle"><CheckCircle2 size={13} aria-hidden /> Scan recorded</span>
        <div className="seg">
          {a.in_scope && <button className="btn btn-lg" onClick={onOpen}>Open asset <ArrowRight aria-hidden /></button>}
          <button className="btn btn-primary btn-lg" onClick={onAgain}><ScanLine aria-hidden /> Scan next</button>
        </div>
      </div>
      {receiving && (
        <ConfirmModal
          c={{ transfer: { ...t, reference: a.reference }, qr: r.qr_value }}
          facilities={facilities}
          onClose={() => setReceiving(false)}
          onDone={(msg) => { setReceiving(false); setReceived(msg); onReceived(); }}
        />
      )}
    </div>
  );
}

function UnknownCard({ r, canLink, linkTarget, backTo, onDone, onAgain }) {
  const [q, setQ] = useState('');
  const [includeLinked, setIncludeLinked] = useState(false);
  const [items, setItems] = useState(null);
  const [chosen, setChosen] = useState(linkTarget || null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => { if (linkTarget) setChosen(linkTarget); }, [linkTarget]);
  useEffect(() => {
    if (chosen) return undefined;
    const t = setTimeout(() => {
      api.get(`/assets${qs({ q, qr: includeLinked ? '' : 'none', pageSize: 10, sort: 'reference' })}`)
        .then((d) => setItems(d.items)).catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, includeLinked, chosen]);

  const link = async () => {
    setBusy(true); setErr('');
    try {
      if (canLink) {
        await api.post('/qr/link', { asset_id: chosen.id, value: r.qr_value, replace: !!chosen.qr_value, reason: chosen.qr_value ? reason : undefined });
        setDone('linked');
      } else {
        await api.post('/qr/requests', { asset_id: chosen.id, value: r.qr_value, note: note || undefined });
        setDone('requested');
      }
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="panel">
        <div className="done-state">
          <CheckCircle2 aria-hidden />
          <strong>{done === 'linked' ? 'QR code linked' : 'Link request sent'}</strong>
          <span>{done === 'linked'
            ? <>{chosen.asset_code} · {chosen.reference} will now open whenever this label is scanned.</>
            : 'An inventory lead will confirm the match. Until then this code stays unlinked.'}</span>
          <div className="seg" style={{ justifyContent: 'center' }}>
            {backTo ? (
              <Link className="btn btn-primary btn-lg" to={backTo}>Next tray on the list</Link>
            ) : (
              <>
                {done === 'linked' && <Link className="btn btn-lg" to={`/assets/${chosen.id}`}>Open asset</Link>}
                <button className="btn btn-primary btn-lg" onClick={onAgain}><ScanLine aria-hidden /> Scan next</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head"><h2>Code not linked to an asset yet</h2></div>
      <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
        <div className="qr-value">{r.qr_value}</div>
        {r.pendingRequest && (
          <div className="notice amber"><AlertTriangle aria-hidden />
            <span>{r.pendingRequest.requested_by_name} already asked to link this code to <strong>{r.pendingRequest.asset_code} · {r.pendingRequest.reference}</strong> ({relTime(r.pendingRequest.requested_at)}). It is waiting for confirmation.</span></div>
        )}
        {!chosen ? (
          <>
            <p className="muted" style={{ margin: 0 }}>Which asset is this label on? Search by name, lot or location.</p>
            <div className="search-inline">
              <Search aria-hidden />
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. REVERS INSTR #5A" autoComplete="off" aria-label="Find the asset" />
            </div>
            <label className="check-row">
              <input type="checkbox" className="check" checked={includeLinked} onChange={(e) => setIncludeLinked(e.target.checked)} />
              Include assets that already have a code
            </label>
            <ul className="pick-list">
              {items === null && <li className="subtle">Loading…</li>}
              {items?.length === 0 && <li className="subtle">No matching assets. Try another search, or report it from the asset list.</li>}
              {items?.map((a) => (
                <li key={a.id}>
                  <button onClick={() => setChosen(a)}>
                    <span className="stacked">
                      <span className="cell-primary">{a.reference}</span>
                      <span className="cell-sub">{a.asset_code} · {a.facility_name || 'No location'}{a.lot ? ` · Lot ${a.lot}` : ''}</span>
                    </span>
                    {a.qr_value ? <span className="tag">Has code</span> : <ArrowRight size={14} className="subtle" aria-hidden />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="confirm-box">
            <span className="subtle">{canLink ? 'Link this code to' : 'Request to link this code to'}</span>
            <strong>{chosen.asset_code} · {chosen.reference}</strong>
            <span className="muted">{chosen.facility_name || 'No location'}{chosen.rep_name ? ` · ${chosen.rep_name}` : ''}</span>
            {chosen.qr_value && canLink && (
              <>
                <div className="notice amber"><AlertTriangle aria-hidden /><span>This asset already has code <span className="mono">{chosen.qr_value}</span>. Linking replaces it.</span></div>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for replacing (required)" />
              </>
            )}
            {!canLink && <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the inventory lead (optional)" />}
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
      </div>
      <div className="panel-foot">
        {chosen && !linkTarget ? <button className="btn" onClick={() => setChosen(null)} disabled={busy}>Choose another</button> : <button className="btn" onClick={onAgain}>Cancel</button>}
        {chosen && (
          <button className="btn btn-primary" disabled={busy || (chosen.qr_value && canLink && reason.trim().length < 3)} onClick={link}>
            {canLink ? <><Link2 aria-hidden /> Link code</> : <><Send aria-hidden /> Send request</>}
          </button>
        )}
      </div>
    </div>
  );
}

function Fact({ icon: Icon, k, v }) {
  return (
    <div className="ac-fact">
      <Icon aria-hidden />
      <div><dt>{k}</dt><dd>{v}</dd></div>
    </div>
  );
}

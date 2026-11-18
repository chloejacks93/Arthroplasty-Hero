import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Inbox, ScanLine, ArrowRight, Clock, PackageCheck, Boxes } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi, useMeta, refreshMeta } from '../lib/useApi.js';
import { QrScanner } from '../components/QrScanner.jsx';
import { Modal } from '../components/Modal.jsx';
import { FACILITY_TYPE, relTime } from '../lib/format.js';

/**
 * Receive trays sent to you. Scanning a tray that's coming to you confirms it
 * immediately; keep scanning to receive a whole shipment. Trays are grouped by shipment.
 */
export default function Receive() {
  const meta = useMeta();
  const { data, error, reload } = useApi('/transfers?box=incoming&status=in_transit');
  const [where, setWhere] = useState(''); // '' = each tray's planned destination
  const [note, setNote] = useState('');
  const [flash, setFlash] = useState(null);
  const [count, setCount] = useState(0);
  const [confirm, setConfirm] = useState(null); // no-label trays
  const [missing, setMissing] = useState(null);
  const items = useMemo(() => data?.items || [], [data]);
  const busy = useRef(false);

  const groups = useMemo(() => {
    const m = new Map();
    for (const t of items) {
      const k = t.batch_id || t.id;
      if (!m.has(k)) m.set(k, { key: k, batch_no: t.batch_no, size: t.batch_size || 1, sender: t.sender_name, initiated_at: t.initiated_at, to: t.to_facility, items: [] });
      m.get(k).items.push(t);
    }
    return [...m.values()];
  }, [items]);

  const say = (tone, text) => setFlash({ tone, text, at: Date.now() });
  const elsewhere = !!where;

  const onScan = useCallback(async (value) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await api.post('/qr/scan', { value, source: 'camera' });
      if (r.status === 'unknown') return say('amber', 'That label isn’t linked to an asset yet. Confirm it from the list instead.');
      const t = r.openTransfer;
      if (!t) return say('blue', `${r.asset.reference} has nothing waiting for you. It’s recorded at ${r.asset.facility_name || 'no location'}.`);
      if (!t.isRecipient) return say('amber', `${r.asset.reference} is on its way to ${t.recipient_name}, not you. If you have it, report a problem from the asset.`);
      if (elsewhere && note.trim().length < 3) return say('amber', 'Add a short note about where they arrived before scanning.');
      await api.post(`/transfers/${t.id}/receive`, { qr_value: value, facility_id: where || undefined, note: elsewhere ? note.trim() : undefined });
      setCount((n) => n + 1);
      const left = items.filter((x) => x.id !== t.id && (x.batch_id ? x.batch_id === items.find((y) => y.id === t.id)?.batch_id : false)).length;
      say('green', `${r.asset.reference} received.${left ? ` ${left} more in this shipment.` : ''}`);
      reload();
      refreshMeta();
    } catch (e) {
      say('red', e.message);
    } finally {
      busy.current = false;
    }
  }, [items, where, note, elsewhere, reload]);

  const finish = (text) => { setConfirm(null); setMissing(null); say('green', text); reload(); refreshMeta(); };

  return (
    <div className="flow-page">
      <div className="page-head">
        <div>
          <h1>Receive</h1>
          <p>Scan each tray sent to you. Each one is confirmed as you scan it, and its location and custodian update for everyone.</p>
        </div>
      </div>

      <div className="receive-layout">
        <section className="panel flow-panel">
          <div className="panel-head">
            <h2><ScanLine size={15} aria-hidden style={{ verticalAlign: -2, marginRight: 6 }} />Scan to confirm</h2>
            {count > 0 && <span className="badge green">{count} confirmed</span>}
          </div>
          <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
            <div className="field">
              <label htmlFor="rw">Receiving at</label>
              <select id="rw" className="select" value={where} onChange={(e) => setWhere(e.target.value)}>
                <option value="">Each tray’s planned destination</option>
                {(meta?.facilities || []).map((f) => <option key={f.id} value={f.id}>{f.name} · {FACILITY_TYPE[f.facility_type]}</option>)}
              </select>
            </div>
            {elsewhere && (
              <div className="field">
                <label htmlFor="rn">Why here? <span className="subtle">(required; management is notified if it differs from the plan)</span></label>
                <input id="rn" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Delivered to sterile processing at Erlanger" />
              </div>
            )}
            <QrScanner onResult={onScan} paused={!!confirm || !!missing} continuous />
            {flash && <div key={flash.at} className={`notice ${flash.tone} flash`} role="status">{flash.tone === 'green' ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}<span>{flash.text}</span></div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Waiting for you</h2><span className="meta">{items.length} tray{items.length === 1 ? '' : 's'}</span></div>
          {error && <div className="notice red" style={{ margin: 16 }}>{error.message}</div>}
          {data && items.length === 0 && (
            <div className="empty"><Inbox aria-hidden /><strong>Nothing incoming</strong>Transfers sent to you will appear here.</div>
          )}
          {groups.map((g) => (
            <div key={g.key} className="ship">
              {g.batch_no && (
                <div className="ship-head">
                  <Boxes size={15} aria-hidden />
                  <strong>Shipment S-{g.batch_no}</strong>
                  <span className="muted">from {g.sender} · {relTime(g.initiated_at)}</span>
                  <span className="ship-progress">{g.size - g.items.length} of {g.size} received</span>
                </div>
              )}
              <ul className="incoming">
                {g.items.map((t) => (
                  <li key={t.id} className={t.overdue ? 'overdue' : ''}>
                    <div className="in-main">
                      <div className="in-title">
                        <Link to={`/assets/${t.asset_id}`} className="cell-primary">{t.reference}</Link>
                        {t.overdue ? <span className="badge amber">Past deadline</span> : <span className="badge blue">In Transit</span>}
                      </div>
                      <div className="in-route"><span>{t.from_facility || 'Unknown'}</span><ArrowRight size={13} aria-hidden /><strong>{t.to_facility}</strong></div>
                      {!g.batch_no && <div className="cell-sub"><Clock size={12} aria-hidden style={{ verticalAlign: -1 }} /> Sent by {t.sender_name} {relTime(t.initiated_at)}{t.reason ? ` · ${t.reason}` : ''}</div>}
                    </div>
                    <div className="in-actions">
                      {t.has_qr
                        ? <span className="subtle in-hint">Scan its label</span>
                        : <button className="btn btn-primary btn-sm" onClick={() => setConfirm({ transfer: t, qr: null })}><PackageCheck aria-hidden /> Confirm (no label)</button>}
                      <button className="btn btn-sm btn-ghost" onClick={() => setMissing(t)}>Not received</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>

      {confirm && <ConfirmModal c={confirm} facilities={meta?.facilities || []} onClose={() => setConfirm(null)} onDone={finish} />}
      {missing && <NotReceivedModal t={missing} onClose={() => setMissing(null)} onDone={finish} />}
    </div>
  );
}

export function ConfirmModal({ c, facilities, onClose, onDone }) {
  const t = c.transfer;
  const [facility, setFacility] = useState(t.to_facility_id);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const elsewhere = facility !== t.to_facility_id;
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api.post(`/transfers/${t.id}/receive`, { qr_value: c.qr || undefined, facility_id: facility, note: note.trim() || undefined });
      const name = facilities.find((f) => f.id === facility)?.name || t.to_facility;
      onDone(`Receipt confirmed: ${t.reference} is now at ${name} in your custody.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title="Confirm receipt" onClose={onClose}
      actions={<>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || (elsewhere && note.trim().length < 3)}><CheckCircle2 aria-hidden /> {busy ? 'Confirming…' : 'Confirm receipt'}</button>
      </>}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div className="confirm-box">
          <span className="subtle">{c.qr ? 'Label scanned ✓' : 'No QR label linked. Confirming without a scan.'}</span>
          <strong>{t.reference}</strong>
          <span className="muted">From {t.sender_name}{t.from_facility ? ` · ${t.from_facility}` : ''}</span>
        </div>
        <div className="field">
          <label htmlFor="rfac">Received at</label>
          <select id="rfac" className="select select-lg" value={facility} onChange={(e) => setFacility(e.target.value)}>
            {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}{f.id === t.to_facility_id ? ' (planned destination)' : ` · ${FACILITY_TYPE[f.facility_type]}`}</option>)}
          </select>
        </div>
        {elsewhere && <div className="notice amber"><AlertTriangle aria-hidden /><span>This differs from the planned destination. Management will be notified. Please add a note.</span></div>}
        <div className="field">
          <label htmlFor="rnote">Note <span className="subtle">{elsewhere ? '(required)' : '(optional)'}</span></label>
          <input id="rnote" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Received at sterile processing" maxLength={300} />
        </div>
        {err && <div className="form-error">{err}</div>}
      </div>
    </Modal>
  );
}

function NotReceivedModal({ t, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api.post(`/transfers/${t.id}/not-received`, { note });
      onDone(`Reported: ${t.reference} not received. ${t.sender_name} and management have been notified and an investigation was opened.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title="Report not received?" onClose={onClose}
      actions={<>
        <button className="btn" onClick={onClose} disabled={busy}>Back</button>
        <button className="btn btn-danger" onClick={submit} disabled={busy || note.trim().length < 3}>Report not received</button>
      </>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ margin: 0 }}><strong>{t.reference}</strong> will be marked <strong>Under Investigation</strong> and its transfer closed. The rest of its shipment is not affected. {t.sender_name} and management will be notified.</p>
        <div className="field">
          <label htmlFor="nr">What happened?</label>
          <input id="nr" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Not in the delivery" autoFocus />
        </div>
        {err && <div className="form-error">{err}</div>}
      </div>
    </Modal>
  );
}

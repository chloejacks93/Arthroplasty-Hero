import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Inbox, ScanLine, ArrowRight, Clock, PackageCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi, useMeta, refreshMeta } from '../lib/useApi.js';
import { QrScanner } from '../components/QrScanner.jsx';
import { Modal } from '../components/Modal.jsx';
import { FACILITY_TYPE, relTime } from '../lib/format.js';

export default function Receive() {
  const meta = useMeta();
  const { data, error, reload } = useApi('/transfers?box=incoming&status=in_transit');
  const [scanning, setScanning] = useState(true);
  const [scanMsg, setScanMsg] = useState(null);
  const [confirm, setConfirm] = useState(null); // { transfer, qr }
  const [missing, setMissing] = useState(null);
  const [done, setDone] = useState(null);
  const items = useMemo(() => data?.items || [], [data]);

  const onScan = useCallback(async (value) => {
    setScanning(false);
    setScanMsg(null);
    try {
      const r = await api.post('/qr/scan', { value, source: 'camera' });
      if (r.status === 'unknown') {
        setScanMsg({ tone: 'amber', text: 'That label is not linked to an asset yet. Confirm from the list below or ask inventory to link it.' });
      } else if (r.openTransfer?.isRecipient) {
        const t = items.find((x) => x.id === r.openTransfer.id);
        setConfirm({ transfer: t || { ...r.openTransfer, reference: r.asset.reference, asset_code: r.asset.asset_code, asset_id: r.asset.id }, qr: value });
        return;
      } else if (r.openTransfer) {
        setScanMsg({ tone: 'amber', text: `${r.asset.reference} is in transit to ${r.openTransfer.recipient_name}, not you. If you have it, report a problem from the asset.`, assetId: r.asset.id });
      } else {
        setScanMsg({ tone: 'blue', text: `${r.asset.reference} has no transfer waiting for you. It is recorded at ${r.asset.facility_name || 'no location'}.`, assetId: r.asset.id });
      }
    } catch (e) {
      setScanMsg({ tone: 'red', text: e.message });
    }
  }, [items]);

  const finish = (text) => {
    setConfirm(null);
    setMissing(null);
    setDone(text);
    setScanning(true);
    reload();
    refreshMeta();
  };

  return (
    <div className="flow-page">
      <div className="page-head">
        <div>
          <h1>Receive</h1>
          <p>Scan a tray that was sent to you to confirm receipt. Its location and custodian update for everyone.</p>
        </div>
      </div>
      {done && <div className="notice green" style={{ marginBottom: 16 }}><CheckCircle2 aria-hidden /><span>{done}</span></div>}

      <div className="receive-layout">
        <section className="panel flow-panel">
          <div className="panel-head"><h2><ScanLine size={15} aria-hidden style={{ verticalAlign: -2, marginRight: 6 }} />Scan to confirm</h2></div>
          <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
            <QrScanner onResult={onScan} paused={!scanning || !!confirm} />
            {scanMsg && (
              <div className={`notice ${scanMsg.tone}`}><AlertTriangle aria-hidden />
                <span>{scanMsg.text} {scanMsg.assetId && <Link to={`/assets/${scanMsg.assetId}`}>Open asset</Link>}</span></div>
            )}
            {!scanning && !confirm && <button className="btn btn-primary btn-lg btn-block" onClick={() => { setScanning(true); setScanMsg(null); }}><ScanLine aria-hidden /> Scan again</button>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Waiting for you</h2><span className="meta">{items.length} incoming</span></div>
          {error && <div className="notice red" style={{ margin: 16 }}>{error.message}</div>}
          {data && items.length === 0 && (
            <div className="empty"><Inbox aria-hidden /><strong>Nothing incoming</strong>Transfers sent to you will appear here.</div>
          )}
          <ul className="incoming">
            {items.map((t) => (
              <li key={t.id} className={t.overdue ? 'overdue' : ''}>
                <div className="in-main">
                  <div className="in-title">
                    <Link to={`/assets/${t.asset_id}`} className="cell-primary">{t.reference}</Link>
                    {t.overdue ? <span className="badge amber">Past deadline</span> : <span className="badge blue">In Transit</span>}
                  </div>
                  <div className="in-route">
                    <span>{t.from_facility || 'Unknown'}</span><ArrowRight size={13} aria-hidden /><strong>{t.to_facility}</strong>
                  </div>
                  <div className="cell-sub">
                    <Clock size={12} aria-hidden style={{ verticalAlign: -1 }} /> Sent by {t.sender_name} {relTime(t.initiated_at)}{t.reason ? ` · ${t.reason}` : ''}
                  </div>
                </div>
                <div className="in-actions">
                  {t.has_qr
                    ? <span className="subtle in-hint">Scan its label to confirm</span>
                    : <button className="btn btn-primary btn-sm" onClick={() => setConfirm({ transfer: t, qr: null })}><PackageCheck aria-hidden /> Confirm receipt</button>}
                  <button className="btn btn-sm btn-ghost" onClick={() => setMissing(t)}>Not received</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {confirm && <ConfirmModal c={confirm} facilities={meta?.facilities || []} onClose={() => { setConfirm(null); setScanning(true); }} onDone={finish} />}
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
          <span className="muted">From {t.sender_name} · {t.from_facility || 'unknown location'}</span>
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
        <p style={{ margin: 0 }}><strong>{t.reference}</strong> will be marked <strong>Under Investigation</strong> and the transfer closed. {t.sender_name} and management will be notified.</p>
        <div className="field">
          <label htmlFor="nr">What happened?</label>
          <input id="nr" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Not at the hospital loading dock" autoFocus />
        </div>
        {err && <div className="form-error">{err}</div>}
      </div>
    </Modal>
  );
}

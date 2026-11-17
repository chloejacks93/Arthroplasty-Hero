import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, ArrowRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api, qs } from '../lib/api.js';
import { useApi, useMeta, refreshMeta } from '../lib/useApi.js';
import { useAuth, isOrgWide } from '../lib/auth.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { Modal } from '../components/Modal.jsx';
import { fmtDateTime, relTime } from '../lib/format.js';

const STATUS_TABS = [['in_transit', 'In transit'], ['overdue', 'Past deadline'], ['received', 'Received'], ['closed', 'Cancelled / not received'], ['any', 'All']];
const T_BADGE = {
  in_transit: ['In Transit', 'blue'], received: ['Received', 'green'], cancelled: ['Cancelled', 'slate'], rejected: ['Not received', 'red'],
};

export default function Transfers() {
  const { user } = useAuth();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'in_transit';
  const box = params.get('box') || (isOrgWide(user) ? 'all' : 'mine');
  const facility = params.get('facility_id') || '';
  const { data, error, loading, reload } = useApi(`/transfers${qs({ status, box, facility_id: facility })}`);
  const [cancel, setCancel] = useState(null);
  const [msg, setMsg] = useState('');
  const set = (k, v) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); setParams(n, { replace: true }); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transfers</h1>
          <p>Every custody movement, from initiation to confirmed receipt.</p>
        </div>
        <div className="head-actions"><Link to="/transfer" className="btn btn-primary"><ArrowLeftRight aria-hidden /> New transfer</Link></div>
      </div>
      {msg && <div className="notice green" style={{ marginBottom: 16 }}><CheckCircle2 aria-hidden />{msg}</div>}
      {error && <div className="notice red" style={{ marginBottom: 16 }}><AlertTriangle aria-hidden />{error.message}</div>}
      <section className="panel table-panel">
        <div className="tabs scroll-x" role="tablist">
          {STATUS_TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={status === k} className={`tab${status === k ? ' active' : ''}`} onClick={() => set('status', k === 'in_transit' ? '' : k)}>{l}</button>
          ))}
        </div>
        <div className="toolbar">
          <select className="select select-sm" value={box} onChange={(e) => set('box', e.target.value)} aria-label="Whose transfers">
            {isOrgWide(user) && <option value="all">Everyone</option>}
            <option value="mine">{isOrgWide(user) ? 'Mine' : 'My teams & me'}</option>
            <option value="incoming">Sent to me</option>
            <option value="outgoing">Sent by me</option>
          </select>
          <select className="select select-sm" value={facility} onChange={(e) => set('facility_id', e.target.value)} aria-label="Facility">
            <option value="">All facilities</option>
            {meta?.facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <DataTable
          rows={data?.items}
          loading={loading}
          empty={{ title: 'No transfers', body: status === 'overdue' ? 'Nothing is past its receipt deadline.' : 'Nothing matches these filters.' }}
          columns={[
            { key: 'asset', header: 'Asset', mobile: 'primary', render: (t) => (
              <span className="stacked"><Link to={`/assets/${t.asset_id}`} className="cell-primary">{t.reference}</Link><span className="cell-sub mono">T-{t.transfer_no} · {t.asset_code}</span></span>
            ) },
            { key: 'status', header: 'Status', mobile: 'status', render: (t) => (
              <span className="stacked">
                {t.overdue ? <span className="badge amber">Past deadline</span> : <span className={`badge ${T_BADGE[t.status][1]}`}>{T_BADGE[t.status][0]}</span>}
                <span className="cell-sub" title={fmtDateTime(t.initiated_at)}>Started {relTime(t.initiated_at)}</span>
              </span>
            ) },
            { key: 'route', header: 'Route', mobile: 'full', label: 'Route', className: 'wrap-cell', render: (t) => (
              <span className="route">{t.from_facility || '—'} <ArrowRight size={12} aria-hidden /> <strong>{t.received_facility && t.received_facility !== t.to_facility ? t.received_facility : t.to_facility}</strong></span>
            ) },
            { key: 'people', header: 'Sender → Recipient', mobile: 'full', label: 'People', render: (t) => <span>{t.sender_name} <ArrowRight size={12} aria-hidden className="subtle" /> {t.recipient_name}</span> },
            { key: 'outcome', header: 'Outcome', mobile: 'full', label: 'Outcome', className: 'wrap-cell', render: (t) => (
              t.status === 'received' ? <span className="stacked"><span>{t.received_by_name}{t.via_qr_scan ? ' · scanned' : ' · no label'}</span><span className="cell-sub">{fmtDateTime(t.received_at)}</span></span>
                : t.status === 'in_transit' ? <span className="cell-sub">Confirm by {fmtDateTime(t.accept_by)}</span>
                  : <span className="stacked"><span className="trunc" title={t.close_reason}>{t.close_reason}</span><span className="cell-sub">{t.closed_by_name} · {fmtDateTime(t.closed_at)}</span></span>
            ) },
            { key: 'act', header: '', align: 'right', mobile: 'full', render: (t) => (
              t.status === 'in_transit' && (t.sender_id === user.id || meta?.permissions.investigate)
                ? <button className="btn btn-sm btn-ghost" onClick={() => setCancel(t)}>Cancel</button> : null
            ) },
          ]}
        />
      </section>
      {cancel && <CancelModal t={cancel} onClose={() => setCancel(null)} onDone={(m) => { setCancel(null); setMsg(m); reload(); refreshMeta(); }} />}
    </>
  );
}

function CancelModal({ t, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/transfers/${t.id}/cancel`, { note }); onDone(`T-${t.transfer_no} cancelled. ${t.reference} is back to its previous status.`); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={`Cancel transfer T-${t.transfer_no}?`} onClose={onClose}
      actions={<><button className="btn" onClick={onClose}>Keep transfer</button><button className="btn btn-danger" disabled={busy || note.trim().length < 3} onClick={submit}>Cancel transfer</button></>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ margin: 0 }}>{t.reference} will return to its status before the transfer. {t.recipient_name} will be notified.</p>
        <div className="field"><label htmlFor="cn">Reason</label><input id="cn" className="input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="e.g. Case rescheduled" /></div>
        {err && <div className="form-error">{err}</div>}
      </div>
    </Modal>
  );
}

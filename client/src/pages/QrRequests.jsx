import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, QrCode } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi, refreshMeta } from '../lib/useApi.js';
import { relTime, fmtDateTime } from '../lib/format.js';

export default function QrRequests() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'pending';
  const { data, error, loading, reload } = useApi(`/qr/requests?status=${status}`);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const decide = async (r, action) => {
    setBusy(r.id);
    setMsg(null);
    try {
      await api.post(`/qr/requests/${r.id}/${action}`, { replace: action === 'approve' && !!r.asset_current_qr });
      setMsg({ tone: 'green', text: action === 'approve' ? `Linked to ${r.asset_code} · ${r.reference}.` : 'Request rejected. The code stays unlinked.' });
      reload();
      refreshMeta();
    } catch (e) {
      setMsg({ tone: 'red', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>QR link requests</h1>
          <p>Representatives who scan an unlinked label can propose which asset it belongs to. Confirm before it's linked.</p>
        </div>
      </div>
      {msg && <div className={`notice ${msg.tone}`} style={{ marginBottom: 16 }}>{msg.tone === 'green' ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}{msg.text}</div>}
      {error && <div className="notice red" style={{ marginBottom: 16 }}>{error.message}</div>}
      <section className="panel table-panel">
        <div className="toolbar">
          <select className="select select-sm" value={status} onChange={(e) => setParams(e.target.value === 'pending' ? {} : { status: e.target.value }, { replace: true })} aria-label="Status">
            <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="all">All</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="data responsive">
            <thead><tr><th>Scanned code</th><th>Proposed asset</th><th>Requested by</th><th>Note</th><th className="right">{status === 'pending' ? 'Decide' : 'Outcome'}</th></tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id}>
                  <td className="m-full" data-label="Code"><span className="mono">{r.qr_value}</span></td>
                  <td className="m-primary">
                    <span className="stacked">
                      <Link to={`/assets/${r.asset_id}`} className="cell-primary">{r.reference}</Link>
                      <span className="cell-sub">{r.asset_code}{r.asset_current_qr ? ' · already has a code (approving replaces it)' : ''}</span>
                    </span>
                  </td>
                  <td className="m-full" data-label="By"><span className="stacked"><span>{r.requested_by_name}</span><span className="cell-sub">{relTime(r.requested_at)}</span></span></td>
                  <td className="m-full trunc" data-label="Note" title={r.note || ''}>{r.note || <span className="subtle">—</span>}</td>
                  <td className="right m-status">
                    {r.status === 'pending' ? (
                      <div className="seg right-seg">
                        <button className="btn btn-sm" disabled={busy === r.id} onClick={() => decide(r, 'reject')}>Reject</button>
                        <button className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => decide(r, 'approve')}>Approve &amp; link</button>
                      </div>
                    ) : (
                      <span className="stacked">
                        <span className={`badge ${r.status === 'approved' ? 'green' : 'slate'}`}>{r.status === 'approved' ? 'Linked' : 'Rejected'}</span>
                        <span className="cell-sub">{r.decided_by_name} · {fmtDateTime(r.decided_at)}</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && data?.items.length === 0 && (
            <div className="empty"><QrCode aria-hidden /><strong>{status === 'pending' ? 'No pending requests' : 'Nothing to show'}</strong>
              {status === 'pending' ? 'Unlinked codes scanned by representatives will appear here.' : ''}</div>
          )}
        </div>
      </section>
    </>
  );
}

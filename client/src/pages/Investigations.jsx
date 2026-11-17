import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronRight, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi, useMeta, refreshMeta } from '../lib/useApi.js';
import { DataTable } from '../components/DataTable.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { fmtDateTime, relTime } from '../lib/format.js';

const I_BADGE = { open: ['Open', 'red'], investigating: ['Investigating', 'amber'], resolved: ['Resolved', 'green'], dismissed: ['Dismissed', 'slate'] };
const ACTION_LABEL = { reported: 'Reported', note: 'Note added', status_changed: 'Marked investigating', assigned: 'Took ownership', resolved: 'Resolved', dismissed: 'Dismissed', reopened: 'Reopened' };

export default function Investigations() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'open';
  const { data, error, loading } = useApi(`/investigations?status=${status}`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Investigations</h1>
          <p>Problem reports, undocumented movements and transfers that never arrived.</p>
        </div>
        <div className="head-actions"><Link className="btn" to="/report">Report a problem</Link></div>
      </div>
      {error && <div className="notice red">{error.message}</div>}
      <section className="panel table-panel">
        <div className="tabs" role="tablist">
          {[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={status === k} className={`tab${status === k ? ' active' : ''}`} onClick={() => setParams(k === 'open' ? {} : { status: k }, { replace: true })}>{l}</button>
          ))}
        </div>
        <DataTable
          rows={data?.items}
          loading={loading}
          onRowClick={(r) => navigate(`/investigations/${r.id}`)}
          empty={{ title: status === 'open' ? 'No open investigations' : 'Nothing here', body: status === 'open' ? 'Problem reports will appear here.' : '' }}
          columns={[
            { key: 'case', header: 'Report', mobile: 'primary', render: (r) => (
              <span className="stacked"><span className="cell-primary">{r.kind_label}</span><span className="cell-sub mono">#{r.case_ref}{r.transfer_no ? ` · T-${r.transfer_no}` : ''}</span></span>
            ) },
            { key: 'status', header: 'Status', mobile: 'status', render: (r) => <span className={`badge ${I_BADGE[r.status][1]}`}>{I_BADGE[r.status][0]}</span> },
            { key: 'asset', header: 'Asset', mobile: 'full', label: 'Asset', render: (r) => r.reference ? <span className="stacked"><span>{r.reference}</span><span className="cell-sub">{r.asset_code}</span></span> : <span className="mono subtle">{r.qr_value}</span> },
            { key: 'where', header: 'Reported location', mobile: 'hide', className: 'trunc', render: (r) => r.facility_name || <span className="subtle">—</span> },
            { key: 'by', header: 'Reported by', mobile: 'full', label: 'By', render: (r) => <span className="stacked"><span>{r.reported_by_name}</span><span className="cell-sub">{relTime(r.reported_at)}</span></span> },
            { key: 'owner', header: 'Owner', mobile: 'hide', render: (r) => r.assigned_to_name || <span className="subtle">Unassigned</span> },
          ]}
        />
      </section>
    </>
  );
}

export function InvestigationDetail() {
  const { id } = useParams();
  const meta = useMeta();
  const { data, error, reload } = useApi(`/investigations/${id}`);
  const [note, setNote] = useState('');
  const [facility, setFacility] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (error) return <><Crumbs /><div className="notice red"><AlertTriangle aria-hidden />{error.message}</div></>;
  if (!data) return <div className="center-fill"><div className="spinner" /></div>;
  const { investigation: i, events, canManage } = data;
  const closed = ['resolved', 'dismissed'].includes(i.status);

  const act = async (action) => {
    setBusy(true); setErr('');
    try {
      await api.post(`/investigations/${id}/update`, { action, note: note.trim() || undefined, correct_facility_id: action === 'resolve' && facility ? facility : undefined });
      setNote(''); setFacility('');
      reload(); refreshMeta();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <Crumbs ref_={i.case_ref} />
      <div className="detail-head">
        <div>
          <div className="detail-title">
            <h1>{i.kind_label}</h1>
            <span className={`badge ${I_BADGE[i.status][1]}`}>{I_BADGE[i.status][0]}</span>
          </div>
          <div className="detail-sub"><span className="mono">#{i.case_ref}</span><span>Reported by {i.reported_by_name} · {fmtDateTime(i.reported_at)}</span>{i.transfer_no && <span>From transfer T-{i.transfer_no}</span>}</div>
        </div>
      </div>
      <div className="detail-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Report</h2></div>
            <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{i.description || <span className="subtle">No description.</span>}</p>
              {i.facility_name && <div className="muted">Reported location: <strong>{i.facility_name}</strong></div>}
              {i.resolution && <div className="notice green"><CheckCircle2 aria-hidden /><span><strong>Outcome:</strong> {i.resolution}</span></div>}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Activity</h2><span className="meta">Permanent log</span></div>
            <ul className="timeline">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="dot"><ShieldAlert aria-hidden /></span>
                  <div><div className="t-title">{ACTION_LABEL[e.action] || e.action}</div><div className="t-meta">{e.actor_name}{e.note ? `: ${e.note}` : ''}</div></div>
                  <span className="t-when">{fmtDateTime(e.occurred_at)}</span>
                </li>
              ))}
            </ul>
          </section>
          {canManage && (
            <section className="panel">
              <div className="panel-head"><h2>{closed ? 'Reopen or add a note' : 'Work this investigation'}</h2>{i.assigned_to_name && <span className="meta">Owner: {i.assigned_to_name}</span>}</div>
              <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
                <textarea className="input textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note or outcome (required to resolve or dismiss)" />
                {!closed && i.asset_id && (
                  <div className="field">
                    <label htmlFor="cf">If resolving: where is it now? <span className="subtle">(optional; corrects the live location)</span></label>
                    <select id="cf" className="select" value={facility} onChange={(e) => setFacility(e.target.value)}>
                      <option value="">Leave location as is ({i.asset_facility_name || 'none'})</option>
                      {meta?.facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </div>
                )}
                {err && <div className="form-error">{err}</div>}
                <div className="seg">
                  {!closed && !i.assigned_to_name && <button className="btn" disabled={busy} onClick={() => act('assign_self')}>Take ownership</button>}
                  <button className="btn" disabled={busy || !note.trim()} onClick={() => act('note')}>Add note</button>
                  {!closed && <button className="btn" disabled={busy || !note.trim()} onClick={() => act('dismiss')}>Dismiss</button>}
                  {!closed && <button className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => act('resolve')}>Resolve</button>}
                  {closed && <button className="btn" disabled={busy} onClick={() => act('reopen')}>Reopen</button>}
                </div>
              </div>
            </section>
          )}
        </div>
        <div className="stack">
          {i.asset_id && (
            <section className="panel">
              <div className="panel-head"><h2>Asset</h2></div>
              <div className="custody">
                <div><div className="k subtle" style={{ fontSize: 11.5 }}>{i.asset_code}</div><Link to={`/assets/${i.asset_id}`} className="cell-primary">{i.reference}</Link></div>
                <div><StatusBadge status={i.asset_status} /></div>
                <div className="muted">Recorded location: {i.asset_facility_name || '—'}</div>
                {i.asset_status_before && <div className="subtle" style={{ fontSize: 12 }}>Status before report: {i.asset_status_before.replace(/_/g, ' ')}</div>}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function Crumbs({ ref_ }) {
  return <div className="crumbs"><Link to="/investigations">Investigations</Link>{ref_ && <><ChevronRight aria-hidden /><span>#{ref_}</span></>}</div>;
}

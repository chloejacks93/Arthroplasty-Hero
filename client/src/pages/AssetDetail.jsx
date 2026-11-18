import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ChevronRight, MapPin, User, Warehouse, Users, QrCode, AlertTriangle, History, ArrowLeftRight,
  FileSpreadsheet, PackagePlus, CheckCircle2, Circle, Clock, ScanLine, Unlink, Keyboard,
} from 'lucide-react';
import { useApi, useMeta } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { Modal } from '../components/Modal.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { ASSET_TYPE, EVENT_LABEL, FACILITY_TYPE, fmtDate, fmtDateTime, fmtMoney, fmtNum, relTime } from '../lib/format.js';

const EVENT_ICON = { created: PackagePlus, imported: FileSpreadsheet, qr_linked: QrCode, qr_unlinked: Unlink, scanned: ScanLine,
  transfer_initiated: ArrowLeftRight, transfer_received: CheckCircle2, problem_reported: AlertTriangle };

const SOURCE_FIELD_LABEL = {
  reference: 'Reference', description: 'Description', source_type: 'Type', agency: 'Agency',
  source_warehouse: 'Warehouse', source_location: 'Location', lot: 'Lot', consignment_fee: 'Consignment fee',
  return_date: 'Return date', items_count: 'Items', flags: 'Flags', notes: 'Notes',
  catalog_number: 'Catalog #', batch_number: 'Batch #', serial_number: 'Serial #', qr_value: 'QR UUID',
  set_utilization_factor: 'Set utilization factor', definition_value: 'Definition value', total_cases_12m: 'Cases, last 12 months',
  top_hcp: 'Top HCP', top_hcp_sales: 'Top HCP sales', top_hcp_cases: 'Top HCP cases', days_since_last_case: 'Days since last case',
  current_facility: 'Location', team: 'Team', assigned_rep: 'Representative',
};

export default function AssetDetail() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi(`/assets/${id}`);
  const meta = useMeta();
  const [tab, setTab] = useState('history');
  const [assign, setAssign] = useState(false);

  if (error) {
    return (
      <>
        <Crumbs />
        <div className="notice red"><AlertTriangle aria-hidden />{error.message}</div>
      </>
    );
  }
  if (loading && !data) return <div className="center-fill"><div className="spinner" /></div>;
  const { asset: a, events, transfers, sources, conflicts, investigations = [], openTransfer } = data;
  const me = meta?.me?.id;

  return (
    <>
      <Crumbs code={a.asset_code} />
      <div className="detail-head">
        <div>
          <div className="detail-title">
            <h1>{a.reference}</h1>
            <StatusBadge status={a.status} />
          </div>
          <div className="detail-sub">
            <span className="mono">{a.asset_code}</span>
            <span>{ASSET_TYPE[a.asset_type]}</span>
            {a.description && <span>{a.description}</span>}
          </div>
        </div>
        <div className="head-actions">
          {!openTransfer && <Link className="btn btn-primary" to={`/transfer?asset=${a.id}`}><ArrowLeftRight aria-hidden /> Transfer</Link>}
          {openTransfer?.recipient_id === me && <Link className="btn btn-primary" to="/receive"><CheckCircle2 aria-hidden /> Confirm receipt</Link>}
          <Link className="btn" to={`/report?asset=${a.id}`} state={{ asset: a }}><AlertTriangle aria-hidden /> Report a problem</Link>
        </div>
      </div>

      {openTransfer && (
        <div className={`notice ${openTransfer.overdue ? 'amber' : 'blue'}`} style={{ marginBottom: 16 }}>
          <ArrowLeftRight aria-hidden />
          <span>In transit: <strong>{openTransfer.from_facility || '—'} → {openTransfer.to_facility}</strong>, sent by {openTransfer.sender_name} to {openTransfer.recipient_id === me ? 'you' : openTransfer.recipient_name} {relTime(openTransfer.initiated_at)}.
            {openTransfer.overdue ? ' Past its receipt deadline.' : ` Awaiting receipt by ${fmtDateTime(openTransfer.accept_by)}.`}{' '}
            <Link to={`/transfers?status=any`}>Transfers</Link></span>
        </div>
      )}
      {investigations.map((iv) => (
        <div key={iv.id} className="notice red" style={{ marginBottom: 16 }}>
          <AlertTriangle aria-hidden />
          <span>Open investigation #{iv.case_ref} ({iv.kind.replace(/_/g, ' ')}), reported {relTime(iv.reported_at)}. <Link to={`/investigations/${iv.id}`}>View</Link></span>
        </div>
      ))}

      {conflicts.length > 0 && (
        <div className="notice amber" style={{ marginBottom: 16 }}>
          <AlertTriangle aria-hidden />
          <span>{conflicts.length} unresolved import conflict{conflicts.length > 1 ? 's' : ''} on this asset
            ({[...new Set(conflicts.map((c) => SOURCE_FIELD_LABEL[c.field] || c.field.replace('_', ' ')))].join(', ')}). Live values were not overwritten.{' '}
            <Link to={`/conflicts?asset_id=${a.id}`}>Review</Link></span>
        </div>
      )}

      <div className="detail-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Asset record</h2><span className="meta">Updated {relTime(a.updated_at)}</span></div>
            <dl className="facts" style={{ margin: 0 }}>
              <Fact k="Reference" v={a.reference} />
              <Fact k="Type" v={ASSET_TYPE[a.asset_type]} sub={a.source_type && a.source_type !== ASSET_TYPE[a.asset_type] ? `Source: ${a.source_type}` : null} />
              <Fact k="Lot" v={a.lot} mono />
              <Fact k="Catalog · Batch · Serial" v={a.catalog_number || a.batch_number || a.serial_number
                ? [a.catalog_number, a.batch_number && `Batch ${a.batch_number}`, a.serial_number && `SN ${a.serial_number}`].filter(Boolean).join(' · ') : null}
                sub={a.serial_number ? 'Set serial: may be shared by sibling trays' : null} />
              <Fact k="Agency" v={a.agency} />
              <Fact k="Items" v={a.items_count != null ? fmtNum(a.items_count) : null} />
              <Fact k="Consignment fee" v={a.consignment_fee != null ? fmtMoney(a.consignment_fee) : null} />
              <Fact k="Return date" v={a.return_date ? fmtDate(a.return_date) : null} />
              <Fact k="Flags" v={a.flags} />
              <Fact k="Source location (as imported)" v={a.source_location} />
              <Fact k="Notes" v={a.notes} wide />
            </dl>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Case utilization</h2><span className="meta">{a.utilization_as_of ? `As of ${fmtDate(a.utilization_as_of)}` : 'From imported data'}</span></div>
            <dl className="facts" style={{ margin: 0 }}>
              <Fact k="Cases, last 12 months" v={a.total_cases_12m != null ? fmtNum(a.total_cases_12m) : null} />
              <Fact k="Days since last case" v={a.days_since_last_case != null ? fmtNum(a.days_since_last_case) : null} />
              <Fact k="Set utilization factor" v={a.set_utilization_factor} />
              <Fact k="Definition value" v={a.definition_value != null ? fmtMoney(a.definition_value) : null} />
              <Fact k="Top HCP" v={a.top_hcp} />
              <Fact k="Top HCP cases / sales" v={a.top_hcp_cases != null || a.top_hcp_sales != null ? `${fmtNum(a.top_hcp_cases)} · ${fmtMoney(a.top_hcp_sales)}` : null} />
            </dl>
          </section>

          <section className="panel">
            <div className="tabs" role="tablist">
              <Tab id="history" cur={tab} set={setTab} icon={History} n={events.length}>Movement history</Tab>
              <Tab id="transfers" cur={tab} set={setTab} icon={ArrowLeftRight} n={transfers.length}>Transfers</Tab>
              <Tab id="sources" cur={tab} set={setTab} icon={FileSpreadsheet} n={sources.length}>Import sources</Tab>
            </div>
            {tab === 'history' && (
              events.length ? (
                <ul className="timeline">
                  {events.map((e) => {
                    const Icon = EVENT_ICON[e.event_type] || Circle;
                    return (
                      <li key={e.id}>
                        <span className="dot"><Icon aria-hidden /></span>
                        <div>
                          <div className="t-title">{EVENT_LABEL[e.event_type] || e.event_type}</div>
                          <div className="t-meta">
                            {e.actor_name}
                            {e.from_facility && e.to_facility && e.from_facility !== e.to_facility
                              ? ` · ${e.from_facility} → ${e.to_facility}`
                              : e.to_facility ? ` · ${e.to_facility}` : e.from_facility ? ` · from ${e.from_facility}` : ''}
                            {e.to_custodian && e.to_custodian !== e.from_custodian
                              ? (e.event_type === 'transfer_initiated' ? ` · To: ${e.to_custodian}` : ` · Custodian: ${e.to_custodian}`) : ''}
                            {e.details?.team ? ` · Team: ${e.details.team.from || '—'} → ${e.details.team.to}` : ''}
                          </div>
                        </div>
                        <span className="t-when" title={fmtDateTime(e.occurred_at)}>{fmtDateTime(e.occurred_at)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : <div className="empty"><strong>No history yet</strong></div>
            )}
            {tab === 'transfers' && (
              transfers.length ? (
                <div className="table-wrap auto">
                  <table className="data compact">
                    <thead><tr><th>#</th><th>From</th><th>To</th><th>Sender → Recipient</th><th>Status</th><th className="right">Initiated</th></tr></thead>
                    <tbody>
                      {transfers.map((t) => (
                        <tr key={t.id}>
                          <td className="mono muted">T-{t.transfer_no}</td>
                          <td>{t.from_facility || '—'}</td>
                          <td>{t.to_facility}</td>
                          <td>{t.sender_name} → {t.recipient_name}</td>
                          <td><span className={`badge ${t.status === 'received' ? 'green' : t.status === 'in_transit' ? 'blue' : 'slate'}`}>{t.status.replace('_', ' ')}</span></td>
                          <td className="right muted">{fmtDateTime(t.initiated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="empty"><strong>No transfers recorded</strong>Transfers will appear here once they are initiated.</div>
            )}
            {tab === 'sources' && (
              sources.length ? (
                <div className="table-wrap auto">
                  <table className="data compact">
                    <thead><tr><th>Field</th><th>Value</th><th>Spreadsheet</th><th className="right">Imported</th></tr></thead>
                    <tbody>
                      {sources.map((s, i) => (
                        <tr key={i}>
                          <td>{SOURCE_FIELD_LABEL[s.field] || s.field}</td>
                          <td className="trunc">{s.value ?? '—'}</td>
                          <td className="muted trunc">{s.filename}</td>
                          <td className="right muted">{fmtDate(s.recorded_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="empty"><strong>No spreadsheet sources</strong>Field provenance is recorded for imported assets.</div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Custody &amp; location</h2>
              {meta?.permissions.investigate && <button className="linkish" onClick={() => setAssign(true)}>Edit assignment</button>}</div>
            <div className="custody">
              <Row icon={MapPin} k="Current location" v={a.current_facility_id ? <Link to={`/facilities/${a.current_facility_id}`}>{a.facility_name}</Link> : 'Unassigned'} sub={a.facility_type ? FACILITY_TYPE[a.facility_type] : null} />
              <Row icon={User} k="Assigned representative" v={a.rep_name || 'Unassigned'} sub={a.rep_phone || a.rep_email} />
              <Row icon={User} k="Last known custodian" v={a.custodian_name || '—'} />
              <Row icon={Warehouse} k="Home warehouse" v={a.warehouse_name || '—'} />
              <Row icon={Users} k="Team" v={a.team_name || '—'} />
              <Row icon={Clock} k="Last scanned · last transferred" v={`${relTime(a.last_scanned_at)} · ${relTime(a.last_transferred_at)}`} />
            </div>
          </section>

          <QrPanel a={a} canLink={!!meta?.permissions.linkQr} onChanged={reload} />
          {assign && <AssignmentModal a={a} meta={meta} onClose={() => setAssign(false)} onSaved={() => { setAssign(false); reload(); }} />}
        </div>
      </div>
    </>
  );
}

function Crumbs({ code }) {
  return (
    <div className="crumbs">
      <Link to="/assets">Asset registry</Link>
      {code && (<><ChevronRight aria-hidden /><span>{code}</span></>)}
    </div>
  );
}

function Fact({ k, v, mono, sub, wide }) {
  const empty = v === null || v === undefined || v === '';
  return (
    <div className="fact" style={wide ? { gridColumn: '1 / -1', borderRight: 0 } : undefined}>
      <dt>{k}</dt>
      <dd className={`${empty ? 'empty-val' : ''}${mono && !empty ? ' mono' : ''}`}>{empty ? '—' : v}</dd>
      {sub && <dd className="subtle" style={{ fontSize: 12 }}>{sub}</dd>}
    </div>
  );
}

function Row({ icon: Icon, k, v, sub }) {
  return (
    <div className="custody-row">
      <span className="ico"><Icon aria-hidden /></span>
      <div><div className="k">{k}</div><div className="v">{v}{sub && <small>{sub}</small>}</div></div>
    </div>
  );
}

function Tab({ id, cur, set, icon: Icon, n, children }) {
  return (
    <button role="tab" aria-selected={cur === id} className={`tab${cur === id ? ' active' : ''}`} onClick={() => set(id)}>
      <Icon size={14} aria-hidden /> {children} <span className="n">{n}</span>
    </button>
  );
}

function QrPanel({ a, canLink, onChanged }) {
  const [mode, setMode] = useState(null); // 'type' | 'unlink' | 'replace'
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const close = () => { setMode(null); setValue(''); setReason(''); setErr(''); };
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      if (mode === 'unlink') await api.post('/qr/unlink', { asset_id: a.id, reason });
      else await api.post('/qr/link', { asset_id: a.id, value, replace: mode === 'replace', reason: mode === 'replace' ? reason : undefined });
      close();
      onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2>Arthrex QR identifier</h2></div>
      <div className="qr-box">
        {a.qr_value ? (
          <>
            <div className="qr-value">{a.qr_value}</div>
            <span className="subtle" style={{ fontSize: 12 }}>Linked {fmtDate(a.qr_linked_at)}</span>
          </>
        ) : (
          <div className="notice amber"><QrCode aria-hidden /><span>No existing QR code is linked to this asset yet.{canLink ? ' Scan its label to link it.' : ' An inventory lead or manager can link it.'}</span></div>
        )}
        {canLink && (
          <div className="seg" style={{ marginTop: 6 }}>
            {!a.qr_value ? (
              <>
                <Link className="btn btn-primary btn-sm" to={`/scan?link=${a.id}`}><ScanLine aria-hidden /> Scan to link</Link>
                <button className="btn btn-sm" onClick={() => setMode('type')}><Keyboard aria-hidden /> Enter code</button>
              </>
            ) : (
              <>
                <button className="btn btn-sm" onClick={() => setMode('replace')}>Replace</button>
                <button className="btn btn-sm btn-ghost" onClick={() => setMode('unlink')}><Unlink aria-hidden /> Unlink</button>
              </>
            )}
          </div>
        )}
      </div>
      {mode && (
        <Modal
          title={mode === 'unlink' ? 'Unlink QR code?' : mode === 'replace' ? 'Replace QR code' : 'Link QR code'}
          onClose={close}
          actions={<>
            <button className="btn" onClick={close} disabled={busy}>Cancel</button>
            <button className={`btn ${mode === 'unlink' ? 'btn-danger' : 'btn-primary'}`} onClick={submit}
              disabled={busy || (mode !== 'unlink' && !value.trim()) || (mode !== 'type' && reason.trim().length < 3)}>
              {mode === 'unlink' ? 'Unlink' : 'Link code'}
            </button>
          </>}
        >
          <div style={{ display: 'grid', gap: 12 }}>
            {mode === 'unlink' && <p style={{ margin: 0 }}>The label will stop opening this asset. The link stays in the asset's permanent history.</p>}
            {mode !== 'unlink' && (
              <div className="field">
                <label htmlFor="qrv">Code on the label</label>
                <input id="qrv" className="input mono" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} placeholder="e.g. 3f2b…-…" autoFocus />
              </div>
            )}
            {mode !== 'type' && (
              <div className="field">
                <label htmlFor="qrr">Reason</label>
                <input id="qrr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Label damaged and replaced" />
              </div>
            )}
            {err && <div className="form-error">{err}</div>}
          </div>
        </Modal>
      )}
    </section>
  );
}

function AssignmentModal({ a, meta, onClose, onSaved }) {
  const [form, setForm] = useState({ assigned_rep_id: a.assigned_rep_id || '', team_id: a.team_id || '', warehouse_id: a.warehouse_id || '', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api.patch(`/assets/${a.id}/assignment`, {
        assigned_rep_id: form.assigned_rep_id || null, team_id: form.team_id || null, warehouse_id: form.warehouse_id || null, note: form.note || undefined,
      });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const reps = (meta?.users || []).filter((u) => u.role === 'rep');
  const others = (meta?.users || []).filter((u) => u.role !== 'rep');
  return (
    <Modal title="Edit assignment" onClose={onClose}
      actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}>Save</button></>}>
      <div className="form-grid">
        <div className="field span2"><label htmlFor="ar">Assigned representative</label>
          <select id="ar" className="select" value={form.assigned_rep_id} onChange={set('assigned_rep_id')}>
            <option value="">Unassigned</option>
            <optgroup label="Representatives">{reps.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</optgroup>
            {others.length > 0 && <optgroup label="Inventory & management">{others.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</optgroup>}
          </select></div>
        <div className="field"><label htmlFor="at">Team</label>
          <select id="at" className="select" value={form.team_id} onChange={set('team_id')}><option value="">No team</option>{meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div className="field"><label htmlFor="aw">Home warehouse</label>
          <select id="aw" className="select" value={form.warehouse_id} onChange={set('warehouse_id')}><option value="">None</option>{meta?.facilities.filter((f) => f.facility_type === 'warehouse').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
        <div className="field span2"><label htmlFor="an">Note <span className="subtle">(recorded in history)</span></label><input id="an" className="input" value={form.note} onChange={set('note')} placeholder="e.g. Territory realignment" /></div>
        <p className="subtle span2" style={{ margin: 0, fontSize: 12 }}>To change where it physically is, use Transfer, or resolve an investigation.</p>
        {err && <div className="form-error span2">{err}</div>}
      </div>
    </Modal>
  );
}

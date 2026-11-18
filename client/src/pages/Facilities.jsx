import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Search, ChevronRight, ArrowRight, MapPin, Phone, CheckCircle2, AlertTriangle, Pencil, Users } from 'lucide-react';
import { api, qs } from '../lib/api.js';
import { useApi, useMeta, refreshMeta } from '../lib/useApi.js';
import { useAuth, isOrgWide } from '../lib/auth.jsx';
import { DataTable, Pager } from '../components/DataTable.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { Modal } from '../components/Modal.jsx';
import { ASSET_TYPE, FACILITY_TYPE, fmtMoney, fmtNum, relTime } from '../lib/format.js';

export default function Facilities() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const f = { q: params.get('q') || '', type: params.get('type') || '', status: params.get('status') || 'active' };
  const { data, error, loading, reload } = useApi(`/facilities${qs(f)}`);
  const [edit, setEdit] = useState(null);
  const set = (k, v) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); setParams(n, { replace: true }); };
  return (
    <>
      <div className="page-head">
        <div><h1>Facilities</h1><p>Warehouses, hospitals and surgery centers, with what is there right now.</p></div>
        {data?.canEdit && <div className="head-actions"><button className="btn btn-primary" onClick={() => setEdit({})}><Plus aria-hidden /> Add facility</button></div>}
      </div>
      {error && <div className="notice red">{error.message}</div>}
      <section className="panel table-panel">
        <div className="toolbar">
          <div className="search"><Search aria-hidden /><input className="input" placeholder="Facility or city" defaultValue={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search facilities" /></div>
          <select className="select select-sm" value={f.type} onChange={(e) => set('type', e.target.value)} aria-label="Type">
            <option value="">All types</option>{Object.entries(FACILITY_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="select select-sm" value={f.status} onChange={(e) => set('status', e.target.value === 'active' ? '' : e.target.value)} aria-label="Status">
            <option value="active">Active</option><option value="inactive">Deactivated</option><option value="all">All</option>
          </select>
        </div>
        <DataTable
          rows={data?.items}
          loading={loading}
          onRowClick={(r) => navigate(`/facilities/${r.id}`)}
          empty={{ title: 'No facilities', body: 'Facilities are created by imports or by an administrator.' }}
          columns={[
            { key: 'name', header: 'Facility', mobile: 'primary', render: (r) => <span className="stacked"><span className="cell-primary">{r.name}</span><span className="cell-sub">{[r.city, r.state].filter(Boolean).join(', ') || FACILITY_TYPE[r.facility_type]}</span></span> },
            { key: 'type', header: 'Type', mobile: 'status', render: (r) => r.active ? <span className="tag">{FACILITY_TYPE[r.facility_type]}</span> : <span className="badge slate">Deactivated</span> },
            { key: 'assets', header: 'Assets', align: 'right', mobile: 'full', label: 'Assets', render: (r) => <span className="num cell-primary">{r.assets}</span> },
            { key: 'mix', header: 'Trays · totes', align: 'right', mobile: 'hide', render: (r) => <span className="num muted">{r.trays} · {r.totes}</span> },
            { key: 'reps', header: 'Reps', align: 'right', mobile: 'hide', render: (r) => <span className="num">{r.reps}</span> },
            { key: 'incoming', header: 'Incoming', align: 'right', mobile: 'full', label: 'Incoming', render: (r) => r.incoming ? <span className="badge blue">{r.incoming} in transit</span> : <span className="subtle">0</span> },
            { key: 'exc', header: 'Exceptions', align: 'right', mobile: 'full', label: 'Exceptions', render: (r) => r.exceptions ? <span className="exc num">{r.exceptions}</span> : <span className="subtle">0</span> },
          ]}
        />
      </section>
      {edit && <FacilityModal facility={edit} onClose={() => setEdit(null)} onSaved={(x) => { setEdit(null); reload(); refreshMeta(); navigate(`/facilities/${x.id}`); }} />}
    </>
  );
}

export function FacilityDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const meta = useMeta();
  const { data, error, reload } = useApi(`/facilities/${id}`);
  const [tab, setTab] = useState('assets');
  const [af, setAf] = useState({ team_id: '', rep_id: '', asset_type: '', status: '', page: 1 });
  const assets = useApi(tab === 'assets' ? `/assets${qs({ facility_id: id, ...af, pageSize: 25, sort: 'reference' })}` : null);
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState(null);
  const navigate = useNavigate();

  if (error) return <><Crumbs /><div className="notice red"><AlertTriangle aria-hidden />{error.message}</div></>;
  if (!data) return <div className="center-fill"><div className="spinner" /></div>;
  const { facility: fac, counts: c, incoming, outgoing, reps } = data;
  const setF = (k, v) => setAf((x) => ({ ...x, [k]: v, page: 1 }));

  const toggleActive = async () => {
    setMsg(null);
    try { await api.patch(`/facilities/${fac.id}`, { active: !fac.active }); reload(); refreshMeta(); setMsg({ tone: 'green', text: fac.active ? 'Facility deactivated.' : 'Facility reactivated.' }); }
    catch (e) { setMsg({ tone: 'red', text: e.message }); }
  };

  return (
    <>
      <Crumbs name={fac.name} />
      <div className="detail-head">
        <div>
          <div className="detail-title">
            <h1>{fac.name}</h1>
            <span className="tag">{FACILITY_TYPE[fac.facility_type]}</span>
            {!fac.active && <span className="badge slate">Deactivated</span>}
          </div>
          <div className="detail-sub">
            {(fac.address_line || fac.city) && <span><MapPin aria-hidden />{[fac.address_line, fac.city, fac.state, fac.postal_code].filter(Boolean).join(', ')}</span>}
            {fac.phone && <span><Phone aria-hidden />{fac.phone}</span>}
            <span><Users aria-hidden />{c.reps} rep{c.reps === 1 ? '' : 's'} with assets here</span>
            {fac.receiving_team_name && <span><Users aria-hidden />Trays received here join <strong>{fac.receiving_team_name}</strong></span>}
          </div>
        </div>
        {data.canEdit && (
          <div className="head-actions">
            <button className="btn" onClick={() => setEdit(true)}><Pencil aria-hidden /> Edit</button>
            <button className="btn btn-ghost" onClick={toggleActive}>{fac.active ? 'Deactivate' : 'Reactivate'}</button>
          </div>
        )}
      </div>
      {msg && <div className={`notice ${msg.tone}`} style={{ marginBottom: 16 }}>{msg.tone === 'green' ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}{msg.text}</div>}
      {!isOrgWide(user) && <div className="notice blue" style={{ marginBottom: 16 }}><AlertTriangle aria-hidden /><span>Counts include only assets in your teams and custody.</span></div>}

      <section className="kpi-strip kpi-7" aria-label="Facility figures">
        <K label="Assets here" v={c.assets} sub={`${fmtNum(c.trays)} trays · ${fmtNum(c.totes)} totes`} />
        <K label="Incoming" v={incoming.length} tone="blue" sub="in transit to here" />
        <K label="Outgoing" v={outgoing.length} sub="in transit from here" />
        <K label="On cases" v={c.on_case} tone="green" sub="assigned to cases" />
        <K label="Missing" v={c.missing} tone="red" sub="last seen here" />
        <K label="Overdue" v={c.overdue} tone="amber" sub="past return date" />
        <K label="Consignment" v={null} display={fmtMoney(Number(c.consignment_fees))} sub="fees, assets here" />
      </section>

      <section className="panel table-panel">
        <div className="tabs scroll-x" role="tablist">
          {[['assets', 'Assets', c.assets], ['incoming', 'Incoming transfers', incoming.length], ['outgoing', 'Outgoing transfers', outgoing.length], ['reps', 'Representatives', reps.length]].map(([k, l, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l} <span className="n">{n}</span></button>
          ))}
        </div>
        {tab === 'assets' && (
          <>
            <div className="toolbar">
              <select className="select select-sm" value={af.asset_type} onChange={(e) => setF('asset_type', e.target.value)} aria-label="Type"><option value="">All types</option>{Object.entries(ASSET_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select className="select select-sm" value={af.status} onChange={(e) => setF('status', e.target.value)} aria-label="Status">
                <option value="">All statuses</option><option value="at_facility">At Facility</option><option value="at_warehouse">At Warehouse</option><option value="assigned_to_case">Assigned to Case</option>
                <option value="missing">Missing</option><option value="overdue">Overdue</option><option value="under_investigation">Under Investigation</option></select>
              {isOrgWide(user) && <select className="select select-sm" value={af.team_id} onChange={(e) => setF('team_id', e.target.value)} aria-label="Team"><option value="">All teams</option>{meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
              {isOrgWide(user) && <select className="select select-sm" value={af.rep_id} onChange={(e) => setF('rep_id', e.target.value)} aria-label="Rep"><option value="">All reps</option>{reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}</select>}
            </div>
            <DataTable
              rows={assets.data?.items}
              loading={assets.loading}
              onRowClick={(r) => navigate(`/assets/${r.id}`)}
              empty={{ title: 'No assets here', body: 'Nothing matches these filters at this facility.' }}
              columns={[
                { key: 'reference', header: 'Asset', mobile: 'primary', render: (r) => <span className="stacked"><span className="cell-primary">{r.reference}</span><span className="cell-sub"><span className="mono">{r.asset_code}</span>{r.description ? ` · ${r.description}` : ''}</span></span> },
                { key: 'type', header: 'Type', mobile: 'hide', render: (r) => <span className="tag">{ASSET_TYPE[r.asset_type]}</span> },
                { key: 'status', header: 'Status', mobile: 'status', render: (r) => <StatusBadge status={r.status} /> },
                { key: 'rep', header: 'Representative', mobile: 'full', label: 'Rep', render: (r) => r.rep_name || <span className="subtle">Unassigned</span> },
                ...(isOrgWide(user) ? [{ key: 'team', header: 'Team', mobile: 'hide', render: (r) => r.team_name || <span className="subtle">—</span> }] : []),
                { key: 'scan', header: 'Last scan', align: 'right', mobile: 'hide', render: (r) => <span className="muted">{relTime(r.last_scanned_at)}</span> },
              ]}
            />
            {assets.data && <Pager page={assets.data.page} pageSize={assets.data.pageSize} total={assets.data.total} onPage={(p) => setAf((x) => ({ ...x, page: p }))} />}
          </>
        )}
        {(tab === 'incoming' || tab === 'outgoing') && <TransferRows rows={tab === 'incoming' ? incoming : outgoing} dir={tab} />}
        {tab === 'reps' && (
          <DataTable auto rows={reps} empty={{ title: 'No assigned representatives', body: 'No assets here have an assigned rep.' }}
            onRowClick={(r) => navigate(`/assets?facility_id=${fac.id}&rep_id=${r.id}`)}
            columns={[
              { key: 'full_name', header: 'Representative', mobile: 'primary', render: (r) => <span className="cell-primary">{r.full_name}</span> },
              { key: 'contact', header: 'Contact', mobile: 'full', label: 'Contact', render: (r) => <span className="stacked"><span>{r.phone ? <a href={`tel:${r.phone}`} onClick={(e) => e.stopPropagation()}>{r.phone}</a> : <span className="subtle">No phone</span>}</span><span className="cell-sub">{r.email}</span></span> },
              { key: 'assets', header: 'Assets here', align: 'right', mobile: 'status', render: (r) => <span className="num">{r.assets}</span> },
            ]} />
        )}
      </section>
      {edit && <FacilityModal facility={fac} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); refreshMeta(); setMsg({ tone: 'green', text: 'Facility saved.' }); }} />}
    </>
  );
}

function TransferRows({ rows, dir }) {
  const navigate = useNavigate();
  return (
    <DataTable auto rows={rows} onRowClick={(t) => navigate(`/assets/${t.asset_id}`)}
      empty={{ title: dir === 'incoming' ? 'Nothing in transit to here' : 'Nothing in transit from here', body: '' }}
      columns={[
        { key: 'asset', header: 'Asset', mobile: 'primary', render: (t) => <span className="stacked"><span className="cell-primary">{t.reference}</span><span className="cell-sub mono">T-{t.transfer_no} · {t.asset_code}</span></span> },
        { key: 'st', header: 'Status', mobile: 'status', render: (t) => t.overdue ? <span className="badge amber">Past deadline</span> : <span className="badge blue">In Transit</span> },
        { key: 'route', header: 'Route', mobile: 'full', label: 'Route', className: 'wrap-cell', render: (t) => <span className="route">{t.from_facility || '—'} <ArrowRight size={12} aria-hidden /> <strong>{t.to_facility}</strong></span> },
        { key: 'who', header: 'Sender → Recipient', mobile: 'full', label: 'People', render: (t) => <span>{t.sender_name} → {t.recipient_name}</span> },
        { key: 'when', header: 'Started', align: 'right', mobile: 'hide', render: (t) => <span className="muted">{relTime(t.initiated_at)}</span> },
      ]} />
  );
}

function K({ label, v, sub, tone, display }) {
  return (
    <div className={`kpi${tone ? ` tone-${tone}` : ''}`}>
      <span className="kpi-label"><span className="kpi-dot" />{label}</span>
      <span className={`kpi-value${v && (tone === 'red' || tone === 'amber') ? ' has' : ''}`}>{display ?? fmtNum(v)}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
}

function Crumbs({ name }) {
  return <div className="crumbs"><Link to="/facilities">Facilities</Link>{name && <><ChevronRight aria-hidden /><span>{name}</span></>}</div>;
}

export function FacilityModal({ facility, onClose, onSaved }) {
  const isNew = !facility.id;
  const meta = useMeta();
  const [form, setForm] = useState({
    name: facility.name || '', facility_type: facility.facility_type || 'hospital', code: facility.code || '',
    address_line: facility.address_line || '', city: facility.city || '', state: facility.state || '', postal_code: facility.postal_code || '',
    phone: facility.phone || '', notes: facility.notes || '', receiving_team_id: facility.receiving_team_id || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async () => {
    setBusy(true); setErr('');
    const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v]));
    try { const r = isNew ? await api.post('/facilities', body) : await api.patch(`/facilities/${facility.id}`, body); onSaved(r.facility); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={isNew ? 'Add facility' : `Edit ${facility.name}`} onClose={onClose}
      actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || form.name.trim().length < 2} onClick={submit}>Save</button></>}>
      <div className="form-grid">
        <div className="field span2"><label htmlFor="fn">Name</label><input id="fn" className="input" value={form.name} onChange={set('name')} autoFocus /></div>
        <div className="field"><label htmlFor="ft">Type</label><select id="ft" className="select" value={form.facility_type} onChange={set('facility_type')}>{Object.entries(FACILITY_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="fc">Code <span className="subtle">(optional)</span></label><input id="fc" className="input" value={form.code} onChange={set('code')} /></div>
        <div className="field span2"><label htmlFor="fa">Address</label><input id="fa" className="input" value={form.address_line} onChange={set('address_line')} /></div>
        <div className="field"><label htmlFor="fci">City</label><input id="fci" className="input" value={form.city} onChange={set('city')} /></div>
        <div className="field"><label htmlFor="fs">State · ZIP</label><div style={{ display: 'flex', gap: 6 }}><input id="fs" className="input" value={form.state} onChange={set('state')} style={{ width: 70 }} /><input aria-label="ZIP" className="input" value={form.postal_code} onChange={set('postal_code')} /></div></div>
        <div className="field span2"><label htmlFor="frt">Team for trays received here</label>
          <select id="frt" className="select" value={form.receiving_team_id} onChange={set('receiving_team_id')}>
            <option value="">Keep each tray’s current team</option>
            {meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="subtle" style={{ fontSize: 12 }}>When a tray is received here (by transfer or return), it switches to this team automatically.</span></div>
        <div className="field span2"><label htmlFor="fp">Phone</label><input id="fp" className="input" type="tel" value={form.phone} onChange={set('phone')} /></div>
        <div className="field span2"><label htmlFor="fno">Notes <span className="subtle">(loading dock, sterile processing contact…)</span></label><textarea id="fno" className="input textarea" rows={2} value={form.notes} onChange={set('notes')} /></div>
        {err && <div className="form-error span2">{err}</div>}
      </div>
    </Modal>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, QrCode, Download, UserCheck, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Modal } from '../components/Modal.jsx';
import { PendingImports } from '../components/PendingImports.jsx';
import { useApi } from '../lib/useApi.js';
import { qs } from '../lib/api.js';
import { useAuth, isOrgWide } from '../lib/auth.jsx';
import { DataTable, Pager } from '../components/DataTable.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { STATUS, ASSET_TYPE, relTime } from '../lib/format.js';

const FILTER_KEYS = ['q', 'status', 'asset_type', 'team_id', 'facility_id', 'rep_id', 'attention', 'mine', 'qr'];

export default function Assets() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const meta = useApi('/meta').data;

  const state = useMemo(() => Object.fromEntries([
    ...FILTER_KEYS.map((k) => [k, params.get(k) || '']),
    ['sort', params.get('sort') || 'reference'],
    ['dir', params.get('dir') || 'asc'],
    ['page', Number(params.get('page') || 1)],
  ]), [params]);

  // Debounced local search box, synced to URL.
  const [q, setQ] = useState(state.q);
  useEffect(() => setQ(state.q), [state.q]);
  useEffect(() => {
    if (q === state.q) return undefined;
    const t = setTimeout(() => update({ q }), 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(patch, resetPage = true) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (resetPage && !('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  }

  const { data, loading, error, reload } = useApi(`/assets${qs({ ...state, pageSize: 50 })}`);
  const [selected, setSelected] = useState(new Set());
  const [bulk, setBulk] = useState(false);
  const [bulkMsg, setBulkMsg] = useState('');
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = (rows, on) => setSelected((s) => { const n = new Set(s); rows.forEach((r) => (on ? n.add(r.id) : n.delete(r.id))); return n; });
  const onSort = (key) => update({ sort: key, dir: state.sort === key && state.dir === 'asc' ? 'desc' : 'asc' });
  const hasFilters = FILTER_KEYS.some((k) => state[k]);
  const reps = meta?.users.filter((u) => u.role === 'rep') || [];

  const columns = [
    { key: 'reference', header: 'Asset', sortKey: 'reference', mobile: 'primary', render: (r) => (
      <span className="stacked">
        <span className="cell-primary">{r.reference}</span>
        <span className="cell-sub"><span className="mono">{r.asset_code}</span>{r.description ? ` · ${r.description}` : ''}</span>
      </span>
    ) },
    { key: 'asset_type', header: 'Type', sortKey: 'asset_type', mobile: 'hide', render: (r) => <span className="tag">{ASSET_TYPE[r.asset_type]}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', mobile: 'status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'facility', header: 'Current location', sortKey: 'facility', mobile: 'full', label: 'Location', className: 'trunc',
      render: (r) => r.facility_name || <span className="subtle">Unassigned</span> },
    { key: 'rep', header: 'Representative', sortKey: 'rep', mobile: 'full', label: 'Rep', className: 'trunc',
      render: (r) => r.rep_name || <span className="subtle">Unassigned</span> },
    ...(isOrgWide(user) ? [{ key: 'team', header: 'Team', sortKey: 'team', mobile: 'hide', className: 'trunc', render: (r) => r.team_name || <span className="subtle">—</span> }] : []),
    { key: 'lot', header: 'Lot', sortKey: 'lot', mobile: 'hide', render: (r) => r.lot ? <span className="mono">{r.lot}</span> : <span className="subtle">—</span> },
    { key: 'qr', header: 'QR', mobile: 'hide', render: (r) => r.qr_value
      ? <QrCode size={15} strokeWidth={1.75} style={{ color: 'var(--green)' }} aria-label="QR linked" />
      : <span className="subtle" title="No QR code linked yet">—</span> },
    { key: 'last_scanned_at', header: 'Last scan', sortKey: 'last_scanned_at', align: 'right', mobile: 'hide',
      render: (r) => <span className="muted">{relTime(r.last_scanned_at)}</span> },
  ];

  return (
    <>
      <PendingImports />
      <div className="page-head">
        <div>
          <h1>Asset registry</h1>
          <p>{isOrgWide(user) ? 'Every registered tray, tote and set across the organization.' : 'Assets in your teams and custody.'}</p>
        </div>
        <div className="head-actions">
          <a className="btn" href={`/api/exports/assets.xlsx${qs({ q: state.q, status: state.status, asset_type: state.asset_type, team_id: state.team_id, facility_id: state.facility_id, rep_id: state.rep_id, attention: state.attention, mine: state.mine, qr: state.qr })}`} download>
            <Download aria-hidden /> Export to Excel
          </a>
        </div>
      </div>

      <section className="panel table-panel">
        <div className="toolbar">
          <div className="search">
            <Search aria-hidden />
            <input className="input" placeholder="Search name, QR UUID, lot, serial…" value={q}
              onChange={(e) => setQ(e.target.value)} aria-label="Search assets" enterKeyHint="search" />
          </div>
          <select className="select select-sm" value={state.status} onChange={(e) => update({ status: e.target.value, attention: '' })} aria-label="Status">
            <option value="">All statuses</option>
            {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
          <select className="select select-sm" value={state.asset_type} onChange={(e) => update({ asset_type: e.target.value })} aria-label="Type">
            <option value="">All types</option>
            {Object.entries(ASSET_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="select select-sm" value={state.facility_id} onChange={(e) => update({ facility_id: e.target.value })} aria-label="Facility">
            <option value="">All locations</option>
            {meta?.facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {isOrgWide(user) && (
            <>
              <select className="select select-sm" value={state.team_id} onChange={(e) => update({ team_id: e.target.value })} aria-label="Team">
                <option value="">All teams</option>
                {meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <select className="select select-sm" value={state.rep_id} onChange={(e) => update({ rep_id: e.target.value })} aria-label="Representative">
                <option value="">All reps</option>
                {reps.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </>
          )}
          <select className="select select-sm" value={state.qr} onChange={(e) => update({ qr: e.target.value })} aria-label="QR code">
            <option value="">QR: any</option>
            <option value="linked">QR linked</option>
            <option value="none">No QR yet</option>
          </select>
          {hasFilters && <button className="chip-clear" onClick={() => setParams({}, { replace: true })}>Clear filters</button>}
          {state.attention && <span className="tag">Requires attention</span>}
          {state.mine && <span className="tag">My assets</span>}
        </div>

        {selected.size > 0 && (
          <div className="bulk-bar">
            <span><strong>{selected.size}</strong> selected</span>
            <button className="btn btn-sm btn-primary" onClick={() => setBulk(true)}><UserCheck aria-hidden /> Assign rep / team</button>
            <button className="chip-clear" onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>
        )}
        {bulkMsg && <div className="notice green" style={{ margin: 14 }}><CheckCircle2 aria-hidden />{bulkMsg}</div>}
        {error && <div className="notice red" style={{ margin: 14 }}>{error.message}</div>}

        <DataTable
          columns={columns}
          rows={data?.items}
          loading={loading}
          sort={state.sort}
          dir={state.dir}
          onSort={onSort}
          onRowClick={(r) => navigate(`/assets/${r.id}`)}
          {...(isOrgWide(user) ? { selected, onToggle: toggle, onToggleAll: toggleAll } : {})}
          empty={hasFilters
            ? { title: 'No matching assets', body: 'Try a different search or clear the filters.' }
            : { title: 'No assets registered yet', body: 'Assets will appear here once spreadsheets are imported.' }}
        />
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => update({ page: String(p) }, false)} />}
      </section>
      {bulk && (
        <BulkAssignModal ids={[...selected]} meta={meta} onClose={() => setBulk(false)}
          onDone={(r) => { setBulk(false); setSelected(new Set()); setBulkMsg(`${r.changed} asset${r.changed === 1 ? '' : 's'} updated${r.unchanged ? `, ${r.unchanged} already matched` : ''}. Each change is in the asset’s history.`); reload(); }} />
      )}
    </>
  );
}

function BulkAssignModal({ ids, meta, onClose, onDone }) {
  const [rep, setRep] = useState('keep');
  const [team, setTeam] = useState('keep');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    const body = { asset_ids: ids, note: note || undefined };
    if (rep !== 'keep') body.assigned_rep_id = rep || null;
    if (team !== 'keep') body.team_id = team || null;
    try { onDone(await api.post('/assets/bulk-assignment', body)); } catch (e) { setErr(e.message); setBusy(false); }
  };
  const reps = (meta?.users || []).filter((u) => u.role === 'rep');
  return (
    <Modal title={`Assign ${ids.length} asset${ids.length === 1 ? '' : 's'}`} onClose={onClose}
      actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || (rep === 'keep' && team === 'keep')} onClick={submit}>{busy ? 'Saving…' : 'Apply'}</button></>}>
      <div className="form-grid">
        <div className="field span2"><label htmlFor="br">Assigned representative</label>
          <select id="br" className="select" value={rep} onChange={(e) => setRep(e.target.value)}>
            <option value="keep">Keep as is</option><option value="">Unassigned</option>
            {reps.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select></div>
        <div className="field span2"><label htmlFor="bt">Team</label>
          <select id="bt" className="select" value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="keep">Keep as is</option><option value="">No team</option>
            {meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></div>
        <div className="field span2"><label htmlFor="bn">Note <span className="subtle">(recorded on each asset)</span></label><input id="bn" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Initial rep assignment" /></div>
        <p className="subtle span2" style={{ margin: 0, fontSize: 12 }}>Locations don’t change. Use Transfer to move trays.</p>
        {err && <div className="form-error span2">{err}</div>}
      </div>
    </Modal>
  );
}

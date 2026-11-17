import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, AlertTriangle, CheckCircle2, Info, ArrowRight, ChevronLeft } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi, refreshMeta } from '../lib/useApi.js';
import { FACILITY_TYPE, fmtDateTime, fmtNum } from '../lib/format.js';
import { Modal } from '../components/Modal.jsx';

export const ACTION = {
  new: ['New asset', 'green'],
  update: ['Update', 'blue'],
  duplicate: ['Duplicate', 'slate'],
  conflict: ['Conflict', 'amber'],
  review: ['Needs decision', 'red'],
  skip: ['Skipped', 'slate'],
  error: ['Error', 'red'],
};
const METHOD = { qr: 'QR UUID', serial: 'Serial + Reference', reference_lot: 'Reference + Lot', name_only: 'Name only', none: null };
const TABS = [
  ['all', 'All rows'], ['review', 'Needs decision'], ['conflict', 'Conflicts'], ['new', 'New'],
  ['update', 'Updates'], ['duplicate', 'Duplicates'], ['warnings', 'Warnings'], ['error', 'Errors'], ['skip', 'Skipped'],
];
const PAGE = 100;
const code = (n) => `AH-${String(n).padStart(6, '0')}`;

export default function ImportBatch() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi(`/imports/batches/${id}`);
  const [tab, setTab] = useState(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirm, setConfirm] = useState(null); // 'commit' | 'cancel'
  const [done, setDone] = useState(null);

  const results = data?.results || [];
  const counts = useMemo(() => {
    const c = Object.fromEntries(TABS.map(([k]) => [k, 0]));
    for (const r of results) { c.all++; c[r.action] = (c[r.action] || 0) + 1; if (r.warnings.length) c.warnings++; }
    return c;
  }, [results]);
  const activeTab = tab || (counts.review ? 'review' : 'all');
  const filtered = results.filter((r) => activeTab === 'all' || (activeTab === 'warnings' ? r.warnings.length : r.action === activeTab));
  const pageRows = filtered.slice((page - 1) * PAGE, page * PAGE);

  if (error && !data) return <><Crumbs /><div className="notice red"><AlertTriangle aria-hidden />{error.message}</div></>;
  if (!data) return <div className="center-fill"><div className="spinner" /></div>;

  const { batch, files, mapping, options } = data;
  const isPreview = batch.status === 'preview';
  const s = data.summary || {};
  const creates = mapping ? {
    teams: Object.values(mapping.teams).filter((m) => m.create).length,
    facilities: Object.values(mapping.locations).filter((m) => m.create).length,
  } : null;

  const run = async (fn) => {
    setBusy(true);
    setActionError('');
    try { await fn(); reload(); } catch (e) { setActionError(e.message); } finally { setBusy(false); }
  };
  const decide = (decisions) => run(() => api.put(`/imports/batches/${id}/decisions`, { decisions }));
  const saveMapping = (kind, key, value) => run(() => api.put(`/imports/batches/${id}/mapping`, { [kind]: { [key]: value } }));
  const commit = () => run(async () => {
    const r = await api.post(`/imports/batches/${id}/commit`);
    setDone(r.result);
    setConfirm(null);
    refreshMeta();
  }).finally(() => setConfirm(null));
  const cancel = () => run(async () => { await api.post(`/imports/batches/${id}/cancel`); setConfirm(null); });

  return (
    <>
      <Crumbs />
      <div className="page-head">
        <div>
          <div className="detail-title">
            <h1>{isPreview ? 'Review import' : 'Import'}</h1>
            <span className={`badge ${isPreview ? 'amber' : batch.status === 'committed' ? 'green' : 'slate'}`}>
              {isPreview ? 'Awaiting approval' : batch.status === 'committed' ? 'Imported' : 'Cancelled'}
            </span>
          </div>
          <p>{files.map((f) => f.filename).join(' · ')}. Uploaded by {batch.uploaded_by_name}, {fmtDateTime(batch.created_at)}
            {batch.committed_at ? ` · approved ${fmtDateTime(batch.committed_at)}` : ''}</p>
        </div>
        {isPreview && (
          <div className="head-actions">
            <button className="btn" disabled={busy} onClick={() => setConfirm('cancel')}>Discard</button>
            <button className="btn btn-primary" disabled={busy || counts.review > 0 || loading} onClick={() => setConfirm('commit')}
              title={counts.review ? 'Decide every "Needs decision" row first' : undefined}>
              <CheckCircle2 aria-hidden /> Approve import
            </button>
          </div>
        )}
      </div>

      {actionError && <div className="notice red" style={{ marginBottom: 16 }}><AlertTriangle aria-hidden />{actionError}</div>}
      {done && (
        <div className="notice green" style={{ marginBottom: 16 }}>
          <CheckCircle2 aria-hidden />
          <span>Imported: {fmtNum(done.new)} new asset{done.new === 1 ? '' : 's'}, {fmtNum(done.update + done.conflict)} updated, {fmtNum(done.duplicate)} duplicates combined.
            {done.conflictsCreated > 0 && <> {done.conflictsCreated} conflict{done.conflictsCreated > 1 ? 's' : ''} need review. <Link to="/conflicts">Open conflicts</Link></>}</span>
        </div>
      )}
      {files.filter((f) => f.previouslyImported.length).map((f) => (
        <div key={f.id} className="notice blue" style={{ marginBottom: 12 }}>
          <Info aria-hidden />
          <span>An identical copy of <strong>{f.filename}</strong> was already imported on {fmtDateTime(f.previouslyImported[0].committed_at)}. Its rows will match existing assets instead of creating duplicates.</span>
        </div>
      ))}
      {isPreview && counts.review > 0 && (
        <div className="notice amber" style={{ marginBottom: 16 }}>
          <AlertTriangle aria-hidden />
          <span>{counts.review} row{counts.review > 1 ? 's have' : ' has'} the same Reference as an existing asset but different identifying details. Decide whether each is the same asset before approving.</span>
        </div>
      )}

      <section className="kpi-strip kpi-7" aria-label="Import summary">
        <Stat label="Rows read" value={s.rows ?? counts.all} sub={`${files.length} file${files.length > 1 ? 's' : ''}`} />
        <Stat label="New assets" value={s.new} tone="green" sub={isPreview ? `Registry → ${fmtNum(s.assetsAfter)}` : 'created'} />
        <Stat label="Updates" value={s.update} tone="blue" sub="newer field values" />
        <Stat label="Duplicates" value={s.duplicate} sub="combined, not re-created" />
        <Stat label="Conflicts" value={s.conflict} tone="amber" sub={`${fmtNum(s.conflicts)} field${s.conflicts === 1 ? '' : 's'} to review`} />
        <Stat label="Needs decision" value={s.review} tone="red" sub={isPreview ? 'before approval' : 'resolved'} />
        <Stat label="Warnings" value={s.warnings} tone="amber" sub="data quality notes" />
      </section>

      {files.length > 1 && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-head"><h2>Files</h2><span className="meta">Processed in this order. Earlier files take precedence when files disagree.</span></div>
          <div className="table-wrap auto">
            <table className="data compact">
              <thead><tr><th>#</th><th>File</th><th>Team</th><th className="right">Rows</th><th className="right">New</th><th className="right">Updates</th><th className="right">Duplicates</th><th className="right">Conflicts</th></tr></thead>
              <tbody>
                {files.map((f, i) => {
                  const p = f.perFile || { rows: f.row_count, new: f.new_count, update: f.updated_count, conflict: 0, duplicate: f.duplicate_count, conflicts: f.conflict_count };
                  return (
                    <tr key={f.id}>
                      <td className="muted num">{i + 1}</td>
                      <td className="cell-primary">{f.filename}</td>
                      <td className="muted">{f.team_name || 'From Warehouse column'}</td>
                      <td className="right num">{fmtNum(p.rows)}</td>
                      <td className="right num">{fmtNum(p.new)}</td>
                      <td className="right num">{fmtNum((p.update || 0) + (f.perFile ? p.conflict : 0))}</td>
                      <td className="right num">{fmtNum(p.duplicate)}</td>
                      <td className="right num">{fmtNum(p.conflicts)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isPreview && mapping && (
        <div className="map-grid">
          <MappingPanel
            title="Warehouse → Team"
            hint="Each Warehouse value becomes the asset's team."
            entries={mapping.teams}
            kind="teams"
            options={options.teams.map((t) => ({ id: t.id, label: t.name }))}
            onChange={saveMapping}
            busy={busy}
          />
          <MappingPanel
            title="Location → Facility"
            hint="Match each Location to a facility in the directory, or create it."
            entries={mapping.locations}
            kind="locations"
            options={options.facilities.map((f) => ({ id: f.id, label: f.name, sub: FACILITY_TYPE[f.facility_type] }))}
            onChange={saveMapping}
            busy={busy}
          />
        </div>
      )}

      <section className="panel table-panel">
        <div className="tabs scroll-x" role="tablist">
          {TABS.filter(([k]) => k === 'all' || counts[k] > 0).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={activeTab === k} className={`tab${activeTab === k ? ' active' : ''}`}
              onClick={() => { setTab(k); setPage(1); }}>
              {label} <span className={`n${k === 'review' && counts.review ? ' n-alert' : ''}`}>{counts[k]}</span>
            </button>
          ))}
        </div>
        {isPreview && activeTab === 'review' && counts.review > 1 && (
          <div className="toolbar">
            <span className="muted">Apply to all {counts.review} rows:</span>
            <button className="btn btn-sm" disabled={busy} onClick={() => decide(results.filter((r) => r.action === 'review').map((r) => ({ rowId: r.rowId, decision: 'create_new' })))}>Different assets</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => decide(results.filter((r) => r.action === 'review').map((r) => ({ rowId: r.rowId, decision: 'skip' })))}>Skip all</button>
          </div>
        )}
        <div className="table-wrap">
          <table className="data responsive import-rows">
            <thead>
              <tr><th>Source</th><th>Asset</th><th>Result</th><th>Matched to</th><th>Details</th></tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.rowId}>
                  <td className="m-full" data-label="Source"><span className="stacked"><span className="mono muted">{r.filename}</span><span className="cell-sub">Row {r.rowNumber}</span></span></td>
                  <td className="m-primary"><span className="stacked"><span className="cell-primary">{r.reference || <em className="subtle">No reference</em>}</span><span className="cell-sub">{r.description}</span></span></td>
                  <td className="m-status"><span className={`badge ${ACTION[r.action][1]}`}>{ACTION[r.action][0]}</span></td>
                  <td className="m-full" data-label="Match"><MatchCell r={r} assetId={r.assetId} /></td>
                  <td className="m-full details-cell">
                    <Details r={r} />
                    {isPreview && (r.action === 'review' || r.decision) && <Decision r={r} busy={busy} decide={decide} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="empty"><strong>Nothing here</strong>No rows in this category.</div>}
        </div>
        {filtered.length > PAGE && (
          <div className="table-foot">
            <span className="num">{(page - 1) * PAGE + 1}–{Math.min(filtered.length, page * PAGE)} of {fmtNum(filtered.length)} rows</span>
            <div className="pager">
              <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft /></button>
              <span className="page-ind">Page {page} of {Math.ceil(filtered.length / PAGE)}</span>
              <button className="btn" disabled={page * PAGE >= filtered.length} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight /></button>
            </div>
          </div>
        )}
      </section>

      {confirm === 'commit' && (
        <Modal title="Approve this import?" onClose={() => setConfirm(null)}
          actions={<>
            <button className="btn" onClick={() => setConfirm(null)} disabled={busy}>Back to review</button>
            <button className="btn btn-primary" onClick={commit} disabled={busy}>{busy ? 'Importing…' : 'Approve and import'}</button>
          </>}>
          <ul className="confirm-list">
            <li><strong>{fmtNum(s.new)}</strong> new asset{s.new === 1 ? '' : 's'} will be registered</li>
            <li><strong>{fmtNum(s.update + s.conflict)}</strong> existing asset{s.update + s.conflict === 1 ? '' : 's'} updated with newer values</li>
            <li><strong>{fmtNum(s.duplicate)}</strong> duplicate row{s.duplicate === 1 ? '' : 's'} combined into existing records</li>
            {s.conflicts > 0 && <li><strong>{fmtNum(s.conflicts)}</strong> conflicting value{s.conflicts === 1 ? '' : 's'} saved for review. Live locations stay as they are.</li>}
            {creates && (creates.teams + creates.facilities > 0) && <li><strong>{creates.teams}</strong> team{creates.teams === 1 ? '' : 's'} and <strong>{creates.facilities}</strong> facilit{creates.facilities === 1 ? 'y' : 'ies'} will be created</li>}
          </ul>
          <p className="muted" style={{ margin: '12px 0 0' }}>Every change is recorded in each asset's permanent history.</p>
        </Modal>
      )}
      {confirm === 'cancel' && (
        <Modal title="Discard this import?" onClose={() => setConfirm(null)}
          actions={<>
            <button className="btn" onClick={() => setConfirm(null)}>Keep reviewing</button>
            <button className="btn btn-danger" onClick={cancel} disabled={busy}>Discard import</button>
          </>}>
          <p style={{ margin: 0 }}>No assets will be changed. The upload stays in import history as cancelled.</p>
        </Modal>
      )}
    </>
  );
}

function Crumbs() {
  return <div className="crumbs"><Link to="/imports">Imports</Link><ChevronRight aria-hidden /><span>Review</span></div>;
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className={`kpi${tone ? ` tone-${tone}` : ''}`}>
      <span className="kpi-label"><span className="kpi-dot" />{label}</span>
      <span className={`kpi-value${value && (tone === 'red' || tone === 'amber') ? ' has' : ''}`}>{value == null ? '—' : fmtNum(value)}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
}

function MatchCell({ r, assetId }) {
  const m = METHOD[r.method];
  const t = r.target;
  if (r.action === 'new') {
    return assetId ? <Link to={`/assets/${assetId}`}>View new asset <ArrowRight size={12} /></Link> : <span className="subtle">Creates a new record</span>;
  }
  if (!t) return <span className="subtle">{r.action === 'review' ? `${r.candidates.length} possible match${r.candidates.length > 1 ? 'es' : ''}` : '—'}</span>;
  return (
    <span className="stacked">
      {t.id ? <Link to={`/assets/${t.id}`} className="cell-primary">{code(t.asset_no)}</Link>
        : <span className="cell-primary">Same as {t.filename} row</span>}
      <span className="cell-sub">{m ? `via ${m}` : ''}{t.facility ? ` · ${t.facility}` : ''}</span>
    </span>
  );
}

function Details({ r }) {
  const [open, setOpen] = useState(false);
  const items = [];
  for (const c of r.conflicts) {
    items.push(
      <div key={`c-${c.field}`} className={`delta ${c.severity === 'critical' ? 'crit' : 'warn'}`}>
        <span className="delta-k">{c.label}</span>
        <span className="delta-v"><s>{c.current ?? '—'}</s> <ArrowRight size={11} /> {c.proposed ?? '—'}</span>
        <span className="delta-t">{c.severity === 'critical' ? 'kept live value' : `kept ${c.currentSource === 'live record' ? 'current' : `from ${c.currentSource}`}`}</span>
      </div>,
    );
  }
  const changes = r.changes.filter((c) => !['source_location', 'source_warehouse'].includes(c.field) || !r.conflicts.length);
  const shown = open ? changes : changes.slice(0, 3);
  for (const c of shown) {
    items.push(
      <div key={`u-${c.field}`} className="delta">
        <span className="delta-k">{c.label}</span>
        <span className="delta-v">{c.from == null ? <span className="subtle">empty</span> : c.from} <ArrowRight size={11} /> {c.to}</span>
      </div>,
    );
  }
  if (changes.length > 3) items.push(<button key="more" className="linkish" onClick={() => setOpen(!open)}>{open ? 'Show less' : `+${changes.length - 3} more changes`}</button>);
  for (const w of r.warnings) items.push(<div key={`w-${w}`} className="row-warn"><AlertTriangle size={12} aria-hidden /> {w}</div>);
  for (const n of r.notes) items.push(<div key={`n-${n}`} className="row-note">{n}</div>);
  if (!items.length) return <span className="subtle">{r.action === 'duplicate' ? 'Identical to existing record' : '—'}</span>;
  return <div className="deltas">{items}</div>;
}

function Decision({ r, busy, decide }) {
  const [target, setTarget] = useState(r.candidates[0]?.id || r.candidates[0]?.rowId || '');
  if (r.decision) {
    const label = { merge: 'You marked this as the same asset', create_new: 'You marked this as a different asset', skip: 'You chose to skip this row' }[r.decision];
    return (
      <div className="decision done">
        <span>{label}.</span>
        <button className="linkish" disabled={busy} onClick={() => decide([{ rowId: r.rowId, decision: null }])}>Undo</button>
      </div>
    );
  }
  return (
    <div className="decision">
      <div className="cands">
        {r.candidates.length > 1 ? (
          <select className="select select-sm" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Possible match">
            {r.candidates.map((c) => <option key={c.id || c.rowId} value={c.id || c.rowId}>{c.id ? code(c.asset_no) : `Row in ${c.filename}`} · Lot {c.lot || '—'}</option>)}
          </select>
        ) : r.candidates[0] && (
          <span className="muted">Possible match: <strong>{r.candidates[0].id ? code(r.candidates[0].asset_no) : `row in ${r.candidates[0].filename}`}</strong> · Lot “{r.candidates[0].lot || '—'}”</span>
        )}
      </div>
      <div className="seg">
        <button className="btn btn-sm" disabled={busy} onClick={() => decide([{ rowId: r.rowId, decision: 'merge', target }])}>Same asset</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => decide([{ rowId: r.rowId, decision: 'create_new' }])}>Different asset</button>
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => decide([{ rowId: r.rowId, decision: 'skip' }])}>Skip</button>
      </div>
    </div>
  );
}

function MappingPanel({ title, hint, entries, kind, options, onChange, busy }) {
  const list = Object.entries(entries).sort((a, b) => b[1].count - a[1].count);
  const createCount = list.filter(([, m]) => m.create).length;
  if (!list.length) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <div><h2>{title}</h2><div className="meta" style={{ marginTop: 2 }}>{hint}</div></div>
        {createCount > 0 && <span className="tag">{createCount} new</span>}
      </div>
      <div className="map-rows">
        {list.map(([key, m]) => {
          const value = m.ignore ? 'ignore' : m.create ? 'create' : `id:${m.team_id || m.facility_id}`;
          const set = (v) => {
            if (v === 'ignore') return onChange(kind, key, { ignore: true });
            if (v === 'create') return onChange(kind, key, kind === 'teams' ? { create: { name: m.source } } : { create: { name: m.source, facility_type: m.create?.facility_type || 'hospital' } });
            return onChange(kind, key, kind === 'teams' ? { team_id: v.slice(3) } : { facility_id: v.slice(3) });
          };
          return (
            <div className="map-row" key={key}>
              <div className="map-src">
                <span className="cell-primary">{m.source}</span>
                <span className="cell-sub">{fmtNum(m.count)} row{m.count === 1 ? '' : 's'}</span>
              </div>
              <ArrowRight size={14} className="subtle" aria-hidden />
              <div className="map-dst">
                <select className="select select-sm" value={value} disabled={busy} onChange={(e) => set(e.target.value)} aria-label={`Map ${m.source}`}>
                  <option value="create">{kind === 'teams' ? 'Create as new team' : 'Create as new facility'}</option>
                  {options.map((o) => <option key={o.id} value={`id:${o.id}`}>{o.label}</option>)}
                  <option value="ignore">Don’t assign</option>
                </select>
                {kind === 'locations' && m.create && (
                  <select className="select select-sm" value={m.create.facility_type} disabled={busy} aria-label={`Type of ${m.source}`}
                    onChange={(e) => onChange(kind, key, { create: { name: m.create.name, facility_type: e.target.value } })}>
                    {Object.entries(FACILITY_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { QrCode, ScanLine, Search, Download, ChevronDown, ChevronRight, CheckCircle2, MapPin } from 'lucide-react';
import { qs } from '../lib/api.js';
import { useApi, useMeta } from '../lib/useApi.js';
import { useAuth, isOrgWide } from '../lib/auth.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { ASSET_TYPE, FACILITY_TYPE, fmtNum, relTime } from '../lib/format.js';

/** Trays that still have no linked Arthrex QR label, grouped by where they are now. */
export default function Unlinked() {
  const { user } = useAuth();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const f = { q: params.get('q') || '', team_id: params.get('team_id') || '', facility_id: params.get('facility_id') || '' };
  const { data, error, loading } = useApi(`/assets/unlinked${qs(f)}`);
  const [closed, setClosed] = useState(new Set());
  const set = (k, v) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); setParams(n, { replace: true }); };
  const canLink = !!meta?.permissions.linkQr;

  const groups = useMemo(() => {
    const m = new Map();
    for (const a of data?.items || []) {
      const k = a.current_facility_id || 'none';
      if (!m.has(k)) m.set(k, { key: k, name: a.facility_name || 'No recorded location', type: a.facility_type, items: [] });
      m.get(k).items.push(a);
    }
    return [...m.values()];
  }, [data]);

  const s = data?.summary;
  const pct = s && s.total ? Math.round((s.linked / s.total) * 100) : 0;
  const filtered = !!(f.q || f.team_id || f.facility_id);
  const toggle = (k) => setClosed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n; });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Missing QR labels</h1>
          <p>Trays that aren’t linked to their Arthrex QR label yet, grouped by where they are now. {canLink ? 'Scan each label to link it.' : 'Scan a label to send a link request.'}</p>
        </div>
        <div className="head-actions">
          <a className="btn" href={`/api/exports/assets.xlsx${qs({ qr: 'none', team_id: f.team_id, facility_id: f.facility_id, q: f.q })}`} download>
            <Download aria-hidden /> Export list
          </a>
        </div>
      </div>

      <section className="panel link-progress" aria-label="Labeling progress">
        <div className="lp-text">
          <strong>{s ? `${fmtNum(s.linked)} of ${fmtNum(s.total)} trays linked` : '—'}</strong>
          <span className="muted">{s ? (s.unlinked ? `${fmtNum(s.unlinked)} still without a label link${isOrgWide(user) ? '' : ' in your teams'}` : 'Every tray has its label linked.') : ' '}</span>
        </div>
        <div className="lp-pct num">{s ? `${pct}%` : ''}</div>
        <div className="lp-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
      </section>

      {error && <div className="notice red" style={{ marginBottom: 16 }}>{error.message}</div>}

      <section className="panel table-panel">
        <div className="toolbar">
          <div className="search"><Search aria-hidden /><input className="input" placeholder="Tray name, description or lot" defaultValue={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search" /></div>
          <select className="select select-sm" value={f.facility_id} onChange={(e) => set('facility_id', e.target.value)} aria-label="Location">
            <option value="">All locations</option>{meta?.facilities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          {isOrgWide(user) && (
            <select className="select select-sm" value={f.team_id} onChange={(e) => set('team_id', e.target.value)} aria-label="Team">
              <option value="">All teams</option>{meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          {filtered && <button className="chip-clear" onClick={() => setParams({}, { replace: true })}>Clear filters</button>}
          <span className="spacer" />
          {data && <span className="muted" style={{ fontSize: 12.5 }}>{fmtNum(data.items.length)} tray{data.items.length === 1 ? '' : 's'} in {groups.length} location{groups.length === 1 ? '' : 's'}</span>}
        </div>

        {loading && !data && <div className="center-fill" style={{ minHeight: 200 }}><div className="spinner" /></div>}
        {data && data.items.length === 0 && (
          <div className="empty">
            {filtered ? <QrCode aria-hidden /> : <CheckCircle2 aria-hidden style={{ color: 'var(--green)' }} />}
            <strong>{filtered ? 'Nothing matches these filters' : 'All trays are linked'}</strong>
            {filtered ? 'Try clearing the filters.' : 'Every tray you can see has its QR label linked.'}
          </div>
        )}

        {groups.map((g) => {
          const open = !closed.has(g.key);
          return (
            <div key={g.key} className="ul-group">
              <button className="ul-head" onClick={() => toggle(g.key)} aria-expanded={open}>
                {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                <MapPin aria-hidden className="ul-pin" />
                <strong>{g.name}</strong>
                {g.type && <span className="tag">{FACILITY_TYPE[g.type]}</span>}
                <span className="ul-count">{g.items.length} without a label</span>
              </button>
              {open && (
                <ul className="ul-list">
                  {g.items.map((a) => (
                    <li key={a.id}>
                      <div className="ul-main">
                        <Link to={`/assets/${a.id}`} className="cell-primary">{a.reference}</Link>
                        <span className="cell-sub"><span className="mono">{a.asset_code}</span> · {ASSET_TYPE[a.asset_type]}{a.description ? ` · ${a.description}` : ''}</span>
                        <span className="cell-sub">{[a.team_name, a.custodian_name || a.rep_name].filter(Boolean).join(' · ') || 'No team or rep'}{a.last_scanned_at ? ` · last seen ${relTime(a.last_scanned_at)}` : ''}</span>
                      </div>
                      <StatusBadge status={a.status} />
                      <Link className="btn btn-sm btn-primary ul-act" to={`/scan?link=${a.id}&back=unlinked`}>
                        <ScanLine aria-hidden /> {canLink ? 'Scan to link' : 'Scan label'}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {data?.truncated && <div className="notice amber" style={{ margin: 14 }}>Showing the first 2,000 trays. Filter by location or team to see the rest.</div>}
      </section>
    </>
  );
}

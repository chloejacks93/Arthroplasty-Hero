import { Link, useNavigate } from 'react-router-dom';
import { Search as SearchIcon, Boxes as BoxesIcon, ArrowRight, ArrowLeftRight, CheckCircle2, FileSpreadsheet, QrCode, PackagePlus, AlertTriangle, Pencil, ScanLine, Stethoscope, ClipboardCheck, Circle } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { useAuth, isOrgWide } from '../lib/auth.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { EVENT_LABEL, fmtNum, relTime, ASSET_TYPE } from '../lib/format.js';

const EVENT_ICON = {
  created: PackagePlus, imported: FileSpreadsheet, qr_linked: QrCode, scanned: ScanLine,
  transfer_initiated: ArrowLeftRight, transfer_received: CheckCircle2, problem_reported: AlertTriangle,
  updated: Pencil, case_assigned: Stethoscope, audit_scanned: ClipboardCheck,
};

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, error } = useApi('/dashboard');
  const k = data?.kpis;
  const orgWide = isOrgWide(user);
  const firstName = user.full_name.replace(/\(.*?\)/g, '').trim().split(' ')[0];

  if (error) return <div className="notice red">{error.message}</div>;

  const v = (n) => (k ? fmtNum(n) : '—');
  const exceptions = k ? k.missing + k.overdue + k.investigating : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{orgWide ? 'Operations overview' : `Good ${greeting()}, ${firstName}`}</h1>
          <p>{orgWide ? 'Live position of every registered arthroplasty asset across all teams and facilities.' : 'Assets in your teams and custody.'}</p>
        </div>
        {orgWide && (
          <div className="head-actions">
            <Link to="/assets" className="btn">View all assets</Link>
          </div>
        )}
      </div>

      {!orgWide && (
        <nav className="action-tiles" aria-label="Quick actions">
          <Link to="/scan" className="tile tile-primary"><ScanLine aria-hidden /><strong>Scan asset</strong><span>Scan an existing QR label</span></Link>
          <Link to="/assets" className="tile" onClick={() => setTimeout(() => document.querySelector('.toolbar .search input')?.focus(), 150)}>
            <SearchIcon aria-hidden /><strong>Find a tray</strong><span>Search by name, lot or facility</span></Link>
          <Link to="/assets?mine=1" className="tile"><BoxesIcon aria-hidden /><strong>My assets</strong><span>Assigned to you or in your custody</span></Link>
        </nav>
      )}

      <section className="kpi-strip" aria-label="Key figures">
        <Link to="/assets" className="kpi">
          <span className="kpi-label"><span className="kpi-dot" />Registered assets</span>
          <span className="kpi-value">{v(k?.total)}</span>
          <span className="kpi-sub">{k ? `${fmtNum(k.trays)} trays · ${fmtNum(k.totes)} totes` : ' '}</span>
        </Link>
        <Link to="/assets?status=at_facility" className="kpi tone-green">
          <span className="kpi-label"><span className="kpi-dot" />At facilities</span>
          <span className="kpi-value">{v(k?.at_facilities)}</span>
          <span className="kpi-sub">{k ? `${fmtNum(k.on_case)} assigned to cases` : ' '}</span>
        </Link>
        <Link to="/assets?status=at_warehouse" className="kpi">
          <span className="kpi-label"><span className="kpi-dot" />At warehouse</span>
          <span className="kpi-value">{v(k?.at_warehouse)}</span>
          <span className="kpi-sub">{k ? `${fmtNum(k.out_of_service)} out of service` : ' '}</span>
        </Link>
        <Link to="/assets?status=in_transit" className="kpi tone-blue">
          <span className="kpi-label"><span className="kpi-dot" />In transit</span>
          <span className="kpi-value">{v(k?.in_transit)}</span>
          <span className="kpi-sub">{k ? `${fmtNum(k.awaiting)} awaiting receipt` : ' '}</span>
        </Link>
        <Link to="/assets?status=missing" className="kpi tone-red">
          <span className="kpi-label"><span className="kpi-dot" />Missing</span>
          <span className={`kpi-value${k?.missing ? ' has' : ''}`}>{v(k?.missing)}</span>
          <span className="kpi-sub">{k ? `${fmtNum(k.investigating)} under investigation` : ' '}</span>
        </Link>
        <Link to="/assets?status=overdue" className="kpi tone-amber">
          <span className="kpi-label"><span className="kpi-dot" />Overdue</span>
          <span className={`kpi-value${k?.overdue ? ' has' : ''}`}>{v(k?.overdue)}</span>
          <span className="kpi-sub">{k ? `${fmtNum(k.past_deadline)} transfers past deadline` : ' '}</span>
        </Link>
      </section>

      <div className="dash-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Requires attention</h2>
              <Link to="/assets?attention=1">View all <ArrowRight aria-hidden /></Link>
            </div>
            <DataTable
              auto
              compact
              rows={data?.attention}
              loading={!data}
              onRowClick={(r) => navigate(`/assets/${r.id}`)}
              empty={{ title: 'All clear', body: 'No missing, overdue or unconfirmed assets.' }}
              columns={[
                { key: 'reference', header: 'Asset', mobile: 'primary', render: (r) => (
                  <span className="stacked"><span className="cell-primary">{r.reference}</span><span className="cell-sub">{r.asset_code} · {ASSET_TYPE[r.asset_type]}</span></span>
                ) },
                { key: 'status', header: 'Status', mobile: 'status', render: (r) => <StatusBadge status={r.status} /> },
                { key: 'facility_name', header: 'Last known location', mobile: 'full', label: 'Location', className: 'trunc' },
                { key: 'rep_name', header: 'Representative', mobile: 'hide', className: 'trunc' },
                { key: 'updated_at', header: 'Updated', align: 'right', mobile: 'hide', render: (r) => <span className="muted">{relTime(r.updated_at)}</span> },
              ]}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Recent activity</h2>
              <span className="meta">Permanent movement ledger</span>
            </div>
            {data && data.recent.length === 0 && <div className="empty"><strong>No activity yet</strong>Movements, scans and imports will appear here.</div>}
            <ul className="feed">
              {data?.recent.map((e) => {
                const Icon = EVENT_ICON[e.event_type] || Circle;
                return (
                  <li key={e.id}>
                    <span className="ico"><Icon aria-hidden /></span>
                    <div>
                      <div className="line">
                        <Link to={`/assets/${e.asset_id}`}>{e.reference}</Link>{' '}
                        <span className="muted">· {EVENT_LABEL[e.event_type] || e.event_type}{e.to_facility ? ` → ${e.to_facility}` : ''}</span>
                      </div>
                      <div className="when">{e.actor_name} · {relTime(e.occurred_at)}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Assets by location</h2>
              <span className="meta">Top {data?.byFacility.length || 0}</span>
            </div>
            <div className="bars" style={{ padding: '6px 0 10px' }}>
              {data?.byFacility.map((f) => {
                const max = data.byFacility[0]?.count || 1;
                return (
                  <Link key={f.id} to={`/assets?facility_id=${f.id}`} className={`bar-row${f.facility_type === 'warehouse' ? ' warehouse' : ''}`}>
                    <span className="name">{f.name}{f.exceptions > 0 && <span className="exc">{f.exceptions} exception{f.exceptions > 1 ? 's' : ''}</span>}</span>
                    <span className="val">{f.count}</span>
                    <span className="bar-track"><span className="bar-fill" style={{ width: `${(f.count / max) * 100}%`, display: 'block' }} /></span>
                  </Link>
                );
              })}
              {data && data.byFacility.length === 0 && <div className="empty">No assets have a recorded location yet.</div>}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Data quality</h2></div>
            <dl className="facts tight" style={{ gridTemplateColumns: '1fr', margin: 0 }}>
              <div className="fact" style={{ borderRight: 0 }}>
                <dt>Assets without a linked QR code</dt>
                <dd className="num">{v(k?.unlinked_qr)}{k && k.total > 0 && <span className="subtle"> · {Math.round((k.unlinked_qr / k.total) * 100)}% of registry</span>}</dd>
              </div>
              <div className="fact" style={{ borderRight: 0, borderBottom: 0 }}>
                <dt>Open exceptions (missing, overdue, investigating)</dt>
                <dd className="num">{k ? fmtNum(exceptions) : '—'}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

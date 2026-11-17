import { Link, useNavigate } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { DataTable } from '../components/DataTable.jsx';
import { fmtDateTime, fmtNum } from '../lib/format.js';

const STATUS = { committed: ['Imported', 'green'], preview: ['Awaiting approval', 'amber'], cancelled: ['Cancelled', 'slate'] };

export default function Imports() {
  const navigate = useNavigate();
  const { data, error, loading } = useApi('/imports');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Spreadsheet imports</h1>
          <p>Every upload is previewed, checked for duplicates and conflicts, and approved before it changes the registry.</p>
        </div>
        <div className="head-actions">
          <Link to="/imports/new" className="btn btn-primary"><Upload aria-hidden /> New import</Link>
        </div>
      </div>
      {error && <div className="notice red">{error.message}</div>}
      <section className="panel table-panel">
        <div className="panel-head"><h2>Import history</h2><span className="meta">{data ? `${data.items.length} file${data.items.length === 1 ? '' : 's'}` : ''}</span></div>
        <DataTable
          auto
          rows={data?.items}
          loading={loading}
          onRowClick={(r) => navigate(`/imports/${r.batch_id}`)}
          empty={{ title: 'No imports yet', body: 'Upload your first spreadsheet to build the master asset registry.' }}
          columns={[
            { key: 'filename', header: 'File', mobile: 'primary', render: (r) => (
              <span className="stacked"><span className="cell-primary">{r.filename}</span><span className="cell-sub">{fmtNum(r.row_count)} rows{r.team_name ? ` · ${r.team_name}` : ''}</span></span>
            ) },
            { key: 'status', header: 'Status', mobile: 'status', render: (r) => <span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span> },
            { key: 'uploaded_at', header: 'Uploaded', mobile: 'full', render: (r) => <span className="muted">{fmtDateTime(r.uploaded_at)}</span> },
            { key: 'uploaded_by_name', header: 'By', mobile: 'hide' },
            { key: 'new_count', header: 'New', align: 'right', mobile: 'full', label: 'New', render: (r) => num(r, 'new_count') },
            { key: 'updated_count', header: 'Updated', align: 'right', mobile: 'hide', render: (r) => num(r, 'updated_count') },
            { key: 'duplicate_count', header: 'Duplicates', align: 'right', mobile: 'hide', render: (r) => num(r, 'duplicate_count') },
            { key: 'conflict_count', header: 'Conflicts', align: 'right', mobile: 'full', label: 'Conflicts', render: (r) => (
              r.status !== 'committed' ? <span className="subtle">—</span>
                : <span className="num">{r.conflict_count}{r.open_conflicts > 0 && <span className="exc" style={{ marginLeft: 6 }}>{r.open_conflicts} open</span>}</span>
            ) },
          ]}
        />
      </section>
    </>
  );
}

const num = (r, k) => (r.status === 'committed' ? <span className="num">{fmtNum(r[k])}</span> : <span className="subtle">—</span>);

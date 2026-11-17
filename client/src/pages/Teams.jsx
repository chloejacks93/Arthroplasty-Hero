import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi, refreshMeta } from '../lib/useApi.js';
import { DataTable } from '../components/DataTable.jsx';
import { Modal } from '../components/Modal.jsx';

export default function Teams() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('active');
  const { data, error, loading, reload } = useApi(`/teams?status=${status}`);
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState(null);
  const canEdit = data?.canEdit;

  const toggle = async (t) => {
    setMsg(null);
    try {
      await api.patch(`/teams/${t.id}`, { active: !t.active });
      setMsg({ tone: 'green', text: `${t.name} ${t.active ? 'deactivated. Its assets keep the team, but it’s hidden from pickers' : 'reactivated'}.` });
      reload(); refreshMeta();
    } catch (e) { setMsg({ tone: 'red', text: e.message }); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Teams</h1><p>Arthroplasty teams. A representative sees the assets of the teams they belong to.</p></div>
        {canEdit && <div className="head-actions"><button className="btn btn-primary" onClick={() => setEdit({})}><Plus aria-hidden /> Add team</button></div>}
      </div>
      {msg && <div className={`notice ${msg.tone}`} style={{ marginBottom: 16 }}>{msg.tone === 'green' ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}{msg.text}</div>}
      {error && <div className="notice red">{error.message}</div>}
      <section className="panel table-panel">
        <div className="toolbar">
          <select className="select select-sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="active">Active</option><option value="inactive">Deactivated</option><option value="all">All</option>
          </select>
        </div>
        <DataTable
          auto
          rows={data?.items}
          loading={loading}
          onRowClick={(t) => navigate(`/assets?team_id=${t.id}`)}
          empty={{ title: 'No teams', body: canEdit ? 'Add a team, or import a spreadsheet to create them from the Warehouse column.' : '' }}
          columns={[
            { key: 'name', header: 'Team', mobile: 'primary', render: (t) => <span className="stacked"><span className="cell-primary">{t.name}</span><span className="cell-sub">{t.description || (t.code ? `Code ${t.code}` : '')}</span></span> },
            { key: 'status', header: '', mobile: 'status', render: (t) => (t.active ? null : <span className="badge slate">Deactivated</span>) },
            { key: 'members', header: 'Members', align: 'right', mobile: 'full', label: 'Members', render: (t) => <Link to={`/people?team_id=${t.id}`} onClick={(e) => e.stopPropagation()} className="num">{t.members}</Link> },
            { key: 'assets', header: 'Assets', align: 'right', mobile: 'full', label: 'Assets', render: (t) => <span className="num">{t.assets}</span> },
            { key: 'mix', header: 'Trays · totes', align: 'right', mobile: 'hide', render: (t) => <span className="num muted">{t.trays} · {t.totes}</span> },
            { key: 'transit', header: 'In transit', align: 'right', mobile: 'hide', render: (t) => <span className="num">{t.in_transit}</span> },
            { key: 'exc', header: 'Exceptions', align: 'right', mobile: 'full', label: 'Exceptions', render: (t) => t.exceptions ? <span className="exc num">{t.exceptions}</span> : <span className="subtle">0</span> },
            ...(canEdit ? [{ key: 'act', header: '', align: 'right', mobile: 'full', render: (t) => (
              <div className="seg right-seg" onClick={(e) => e.stopPropagation()}>
                <button className="btn btn-sm" onClick={() => setEdit(t)}>Edit</button>
                <button className="btn btn-sm btn-ghost" onClick={() => toggle(t)}>{t.active ? 'Deactivate' : 'Reactivate'}</button>
              </div>
            ) }] : []),
          ]}
        />
      </section>
      {edit && <TeamModal team={edit} onClose={() => setEdit(null)} onSaved={(t) => { setEdit(null); setMsg({ tone: 'green', text: `${t.name} saved.` }); reload(); refreshMeta(); }} />}
    </>
  );
}

function TeamModal({ team, onClose, onSaved }) {
  const isNew = !team.id;
  const [form, setForm] = useState({ name: team.name || '', code: team.code || '', description: team.description || '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    const body = { name: form.name, code: form.code || null, description: form.description || null };
    try { const r = isNew ? await api.post('/teams', body) : await api.patch(`/teams/${team.id}`, body); onSaved(r.team); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={isNew ? 'Add team' : `Edit ${team.name}`} onClose={onClose}
      actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || form.name.trim().length < 2} onClick={submit}>Save</button></>}>
      <div className="form-grid">
        <div className="field span2"><label htmlFor="tn">Name</label><input id="tn" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></div>
        <div className="field"><label htmlFor="tc">Code <span className="subtle">(optional)</span></label><input id="tc" className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
        <div className="field span2"><label htmlFor="td">Description <span className="subtle">(optional)</span></label><input id="td" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        {err && <div className="form-error span2">{err}</div>}
      </div>
    </Modal>
  );
}

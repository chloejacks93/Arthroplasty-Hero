import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { UserPlus, Search, KeyRound, Copy, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, qs } from '../lib/api.js';
import { useApi, useMeta, refreshMeta } from '../lib/useApi.js';
import { useAuth } from '../lib/auth.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { Modal } from '../components/Modal.jsx';
import { ROLE_LABEL, relTime } from '../lib/format.js';

const ROLE_HELP = {
  rep: 'Sees assets in their teams, assigned to them or in their custody. Scans, transfers, receives, reports problems.',
  inventory: 'Sees everything. Imports spreadsheets, links QR codes, runs audits, works investigations.',
  manager: 'Sees everything. Reports, conflicts, investigations, reassignment.',
  admin: 'Everything above, plus users, teams and facilities.',
};

export default function People() {
  const { user: me } = useAuth();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const f = { q: params.get('q') || '', role: params.get('role') || '', team_id: params.get('team_id') || '', status: params.get('status') || 'active' };
  const { data, error, loading, reload } = useApi(`/users${qs(f)}`);
  const [edit, setEdit] = useState(null); // user object or {} for new
  const [secret, setSecret] = useState(null); // { name, password }
  const [msg, setMsg] = useState(null);
  const set = (k, v) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); setParams(n, { replace: true }); };
  const canEdit = data?.canEdit;

  const toggleActive = async (u) => {
    setMsg(null);
    try {
      await api.patch(`/users/${u.id}`, { active: !u.active });
      setMsg({ tone: 'green', text: `${u.full_name} ${u.active ? 'deactivated and signed out everywhere' : 'reactivated'}.` });
      reload(); refreshMeta();
    } catch (e) { setMsg({ tone: 'red', text: e.message }); }
  };
  const reset = async (u) => {
    setMsg(null);
    try {
      const r = await api.post(`/users/${u.id}/reset-password`);
      setSecret({ name: u.full_name, email: u.email, password: r.temporaryPassword, reset: true });
      reload();
    } catch (e) { setMsg({ tone: 'red', text: e.message }); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>People</h1><p>Representatives, inventory, management and administrators.</p></div>
        {canEdit && <div className="head-actions"><button className="btn btn-primary" onClick={() => setEdit({})}><UserPlus aria-hidden /> Add person</button></div>}
      </div>
      {msg && <div className={`notice ${msg.tone}`} style={{ marginBottom: 16 }}>{msg.tone === 'green' ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}{msg.text}</div>}
      {error && <div className="notice red" style={{ marginBottom: 16 }}>{error.message}</div>}
      <section className="panel table-panel">
        <div className="toolbar">
          <div className="search"><Search aria-hidden /><input className="input" placeholder="Name or email" defaultValue={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search people" /></div>
          <select className="select select-sm" value={f.role} onChange={(e) => set('role', e.target.value)} aria-label="Role">
            <option value="">All roles</option>{Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="select select-sm" value={f.team_id} onChange={(e) => set('team_id', e.target.value)} aria-label="Team">
            <option value="">All teams</option>{meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="select select-sm" value={f.status} onChange={(e) => set('status', e.target.value === 'active' ? '' : e.target.value)} aria-label="Status">
            <option value="active">Active</option><option value="inactive">Deactivated</option><option value="all">All</option>
          </select>
        </div>
        <DataTable
          rows={data?.items}
          loading={loading}
          empty={{ title: 'No people', body: 'Nobody matches these filters.' }}
          columns={[
            { key: 'name', header: 'Name', mobile: 'primary', render: (u) => (
              <span className="stacked"><span className="cell-primary">{u.full_name}{u.id === me.id ? ' (you)' : ''}</span><span className="cell-sub">{u.email}</span></span>
            ) },
            { key: 'role', header: 'Role', mobile: 'status', render: (u) => (
              u.active ? <span className={`badge ${u.role === 'rep' ? 'blue' : u.role === 'admin' ? 'indigo' : 'slate'}`}>{ROLE_LABEL[u.role]}</span> : <span className="badge slate">Deactivated</span>
            ) },
            { key: 'teams', header: 'Teams', mobile: 'full', label: 'Teams', className: 'wrap-cell', render: (u) => u.teams.length ? u.teams.map((t) => t.name).join(', ') : <span className="subtle">—</span> },
            { key: 'assets', header: 'Assigned · in custody', mobile: 'full', label: 'Assets', render: (u) => (
              <span className="num"><Link to={`/assets?rep_id=${u.id}`}>{u.assigned_assets}</Link> · {u.custody_assets}{u.incoming_transfers ? <span className="exc" style={{ marginLeft: 6 }}>{u.incoming_transfers} incoming</span> : null}</span>
            ) },
            { key: 'login', header: 'Last sign-in', mobile: 'hide', render: (u) => (
              u.must_change_password ? <span className="tag">Awaiting first sign-in</span> : <span className="muted">{u.last_login_at ? relTime(u.last_login_at) : 'Never'}</span>
            ) },
            ...(canEdit ? [{ key: 'act', header: '', align: 'right', mobile: 'full', render: (u) => (
              <div className="seg right-seg">
                <button className="btn btn-sm" onClick={() => setEdit(u)}>Edit</button>
                {u.active && <button className="btn btn-sm btn-ghost" onClick={() => reset(u)} title="Issue a new temporary password"><KeyRound aria-hidden /> Reset</button>}
                {u.id !== me.id && <button className="btn btn-sm btn-ghost" onClick={() => toggleActive(u)}>{u.active ? 'Deactivate' : 'Reactivate'}</button>}
              </div>
            ) }] : []),
          ]}
        />
      </section>
      {edit && (
        <UserModal user={edit} teams={meta?.teams || []} onClose={() => setEdit(null)}
          onSaved={(r) => { setEdit(null); reload(); refreshMeta(); if (r.temporaryPassword) setSecret({ name: r.user.full_name, email: r.user.email, password: r.temporaryPassword }); else setMsg({ tone: 'green', text: `${r.user.full_name} saved.` }); }} />
      )}
      {secret && <SecretModal s={secret} onClose={() => setSecret(null)} />}
    </>
  );
}

function UserModal({ user, teams, onClose, onSaved }) {
  const isNew = !user.id;
  const [form, setForm] = useState({
    email: user.email || '', full_name: user.full_name || '', role: user.role || 'rep', title: user.title || '', phone: user.phone || '',
    team_ids: (user.teams || []).map((t) => t.id),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleTeam = (id) => set('team_ids', form.team_ids.includes(id) ? form.team_ids.filter((x) => x !== id) : [...form.team_ids, id]);
  const submit = async () => {
    setBusy(true); setErr('');
    const body = { full_name: form.full_name, role: form.role, title: form.title || null, phone: form.phone || null, team_ids: form.team_ids };
    try {
      const r = isNew ? await api.post('/users', { ...body, email: form.email }) : await api.patch(`/users/${user.id}`, body);
      onSaved(r);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={isNew ? 'Add person' : `Edit ${user.full_name}`} onClose={onClose}
      actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !form.full_name.trim() || (isNew && !form.email.includes('@'))} onClick={submit}>{isNew ? 'Add and create password' : 'Save'}</button></>}>
      <div className="form-grid">
        {isNew && <div className="field span2"><label htmlFor="ue">Work email</label><input id="ue" className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoFocus /></div>}
        <div className="field span2"><label htmlFor="un">Full name</label><input id="un" className="input" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} /></div>
        <div className="field"><label htmlFor="ut">Title <span className="subtle">(optional)</span></label><input id="ut" className="input" value={form.title} onChange={(e) => set('title', e.target.value)} /></div>
        <div className="field"><label htmlFor="up">Mobile <span className="subtle">(optional)</span></label><input id="up" className="input" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="field span2"><label htmlFor="ur">Role</label>
          <select id="ur" className="select" value={form.role} onChange={(e) => set('role', e.target.value)}>
            {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <span className="subtle" style={{ fontSize: 12 }}>{ROLE_HELP[form.role]}</span></div>
        <fieldset className="field span2 team-checks">
          <legend>Teams</legend>
          {teams.length === 0 && <span className="subtle">No teams yet.</span>}
          {teams.map((t) => (
            <label key={t.id} className="check-row"><input type="checkbox" className="check" checked={form.team_ids.includes(t.id)} onChange={() => toggleTeam(t.id)} /> {t.name}</label>
          ))}
        </fieldset>
        {isNew && <p className="subtle span2" style={{ margin: 0, fontSize: 12 }}>A temporary password is generated. They’ll set their own at first sign-in.</p>}
        {err && <div className="form-error span2">{err}</div>}
      </div>
    </Modal>
  );
}

function SecretModal({ s, onClose }) {
  const [copied, setCopied] = useState(false);
  const text = `Arthroplasty Hero sign-in\nEmail: ${s.email}\nTemporary password: ${s.password}\n${window.location.origin}`;
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };
  return (
    <Modal title={s.reset ? 'New temporary password' : 'Person added'} onClose={onClose} actions={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ margin: 0 }}>Give <strong>{s.name}</strong> this temporary password in person or by text. <strong>It won’t be shown again.</strong> They’ll choose their own when they sign in.</p>
        <div className="secret"><span className="mono">{s.password}</span><button className="btn btn-sm" onClick={copy}><Copy aria-hidden /> {copied ? 'Copied' : 'Copy sign-in details'}</button></div>
        {s.reset && <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Their existing sessions were signed out.</p>}
      </div>
    </Modal>
  );
}

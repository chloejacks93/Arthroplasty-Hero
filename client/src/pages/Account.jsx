import { useState } from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { BrandMark } from '../components/BrandMark.jsx';
import { ROLE_LABEL } from '../lib/format.js';

function PasswordForm({ onDone, submitLabel = 'Change password' }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const mismatch = confirm && next !== confirm;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.post('/auth/change-password', { currentPassword: cur, newPassword: next });
      setCur(''); setNext(''); setConfirm('');
      onDone();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 14 }} noValidate>
      {err && <div className="form-error" role="alert">{err}</div>}
      <div className="field"><label htmlFor="cur">Current (or temporary) password</label>
        <input id="cur" type="password" className="input" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
      <div className="field"><label htmlFor="np">New password</label>
        <input id="np" type="password" className="input" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <span className="subtle" style={{ fontSize: 12 }}>At least 10 characters. A short phrase is easiest to remember.</span></div>
      <div className="field"><label htmlFor="cp">Confirm new password</label>
        <input id="cp" type="password" className="input" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {mismatch && <span style={{ fontSize: 12, color: 'var(--red)' }}>Passwords don’t match.</span>}</div>
      <button className="btn btn-primary btn-lg btn-block" disabled={busy || !cur || next.length < 10 || next !== confirm}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}

/** Full-screen gate shown after signing in with a temporary password. */
export function ForcePasswordChange() {
  const { user, refresh, logout } = useAuth();
  return (
    <div className="auth" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-mobile-brand" style={{ display: 'flex' }}><BrandMark size={30} /><strong>Arthroplasty <em className="brand-hero">Hero</em></strong></div>
          <h1>Set your password</h1>
          <p>Welcome, {user.full_name.split(' ')[0]}. Replace the temporary password you were given to continue.</p>
          <PasswordForm onDone={refresh} submitLabel="Save and continue" />
          <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={logout}>Sign out</button>
        </div>
      </main>
    </div>
  );
}

export default function Account() {
  const { user } = useAuth();
  const [done, setDone] = useState(false);
  return (
    <div className="flow-page">
      <div className="page-head"><div><h1>Your account</h1><p>{user.full_name} · {user.email} · {ROLE_LABEL[user.role]}</p></div></div>
      <section className="panel flow-panel">
        <div className="panel-head"><h2><KeyRound size={15} aria-hidden style={{ verticalAlign: -2, marginRight: 6 }} />Change password</h2></div>
        <div className="panel-body">
          {done && <div className="notice green" style={{ marginBottom: 14 }}><CheckCircle2 aria-hidden />Password changed. Other devices were signed out.</div>}
          <PasswordForm onDone={() => setDone(true)} />
        </div>
      </section>
    </div>
  );
}

import { useState } from 'react';
import { ShieldCheck, History, ScanLine } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { BrandMark } from '../components/BrandMark.jsx';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth-aside">
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <strong>Arthroplasty <em className="brand-hero">Hero</em></strong>
            <span>Tray &amp; tote control</span>
          </div>
        </div>
        <div className="auth-pitch">
          <h2>Every tray and tote, accounted for.</h2>
          <p>One system of record for where each asset is, who is responsible for it, and where it has been.</p>
          <ul className="auth-points">
            <li><ScanLine aria-hidden /> Scan the existing QR label. No relabeling.</li>
            <li><ShieldCheck aria-hidden /> Transfers complete only on confirmed receipt</li>
            <li><History aria-hidden /> Permanent, tamper-proof movement history</li>
          </ul>
        </div>
        <div className="auth-foot">Internal use only · Do not enter patient information</div>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-mobile-brand">
            <BrandMark size={30} />
            <strong>Arthroplasty <em className="brand-hero">Hero</em></strong>
          </div>
          <h1>Sign in</h1>
          <p>Use your company email and password.</p>
          <form onSubmit={submit} noValidate>
            {error && <div className="form-error" role="alert">{error}</div>}
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" inputMode="email"
                value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || !email || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

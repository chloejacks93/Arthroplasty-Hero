import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { LayoutDashboard, Boxes, Search, LogOut, Menu, FileSpreadsheet, GitCompareArrows, ScanLine, QrCode } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { initials, ROLE_LABEL } from '../lib/format.js';
import { refreshMeta, useMeta } from '../lib/useApi.js';
import { BrandMark } from './BrandMark.jsx';

// Navigation grows phase by phase. Only modules that are actually built are listed.
function buildNav(meta) {
  const nav = [
    {
      label: 'Operations',
      items: [
        { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
        { to: '/scan', label: 'Scan Asset', icon: ScanLine },
        { to: '/assets', label: 'Asset Registry', icon: Boxes },
      ],
    },
  ];
  const data = [];
  if (meta?.permissions.importData) data.push({ to: '/imports', label: 'Imports', icon: FileSpreadsheet });
  if (meta?.permissions.linkQr) data.push({ to: '/qr-requests', label: 'QR Link Requests', icon: QrCode, count: meta.counts.pendingQrRequests });
  if (meta?.permissions.resolveConflicts) data.push({ to: '/conflicts', label: 'Conflicts', icon: GitCompareArrows, count: meta.counts.openConflicts });
  if (data.length) nav.push({ label: 'Data', items: data });
  return nav;
}

export function Shell() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const meta = useMeta();
  const NAV = buildNav(meta);
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => { refreshMeta(); }, [user.id]);

  return (
    <div className={`shell${open ? ' nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <strong>Asset Control</strong>
            <span>Arthroplasty Operations</span>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((section) => (
            <div className="nav-section" key={section.label}>
              <div className="nav-label">{section.label}</div>
              {section.items.map(({ to, label, icon: Icon, end, count }) => (
                <NavLink key={to} to={to} end={end} className="nav-link">
                  <Icon aria-hidden /> {label}
                  {count > 0 && <span className="count" aria-label={`${count} open`}>{count}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip">
            <div className="avatar" aria-hidden>{initials(user.full_name)}</div>
            <div className="who">
              <strong title={user.full_name}>{user.full_name}</strong>
              <span>{ROLE_LABEL[user.role] || user.role}</span>
            </div>
            <button className="icon-btn" onClick={logout} title="Sign out" aria-label="Sign out">
              <LogOut />
            </button>
          </div>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open navigation">
            <Menu />
          </button>
          <GlobalSearch />
          <div className="topbar-right">
            {location.pathname !== '/scan' && (
              <Link to="/scan" className="btn btn-primary scan-btn" aria-label="Scan asset"><ScanLine aria-hidden /><span>Scan</span></Link>
            )}
            <span className="env-tag">{new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())}</span>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function GlobalSearch() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const ref = useRef(null);
  const [value, setValue] = useState(location.pathname === '/assets' ? params.get('q') || '' : '');

  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !/input|textarea|select/i.test(e.target.tagName))) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const q = value.trim();
    navigate(q ? `/assets?q=${encodeURIComponent(q)}` : '/assets');
    ref.current?.blur();
  };

  return (
    <form className="global-search" role="search" onSubmit={submit}>
      <Search className="lead" aria-hidden />
      <label htmlFor="gsearch" className="sr-only">Search assets</label>
      <input
        id="gsearch"
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by asset, QR UUID, lot, serial, facility or rep"
        autoComplete="off"
        enterKeyHint="search"
      />
      <span className="kbd">⌘K</span>
    </form>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api } from '../lib/api.js';
import { refreshMeta, useMeta } from '../lib/useApi.js';
import { relTime } from '../lib/format.js';

export function NotificationBell() {
  const meta = useMeta();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const ref = useRef(null);
  const unread = meta?.counts.unreadNotifications || 0;

  // Refresh counts every 60 s while the app is open, so incoming transfers show up without reloading.
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) refreshMeta(); }, 60000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    api.get('/notifications').then(setData).catch(() => setData({ items: [], unread: 0 }));
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const go = async (n) => {
    setOpen(false);
    if (!n.read_at) await api.post('/notifications/read', { ids: [n.id] }).catch(() => {});
    refreshMeta();
    if (n.link) navigate(n.link);
  };
  const readAll = async () => {
    await api.post('/notifications/read', { all: true }).catch(() => {});
    setData((d) => d && { ...d, items: d.items.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })) });
    refreshMeta();
  };

  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn bell-btn" onClick={() => setOpen(!open)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open}>
        <Bell />
        {unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-pop" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <strong>Notifications</strong>
            {data?.items.some((n) => !n.read_at) && <button className="linkish" onClick={readAll}>Mark all read</button>}
          </div>
          <ul>
            {!data && <li className="subtle bell-empty">Loading…</li>}
            {data?.items.length === 0 && <li className="subtle bell-empty">You’re all caught up.</li>}
            {data?.items.map((n) => (
              <li key={n.id}>
                <button className={n.read_at ? '' : 'unread'} onClick={() => go(n)}>
                  <span className="bn-title">{n.title}</span>
                  {n.body && <span className="bn-body">{n.body}</span>}
                  <span className="bn-when">{relTime(n.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

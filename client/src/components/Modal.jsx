import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, actions, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    // Focus the first (safe) footer action, never the destructive one by default.
    (ref.current?.querySelector('.modal-foot button') || ref.current?.querySelector('button'))?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-foot">{actions}</div>}
      </div>
    </div>
  );
}

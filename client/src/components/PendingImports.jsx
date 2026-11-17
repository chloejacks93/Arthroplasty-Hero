import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { useMeta } from '../lib/useApi.js';

/** Reminder that uploaded spreadsheets are not in the registry until approved. */
export function PendingImports() {
  const meta = useMeta();
  const n = meta?.counts.pendingImports || 0;
  if (!n) return null;
  return (
    <div className="notice amber pending-imports" style={{ marginBottom: 16 }}>
      <AlertTriangle aria-hidden />
      <span>
        <strong>{n} spreadsheet import{n > 1 ? 's are' : ' is'} waiting for your approval.</strong> Trays are not added until you approve.{' '}
        <Link to="/imports">Review and approve</Link>
      </span>
    </div>
  );
}

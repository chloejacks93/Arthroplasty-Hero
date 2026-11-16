import { STATUS } from '../lib/format.js';

export function StatusBadge({ status }) {
  const s = STATUS[status] || { label: status, tone: 'slate' };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

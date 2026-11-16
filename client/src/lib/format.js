// Shared vocabulary for statuses, types and dates.
export const STATUS = {
  at_warehouse:        { label: 'At Warehouse',        tone: 'slate' },
  at_facility:         { label: 'At Facility',         tone: 'green' },
  in_transit:          { label: 'In Transit',          tone: 'blue' },
  assigned_to_case:    { label: 'Assigned to Case',    tone: 'indigo' },
  awaiting_receipt:    { label: 'Awaiting Receipt',    tone: 'amber' },
  overdue:             { label: 'Overdue',             tone: 'amber' },
  missing:             { label: 'Missing',             tone: 'red' },
  under_investigation: { label: 'Under Investigation', tone: 'red' },
  out_of_service:      { label: 'Out of Service',      tone: 'slate' },
};

export const ASSET_TYPE = {
  tray: 'Tray',
  tote: 'Tote',
  implant_set: 'Implant Set',
  instrument_set: 'Instrument Set',
  loaner_kit: 'Loaner Kit',
  other: 'Other',
};

export const FACILITY_TYPE = {
  warehouse: 'Warehouse',
  hospital: 'Hospital',
  surgery_center: 'Surgery Center',
  clinic: 'Clinic',
  other: 'Other',
};

export const EVENT_LABEL = {
  created: 'Asset registered',
  imported: 'Updated from spreadsheet import',
  updated: 'Record updated',
  qr_linked: 'QR code linked',
  qr_unlinked: 'QR code unlinked',
  scanned: 'Scanned',
  transfer_initiated: 'Transfer initiated',
  transfer_received: 'Receipt confirmed',
  transfer_cancelled: 'Transfer cancelled',
  transfer_rejected: 'Transfer rejected',
  status_changed: 'Status changed',
  location_corrected: 'Location corrected',
  reassigned: 'Representative reassigned',
  case_assigned: 'Assigned to case',
  case_released: 'Released from case',
  audit_scanned: 'Scanned during audit',
  problem_reported: 'Problem reported',
  investigation_updated: 'Investigation updated',
  conflict_resolved: 'Import conflict resolved',
  retired: 'Retired',
};

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const fmtDate = (v) => {
  if (!v) return '—';
  // DATE columns arrive as YYYY-MM-DD; parse as local date to avoid TZ shift.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
};
export const fmtDateTime = (v) => (v ? dateTimeFmt.format(new Date(v)) : '—');
export const fmtMoney = (v) => (v == null ? '—' : money.format(v));
export const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));

export function relTime(v) {
  if (!v) return 'Never';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(v);
}

export const initials = (name = '') =>
  name.replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');

export const ROLE_LABEL = { admin: 'Administrator', manager: 'Management', inventory: 'Inventory', rep: 'Representative' };

// Column mapping and value normalisation for spreadsheet imports.
// Source sheets store almost everything as text ("$36,000.00", "25.0", "8"),
// so every value is parsed defensively and the original text is preserved.

/** Lower-case, alphanumerics only: "Total Cases Last 12 Months" -> "totalcaseslast12months". */
export const headerKey = (h) => {
  const k = String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
  return HEADER_ALIASES[k] || k;
};

// alias -> canonical key
const HEADER_ALIASES = {
  ref: 'reference', kit: 'reference', kitname: 'reference', kitreference: 'reference', setname: 'reference', assetname: 'reference', setreference: 'reference',
  kittype: 'type', assettype: 'type', settype: 'type',
  desc: 'description', kitdescription: 'description',
  subinventory: 'warehouse',
  currentlocation: 'location', account: 'location', facility: 'location',
  lotnumber: 'lot', lotno: 'lot', lotbatch: 'lot',
  serial: 'serialnumber', sn: 'serialnumber', serialno: 'serialnumber',
  qr: 'qr', qrcode: 'qr', uuid: 'qr', qruuid: 'qr', qrvalue: 'qr', assetuuid: 'qr',
  catalog: 'catalognumber', catalogno: 'catalognumber', partnumber: 'catalognumber',
  consignment: 'consignmentfee', fee: 'consignmentfee',
  duedate: 'returndate',
  itemcount: 'items', qty: 'items', quantity: 'items',
  flag: 'flags', note: 'notes', comments: 'notes',
  utilizationfactor: 'setutilizationfactor', setutilization: 'setutilizationfactor',
  totalcases: 'totalcaseslast12months', caseslast12months: 'totalcaseslast12months', cases12months: 'totalcaseslast12months',
  representative: 'rep', salesrep: 'rep', assignedrep: 'rep', assignedrepresentative: 'rep',
  teamname: 'team',
};

// canonical key -> asset field + parser
export const COLUMN_MAP = {
  reference: { field: 'reference', parse: 'text', label: 'Reference' },
  type: { field: 'source_type', parse: 'text', label: 'Type' },
  description: { field: 'description', parse: 'text', label: 'Description' },
  agency: { field: 'agency', parse: 'text', label: 'Agency' },
  warehouse: { field: 'source_warehouse', parse: 'text', label: 'Warehouse' },
  location: { field: 'source_location', parse: 'text', label: 'Location' },
  lot: { field: 'lot', parse: 'text', label: 'Lot' },
  serialnumber: { field: 'serial_number', parse: 'ident', label: 'Serial number' },
  catalognumber: { field: 'catalog_number', parse: 'ident', label: 'Catalog number' },
  qr: { field: 'qr_value', parse: 'ident', label: 'QR UUID' },
  consignmentfee: { field: 'consignment_fee', parse: 'money', label: 'Consignment Fee' },
  returndate: { field: 'return_date', parse: 'date', label: 'Return Date' },
  items: { field: 'items_count', parse: 'int', label: 'Items' },
  flags: { field: 'flags', parse: 'flags', label: 'Flags' },
  notes: { field: 'notes', parse: 'text', label: 'Notes' },
  setutilizationfactor: { field: 'set_utilization_factor', parse: 'num', label: 'Set Utilization Factor' },
  definitionvalue: { field: 'definition_value', parse: 'money', label: 'Definition Value' },
  totalcaseslast12months: { field: 'total_cases_12m', parse: 'int', label: 'Total Cases Last 12 Months' },
  tophcp: { field: 'top_hcp', parse: 'text', label: 'Top HCP' },
  tophcpsales: { field: 'top_hcp_sales', parse: 'money', label: 'Top HCP Sales' },
  tophcpcases: { field: 'top_hcp_cases', parse: 'int', label: 'Top HCP Cases' },
  dayssincelastcase: { field: 'days_since_last_case', parse: 'int', label: 'Days Since Last Case' },
  rep: { field: 'rep_name', parse: 'text', label: 'Representative' },
  team: { field: 'team_name', parse: 'text', label: 'Team' },
};
export const KNOWN_HEADER_KEYS = new Set(Object.keys(COLUMN_MAP));
export const FIELD_LABEL = Object.fromEntries(Object.values(COLUMN_MAP).map((c) => [c.field, c.label]));
Object.assign(FIELD_LABEL, {
  asset_type: 'Asset type', batch_number: 'Batch number', current_facility: 'Current facility',
  team: 'Team', assigned_rep: 'Assigned representative',
});

// ---------------------------------------------------------------------
// Value parsers. Each returns { value } or { value: null, warning }.
// ---------------------------------------------------------------------
const text = (v) => {
  if (v == null) return null;
  const s = (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).replace(/\r\n?/g, '\n').trim();
  return s === '' ? null : s;
};

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v).trim();
  if (s === '' || s === '-' || /^n\/?a$/i.test(s)) return null;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()$,\s]/g, '').replace(/%$/, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  const n = Number(s);
  return neg ? -n : n;
}

function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? NaN : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // Excel serial date
    if (v < 1 || v > 2958465) return NaN;
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); // US m/d/y
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? NaN : d.toISOString().slice(0, 10);
}
function iso(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
  return dt.toISOString().slice(0, 10);
}

const PARSERS = {
  text: (v) => ({ value: text(v) }),
  ident: (v) => ({ value: text(v)?.replace(/\s+/g, ' ') ?? null }),
  flags: (v) => ({ value: text(v)?.split('\n').map((s) => s.trim()).filter(Boolean).join(', ') || null }),
  money: (v) => { const n = toNumber(v); return Number.isNaN(n) ? { value: null, bad: true } : { value: n == null ? null : Math.round(n * 100) / 100 }; },
  num: (v) => { const n = toNumber(v); return Number.isNaN(n) ? { value: null, bad: true } : { value: n }; },
  int: (v) => { const n = toNumber(v); return Number.isNaN(n) ? { value: null, bad: true } : { value: n == null ? null : Math.round(n) }; },
  date: (v) => { const d = toDate(v); return Number.isNaN(d) ? { value: null, bad: true } : { value: d }; },
};

// ---------------------------------------------------------------------
// Type mapping: preserve the source label, map to a canonical type.
// ---------------------------------------------------------------------
export function mapAssetType(source) {
  const s = (source || '').toLowerCase();
  if (!s) return 'tray';
  if (/\b(tub|tote|bin|case)\b/.test(s)) return 'tote';
  if (/\btray\b/.test(s)) return 'tray';
  if (/implant/.test(s)) return 'implant_set';
  if (/instrument/.test(s)) return 'instrument_set';
  if (/loaner/.test(s)) return 'loaner_kit';
  return 'other';
}

// ---------------------------------------------------------------------
// Lot / serial parsing. Recognised shapes seen in Arthrex kit reports:
//   AR-9501HS BATCH# 14919754 SN# 808         (AR-9615CGS) BATCH/SN# 15483773/59
//   (AR-9579S) BATCH15249491/SN 1029          (AR-9579S) … /LOT 15135870/SN 619
//   AR-9501HS LOT/SN# 15245795/1742           AR-9400S LOT/SN#: 14880376/511
//   AR-9579S LOT.SN# 15249491/1029            AR-9226CS - 10597429/275
//   Lot# 511486                               (batch only — implant tubs)
// A catalog + serial identifies an instrument SET, which may span several
// trays (#5A/#5B/#5C share one serial), so it is never used on its own to
// decide that two rows are the same tray.
// ---------------------------------------------------------------------
const CATALOG_RE = /\bAR-\d{3,5}[A-Z0-9]*(?:-[A-Z0-9]+)*\b/i;
const BATCH_SN_RES = [
  // BATCH# 14919754 SN# 808 · LOT# 15139134 SN# 1173 · BATCH15249491/SN 1029 · LOT 15135870/SN 619
  /(?:BATCH|LOT)\s*#?\s*:?\s*(\d{5,})\s*[/,]?\s*L?SN\s*#?\s*:?\s*(\d+)/i,
  // BATCH/SN# 15483773/59 · BATCH/LSN# 15592518/571 · LOT/SN# 15245795/1742 · LOT.SN# 15249491/1029
  /(?:BATCH|LOT)\s*[/.]\s*L?SN\s*#?\s*:?\s*(\d{5,})\s*\/\s*(\d+)/i,
  // AR-9226CS - 10597429/275
  /\bAR-[A-Z0-9-]+\s*-\s*(\d{5,})\s*\/\s*(\d+)/i,
];
const LOT_ONLY_RE = /\b(?:LOT|BATCH)\s*#?\s*:?\s*(\d{4,})\b/i;

export function parseIdentifiers(str) {
  if (!str) return {};
  const out = {};
  const cat = str.match(CATALOG_RE);
  if (cat) out.catalog = cat[0].toUpperCase();
  for (const re of BATCH_SN_RES) {
    const m = str.match(re);
    if (m) {
      out.batch = m[1];
      out.serial = m[2];
      return out;
    }
  }
  const lot = str.match(LOT_ONLY_RE);
  if (lot) out.batch = lot[1];
  return out;
}

// ---------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------
export const normName = (s) => (s == null ? '' : String(s).toUpperCase().replace(/\s+/g, ' ').trim());
export const normKey = (s) => normName(s).replace(/[^A-Z0-9]/g, '');

export function guessFacilityType(name) {
  const s = normName(name);
  if (/\b(HQ|OFFICE|WAREHOUSE|DISTRIBUTION|DEPOT|STOCKROOM)\b/.test(s)) return 'warehouse';
  if (/\b(SURG(ERY|ICAL)? (CTR|CENTER)|ASC|SURGICENTER|SURGERY)\b/.test(s)) return 'surgery_center';
  if (/\b(HOSP(ITAL)?|HSP|MED(ICAL)? (CTR|CENTER)|MEDICAL|REGIONAL|HEALTH)\b/.test(s)) return 'hospital';
  if (/\bCLINIC\b/.test(s)) return 'clinic';
  return 'other';
}

/**
 * Convert one raw spreadsheet row into normalised asset fields.
 * Returns { fields, extra, warnings }.
 */
export function normalizeRow(raw) {
  const fields = {};
  const extra = {};
  const warnings = [];
  for (const [header, value] of Object.entries(raw)) {
    const key = headerKey(header);
    const col = COLUMN_MAP[key];
    if (!col) {
      if (value != null) extra[header] = value instanceof Date ? value.toISOString().slice(0, 10) : value;
      continue;
    }
    const r = PARSERS[col.parse](value);
    if (r.bad) warnings.push(`${col.label}: "${String(value).slice(0, 40)}" is not a valid ${col.parse === 'date' ? 'date' : 'number'}; left blank.`);
    if (r.value !== null && r.value !== undefined && fields[col.field] == null) fields[col.field] = r.value;
  }

  fields.asset_type = mapAssetType(fields.source_type);

  // Identifiers: explicit columns win; otherwise parse the Lot text, then Notes.
  const fromLot = parseIdentifiers(fields.lot);
  const fromNotes = parseIdentifiers(fields.notes);
  const catalog = fields.catalog_number || fromLot.catalog || fromNotes.catalog || null;
  const batch = fromLot.batch || fromNotes.batch || null;
  const serial = fields.serial_number || fromLot.serial || fromNotes.serial || null;
  if (fromLot.batch && fromNotes.batch && fromLot.batch !== fromNotes.batch) {
    warnings.push(`Lot column says batch ${fromLot.batch} but Notes say ${fromNotes.batch}. Using the Lot column; please verify.`);
  }
  if (fromLot.serial && fromNotes.serial && fromLot.serial !== fromNotes.serial) {
    warnings.push(`Lot column says serial ${fromLot.serial} but Notes say ${fromNotes.serial}. Using the Lot column; please verify.`);
  }
  if (catalog) fields.catalog_number = catalog.toUpperCase();
  if (batch) fields.batch_number = batch;
  // A serial is only an identifier when we also know its catalog number.
  if (serial && catalog) fields.serial_number = serial;
  else if (serial) {
    delete fields.serial_number;
    warnings.push(`Serial ${serial} found without a catalog number; not used for matching.`);
  }

  if (!fields.reference) warnings.push('Missing Reference; row cannot be imported.');
  return { fields, extra, warnings };
}

export const serialKey = (f) => (f.serial_number ? `${normName(f.catalog_number)}|${normName(f.serial_number)}` : null);
export const refLotKey = (f) => `${normName(f.reference)}|${normName(f.lot)}`;

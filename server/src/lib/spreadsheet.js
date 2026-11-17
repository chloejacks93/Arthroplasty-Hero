// Reads uploaded spreadsheets (XLSX, CSV) into plain header/row objects.
// Untrusted input: size and row counts are capped, and every cell is reduced to
// a primitive (string | number | boolean | Date | null) before anything else sees it.
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { badRequest } from './errors.js';
import { headerKey, KNOWN_HEADER_KEYS } from './importFields.js';

export const MAX_ROWS = 20000;
const MAX_COLS = 200;

export function detectFormat(buffer, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx';
  if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return 'xls';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  // Plain text without a known extension: treat as CSV if it decodes cleanly.
  if (!buffer.subarray(0, 4096).includes(0)) return 'csv';
  return 'unknown';
}

function cellToPrimitive(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text ?? '').join('');
    if ('result' in v) return cellToPrimitive(v.result);        // formula
    if ('text' in v) return cellToPrimitive(v.text);            // hyperlink
    if ('error' in v) return null;                              // #N/A etc.
  }
  return String(v);
}

/** Locate the header row: the first row (within the first 15) containing ≥3 recognised column names. */
function findHeaderRow(matrix) {
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const keys = matrix[i].map((c) => (c == null ? '' : headerKey(String(c))));
    const hits = keys.filter((k) => KNOWN_HEADER_KEYS.has(k)).length;
    if (hits >= 3 && keys.includes('reference')) return i;
  }
  return -1;
}

function matrixToSheet(matrix, sheetName) {
  const h = findHeaderRow(matrix);
  if (h < 0) return null;
  const headers = matrix[h].slice(0, MAX_COLS).map((c, i) => (c == null || String(c).trim() === '' ? `Column ${i + 1}` : String(c).trim()));
  const rows = [];
  for (let r = h + 1; r < matrix.length; r++) {
    const cells = matrix[r];
    if (!cells || cells.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    const raw = {};
    headers.forEach((name, i) => {
      const v = cells[i];
      raw[name] = v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v;
    });
    rows.push({ rowNumber: r + 1, raw });
    if (rows.length > MAX_ROWS) throw badRequest(`"${sheetName}" has more than ${MAX_ROWS.toLocaleString()} rows. Split the file and try again.`);
  }
  return { sheetName, headers, rows };
}

export async function readSpreadsheet(buffer, filename) {
  const format = detectFormat(buffer, filename);
  if (format === 'xls') {
    throw badRequest(`"${filename}" is a legacy Excel 97–2003 (.xls) file. Open it in Excel and use File → Save As → Excel Workbook (.xlsx), then upload that copy.`);
  }
  if (format === 'unknown') throw badRequest(`"${filename}" is not a recognised spreadsheet. Upload .xlsx or .csv files.`);

  if (format === 'csv') {
    let text = buffer.toString('utf8');
    let matrix;
    try {
      matrix = parseCsv(text, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: false });
    } catch (e) {
      throw badRequest(`"${filename}" could not be read as CSV (${e.message.split('\n')[0]}).`);
    }
    text = null;
    const sheet = matrixToSheet(matrix, 'CSV');
    if (!sheet) throw badRequest(`"${filename}" has no header row containing "Reference" and other known columns.`);
    return { format, ...sheet };
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw badRequest(`"${filename}" could not be opened. It may be damaged or password-protected.`);
  }
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== 'visible') continue;
    if (ws.rowCount > MAX_ROWS + 20) throw badRequest(`"${filename}" › "${ws.name}" has more than ${MAX_ROWS.toLocaleString()} rows.`);
    const matrix = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals = [];
      const width = Math.min(row.cellCount, MAX_COLS);
      for (let c = 1; c <= width; c++) vals.push(cellToPrimitive(row.getCell(c).value));
      matrix[n - 1] = vals;
    });
    for (let i = 0; i < matrix.length; i++) if (!matrix[i]) matrix[i] = [];
    const sheet = matrixToSheet(matrix, ws.name);
    if (sheet) return { format, ...sheet };
  }
  throw badRequest(`"${filename}" has no sheet with a header row containing "Reference" and other known columns.`);
}

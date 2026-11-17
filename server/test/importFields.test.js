import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentifiers, normalizeRow, mapAssetType, guessFacilityType, headerKey } from '../src/lib/importFields.js';

test('parses every Lot format seen in the source kit reports', () => {
  const cases = [
    ['AR-9501HS BATCH# 14919754 SN# 808', 'AR-9501HS', '14919754', '808'],
    ['(AR-9615CGS) BATCH/SN# 15483773/59', 'AR-9615CGS', '15483773', '59'],
    ['(AR-9579S) BATCH15249491/SN 1029', 'AR-9579S', '15249491', '1029'],
    ['(AR-9579S) SMS-AUGMENTED MGS INSTR #11/LOT 15135870/SN 619', 'AR-9579S', '15135870', '619'],
    ['AR-9501HS LOT/SN# 15245795/1742', 'AR-9501HS', '15245795', '1742'],
    ['AR-9400S LOT/SN#: 14880376/511', 'AR-9400S', '14880376', '511'],
    ['AR-9579S LOT.SN# 15249491/1029', 'AR-9579S', '15249491', '1029'],
    ['(AR-9226CS) SMS-COMBINED HUMERAL INSTR #4/AR-9226CS - 10597429/275', 'AR-9226CS', '10597429', '275'],
    ['(AR-9501CHS) BATCH/LSN# 15592518/571', 'AR-9501CHS', '15592518', '571'],
    ['AR-9501HS LOT# 15139134 SN# 1173', 'AR-9501HS', '15139134', '1173'],
    ['AR-9217AVS BATCH#14925645 SN#98', 'AR-9217AVS', '14925645', '98'],
    ['AR-9579S-FW BATCH# 15433382 SN# 397', 'AR-9579S-FW', '15433382', '397'],
  ];
  for (const [s, catalog, batch, serial] of cases) assert.deepEqual(parseIdentifiers(s), { catalog, batch, serial }, s);
  assert.deepEqual(parseIdentifiers('Lot# 511486'), { batch: '511486' });
  assert.deepEqual(parseIdentifiers('SMS-REVERS-07B'), {});
  assert.deepEqual(parseIdentifiers('(AR-9501HC-RCAS) SMS-CA HEAD/TRIALS #5'), { catalog: 'AR-9501HC-RCAS' });
});

test('normalises text-typed spreadsheet values and preserves the original Lot', () => {
  const { fields, warnings } = normalizeRow({
    Reference: 'KIT-A #1', Type: 'Tub', Description: 'Implants', Agency: 'AGENCY', Warehouse: 'TEAM X', Location: 'Main HQ',
    Lot: 'AR-1234S BATCH# 11111111 SN# 7', 'Consignment Fee': '$0.65', 'Return Date': null, Items: '46',
    Flags: 'Overstocked\nUnderstocked', Notes: 'AR-1234S LOT/SN# 11111111/7', 'Set Utilization Factor': '76.87',
    'Definition Value': '$115,958.00', 'Total Cases Last 12 Months': '44', 'Top HCP': 'Surgeon, Sample',
    'Top HCP Sales': '$55,671.66', 'Top HCP Cases': '26', 'Days Since Last Case': '6',
  });
  assert.deepEqual(warnings, []);
  assert.equal(fields.asset_type, 'tote');
  assert.equal(fields.source_type, 'Tub');
  assert.equal(fields.lot, 'AR-1234S BATCH# 11111111 SN# 7');
  assert.equal(fields.catalog_number, 'AR-1234S');
  assert.equal(fields.batch_number, '11111111');
  assert.equal(fields.serial_number, '7');
  assert.equal(fields.consignment_fee, 0.65);
  assert.equal(fields.definition_value, 115958);
  assert.equal(fields.top_hcp_sales, 55671.66);
  assert.equal(fields.items_count, 46);
  assert.equal(fields.set_utilization_factor, 76.87);
  assert.equal(fields.flags, 'Overstocked, Understocked');
});

test('flags Lot/Notes disagreement and bad numbers instead of guessing', () => {
  const r = normalizeRow({ Reference: 'X', Lot: '(AR-9579S) BATCH 1191044/SN 83', Notes: 'AR-9579S: LOT 11910441 / SN 83', Items: 'lots' });
  assert.equal(r.fields.batch_number, '1191044');
  assert.ok(r.warnings.some((w) => /Lot column says batch 1191044 but Notes say 11910441/.test(w)));
  assert.ok(r.warnings.some((w) => /Items/.test(w)));
  assert.equal(r.fields.items_count, undefined);
  assert.ok(normalizeRow({ Description: 'no ref' }).warnings.some((w) => /Missing Reference/.test(w)));
});

test('unknown columns are preserved in extra, not dropped', () => {
  const r = normalizeRow({ Reference: 'X', 'Custom Column': 'keep me' });
  assert.deepEqual(r.extra, { 'Custom Column': 'keep me' });
});

test('type and facility heuristics', () => {
  assert.equal(mapAssetType('Tray'), 'tray');
  assert.equal(mapAssetType('Tub'), 'tote');
  assert.equal(mapAssetType('Implant Set'), 'implant_set');
  assert.equal(guessFacilityType('Chattanooga Main HQ'), 'warehouse');
  assert.equal(guessFacilityType('RIVERFRONT SURGERY CENTER'), 'surgery_center');
  assert.equal(guessFacilityType('CHATTANOOGA SURG CTR dba CNTR FOR SPORTS MEDICINE'), 'surgery_center');
  assert.equal(guessFacilityType('SOUTHERN TENNESSEE MED CTR'), 'hospital');
  assert.equal(guessFacilityType('ASCENSION ST THOMAS HIGHLANDS HSP'), 'hospital');
  assert.equal(headerKey('Total Cases Last 12 Months'), 'totalcaseslast12months');
  assert.equal(headerKey('QR Code'), 'qr');
});

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, SearchX, MoveRight, MapPinOff, Wrench, PackageMinus, HelpCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useMeta, refreshMeta } from '../lib/useApi.js';
import { AssetPicker } from '../components/AssetPicker.jsx';
import { AssetStrip } from './Transfer.jsx';

const KINDS = [
  ['missing', 'Can’t find it', 'Missing from where it should be', SearchX],
  ['unauthorized_movement', 'Moved without a transfer', 'Found somewhere it wasn’t sent', MoveRight],
  ['location_discrepancy', 'Wrong location on record', 'The system shows the wrong place', MapPinOff],
  ['damaged', 'Damaged', 'Tray, lid or instruments damaged', Wrench],
  ['incomplete', 'Incomplete', 'Items or implants missing', PackageMinus],
  ['other', 'Something else', 'Describe it below', HelpCircle],
];
const NEEDS_FACILITY = new Set(['unauthorized_movement', 'location_discrepancy']);

export default function Report() {
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const assetId = params.get('asset');
  const [asset, setAsset] = useState(null);
  const [kind, setKind] = useState(params.get('kind') || '');
  const [facility, setFacility] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  // Out-of-team assets are not readable in full; when the picker already
  // supplied a summary for this asset, use it instead of re-fetching.
  const location = useLocation();
  const picked = useRef(location.state?.asset || null);
  useEffect(() => {
    if (!assetId) { setAsset(null); return; }
    if (picked.current?.id === assetId) { setAsset(picked.current); return; }
    setAsset(null);
    api.get(`/assets/${assetId}`).then((d) => setAsset(d.asset)).catch(() => setErr('That asset could not be loaded. Scan its label instead.'));
  }, [assetId]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.post('/investigations', { asset_id: asset.id, kind, facility_id: facility || undefined, description: desc.trim() || undefined });
      setDone(r);
      refreshMeta();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  const needsText = ['damaged', 'incomplete', 'other'].includes(kind);

  return (
    <div className="flow-page">
      <div className="page-head">
        <div>
          <h1>Report a problem</h1>
          <p>Management is notified immediately and the report is kept in the asset’s permanent history.</p>
        </div>
      </div>

      {done ? (
        <section className="panel flow-panel">
          <div className="done-state">
            <CheckCircle2 aria-hidden />
            <strong>Report #{done.case_ref} sent</strong>
            <span>Management has been notified. You can follow it under Investigations.</span>
            <div className="seg" style={{ justifyContent: 'center' }}>
              <Link className="btn btn-lg" to="/">Done</Link>
              <Link className="btn btn-primary btn-lg" to={`/investigations/${done.id}`}>View report</Link>
            </div>
          </div>
        </section>
      ) : !asset ? (
        <section className="panel flow-panel">
          <div className="panel-head"><h2>1 · Which tray or tote?</h2></div>
          <div className="panel-body">
            <AssetPicker allowOutOfScope onPick={(a) => { picked.current = a; setParams({ asset: a.id }, { replace: true }); }} />
          </div>
        </section>
      ) : (
        <section className="panel flow-panel">
          <AssetStrip a={asset} onChange={() => { setAsset(null); setParams({}); }} />
          <form onSubmit={submit} className="flow-form">
            <fieldset className="kind-grid">
              <legend>What’s wrong?</legend>
              {KINDS.map(([k, label, sub, Icon]) => (
                <label key={k} className={`kind${kind === k ? ' on' : ''}`}>
                  <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                  <Icon aria-hidden />
                  <span><strong>{label}</strong><small>{sub}</small></span>
                </label>
              ))}
            </fieldset>
            {NEEDS_FACILITY.has(kind) && (
              <div className="field">
                <label htmlFor="ofac">Where is it actually?</label>
                <select id="ofac" className="select select-lg" value={facility} onChange={(e) => setFacility(e.target.value)}>
                  <option value="">Not sure</option>
                  {meta?.facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="desc">Details <span className="subtle">{needsText ? '(required)' : '(optional)'}</span></label>
              <textarea id="desc" className="input textarea" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={1000}
                placeholder="What did you see? Where? Who else knows?" />
            </div>
            <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Do not include patient information.</p>
            {err && <div className="form-error" role="alert"><AlertTriangle size={13} aria-hidden /> {err}</div>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || !kind || (needsText && !desc.trim())}>
              {busy ? 'Sending…' : 'Send report'}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

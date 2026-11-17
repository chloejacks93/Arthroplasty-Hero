import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, FileSpreadsheet, UploadCloud, X, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useMeta } from '../lib/useApi.js';

const ACCEPT = '.xlsx,.xls,.csv';
const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;

export default function ImportNew() {
  const navigate = useNavigate();
  const meta = useMeta();
  const input = useRef(null);
  const [files, setFiles] = useState([]); // [{ file, team }]
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = (list) => {
    setError('');
    const incoming = [...list].filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    if (incoming.length < list.length) setError('Only .xlsx, .xls and .csv files can be imported.');
    const tooBig = incoming.find((f) => f.size > MAX_BYTES);
    if (tooBig) return setError(`"${tooBig.name}" is larger than 10 MB.`);
    setFiles((cur) => {
      const names = new Set(cur.map((x) => x.file.name + x.file.size));
      const next = [...cur, ...incoming.filter((f) => !names.has(f.name + f.size)).map((file) => ({ file, team: '' }))];
      if (next.length > MAX_FILES) setError(`Upload up to ${MAX_FILES} files at a time.`);
      return next.slice(0, MAX_FILES);
    });
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f.file, f.file.name));
    fd.append('teams', JSON.stringify(files.map((f) => f.team || null)));
    try {
      const { batchId } = await api.upload('/imports', fd);
      navigate(`/imports/${batchId}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="crumbs"><Link to="/imports">Imports</Link><ChevronRight aria-hidden /><span>New import</span></div>
      <div className="page-head">
        <div>
          <h1>New import</h1>
          <p>Upload one or more spreadsheets. Nothing changes until you review the preview and approve it.</p>
        </div>
      </div>

      <div className="import-layout">
        <section className="panel">
          <div
            className={`dropzone${drag ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
            onClick={() => input.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
          >
            <UploadCloud aria-hidden />
            <strong>Drop spreadsheets here, or click to choose</strong>
            <span>Excel (.xlsx) or CSV · up to {MAX_FILES} files · 10 MB each</span>
            <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
          </div>

          {files.length > 0 && (
            <ul className="file-list">
              {files.map((f, i) => (
                <li key={f.file.name + f.file.size}>
                  <FileSpreadsheet className="ficon" aria-hidden />
                  <div className="fname">
                    <strong>{f.file.name}</strong>
                    <span>{(f.file.size / 1024).toFixed(0)} KB</span>
                  </div>
                  <label className="sr-only" htmlFor={`team-${i}`}>Team for {f.file.name}</label>
                  <select id={`team-${i}`} className="select select-sm" value={f.team}
                    onChange={(e) => setFiles((cur) => cur.map((x, j) => (j === i ? { ...x, team: e.target.value } : x)))}>
                    <option value="">Team from Warehouse column</option>
                    {meta?.teams.map((t) => <option key={t.id} value={t.id}>All rows → {t.name}</option>)}
                  </select>
                  <button className="icon-btn" aria-label={`Remove ${f.file.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}><X /></button>
                </li>
              ))}
            </ul>
          )}
          {error && <div className="form-error" style={{ margin: '0 18px 16px' }} role="alert">{error}</div>}
          <div className="panel-foot">
            <span className="muted">{files.length ? `${files.length} file${files.length > 1 ? 's' : ''} selected` : 'No files selected'}</span>
            <button className="btn btn-primary" disabled={!files.length || busy} onClick={submit}>
              {busy ? 'Reading files…' : 'Upload and preview'}
            </button>
          </div>
        </section>

        <aside className="panel guide">
          <div className="panel-head"><h2>How matching works</h2></div>
          <ol>
            <li><strong>QR UUID</strong>: an existing Arthrex QR value always identifies the same asset.</li>
            <li><strong>Serial + Reference</strong>: catalog and serial parsed from the Lot column, together with the kit Reference. A serial alone identifies an instrument <em>set</em>, which can span several trays.</li>
            <li><strong>Reference + Lot</strong>: an exact match on both.</li>
            <li><strong>Name only</strong>: never merged automatically. You decide.</li>
          </ol>
          <div className="notice blue" style={{ margin: '0 18px 16px' }}>
            <AlertTriangle aria-hidden />
            <span>Live locations, teams and representatives are never overwritten silently. Differences become conflicts for review.</span>
          </div>
        </aside>
      </div>
    </>
  );
}

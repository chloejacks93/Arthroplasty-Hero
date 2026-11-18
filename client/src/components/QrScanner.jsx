import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraOff, RotateCcw, Flashlight, FlashlightOff, Volume2, VolumeX } from 'lucide-react';
import { initDecoder, decode } from '../lib/qrDecoder.js';
import { soundEnabled, setSoundEnabled, unlockAudio } from '../lib/beep.js';

const SCAN_INTERVAL_MS = 70;   // pause between decode passes (decoding itself also takes time)
const FULL_MAX_WIDTH = 960;    // whole-frame pass: downscaled for speed
const CROP_MAX = 1100;         // close-up pass: native resolution inside the brackets
const CROP_FRACTION = 0.72;    // share of the shorter side covered by the close-up

/**
 * Live camera QR scanner tuned for hard-to-read labels.
 *  - Rear camera at up to 1080p with continuous autofocus where supported.
 *  - Alternates two passes: the whole frame (finds labels anywhere) and a
 *    full-resolution close-up of the bracket area (reads small / faint labels).
 *    Every third close-up uses a slower, more forgiving strategy (glare, damage).
 *  - ZXing (WebAssembly) decoder with jsQR fallback; rotation and inverted labels handled.
 *  - Flashlight button where the phone allows it; sound on/off button.
 *  - Stops the camera when paused, hidden or unmounted.
 * Props: onResult(text), paused, continuous (keep scanning after each read)
 */
export function QrScanner({ onResult, paused, continuous = false }) {
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const video = useRef(null);
  const canvas = useRef(null);
  const stream = useRef(null);
  const timer = useRef(null);
  const pass = useRef(0);
  const lastHit = useRef({ text: null, at: 0 });
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  const [state, setState] = useState('starting'); // starting | live | error | paused
  const [error, setError] = useState('');
  const [hit, setHit] = useState(false);
  const [torch, setTorch] = useState({ available: false, on: false });
  const [sound, setSound] = useState(soundEnabled());

  useEffect(() => { initDecoder(); }, []);

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const tick = useCallback(async () => {
    const v = video.current;
    const c = canvas.current;
    if (!v || !c || !stream.current) return;
    let text = null;
    if (v.readyState >= 2 && v.videoWidth) {
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const n = pass.current++;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      let img;
      if (n % 2 === 0) {
        // Whole frame, downscaled
        const s = Math.min(1, FULL_MAX_WIDTH / vw);
        const w = Math.round(vw * s);
        const h = Math.round(vh * s);
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        ctx.drawImage(v, 0, 0, w, h);
        img = ctx.getImageData(0, 0, w, h);
      } else {
        // Close-up of the bracket area at (up to) native resolution
        const side = Math.round(Math.min(vw, vh) * CROP_FRACTION);
        const sx = Math.round((vw - side) / 2);
        const sy = Math.round((vh - side) / 2);
        const out = Math.min(side, CROP_MAX);
        if (c.width !== out || c.height !== out) { c.width = out; c.height = out; }
        ctx.drawImage(v, sx, sy, side, side, 0, 0, out, out);
        img = ctx.getImageData(0, 0, out, out);
      }
      try {
        text = (await decode(img, { hard: n % 6 === 5 }))?.trim() || null;
      } catch {
        text = null;
      }
    }
    if (!stream.current) return; // stopped while decoding
    if (text) {
      const now = Date.now();
      // Ignore the same code re-read within 2.5 s (camera still pointed at it).
      if (text !== lastHit.current.text || now - lastHit.current.at > 2500) {
        lastHit.current = { text, at: now };
        setHit(true);
        setTimeout(() => setHit(false), 450);
        onResultRef.current(text);
        if (!continuousRef.current) return; // parent pauses us
        timer.current = setTimeout(tick, 700);
        return;
      }
    }
    timer.current = setTimeout(tick, SCAN_INTERVAL_MS);
  }, []);

  const start = useCallback(async () => {
    stop();
    setError('');
    setState('starting');
    setTorch({ available: false, on: false });
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setError('The camera is only available over a secure (https) connection. Enter the code manually below.');
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // Keep refocusing as the phone moves (Android Chrome; ignored elsewhere).
          advanced: [{ focusMode: 'continuous' }],
        },
      });
      stream.current = s;
      const track = s.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() || {};
      if (caps.torch) setTorch({ available: true, on: false });
      const v = video.current;
      v.srcObject = s;
      v.setAttribute('playsinline', ''); // iOS: never go full screen
      await v.play();
      setState('live');
      await initDecoder();
      timer.current = setTimeout(tick, SCAN_INTERVAL_MS);
    } catch (e) {
      setState('error');
      setError(
        e.name === 'NotAllowedError'
          ? 'Camera access is blocked. On iPhone: Settings › Safari › Camera › Allow (or tap “aA” › Website Settings). Then tap Try again.'
          : e.name === 'NotFoundError' || e.name === 'OverconstrainedError'
            ? 'No camera was found on this device. Enter the code manually below.'
            : e.name === 'NotReadableError'
              ? 'The camera is being used by another app. Close it and tap Try again.'
              : 'The camera could not be started. Enter the code manually below.',
      );
    }
  }, [stop, tick]);

  useEffect(() => {
    if (paused) {
      stop();
      setState('paused');
      return undefined;
    }
    start();
    return stop;
  }, [paused, start, stop]);

  // Release the camera when the app goes to the background (iOS keeps the light on otherwise).
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) stop();
      else if (!paused) start();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [paused, start, stop]);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch.on }] });
      setTorch((t) => ({ ...t, on: !t.on }));
    } catch {
      setTorch({ available: false, on: false });
    }
  };
  const toggleSound = () => {
    unlockAudio();
    setSoundEnabled(!sound);
    setSound(!sound);
  };

  return (
    <div className={`scanner${hit ? ' hit' : ''} ${state}`}>
      <video ref={video} muted playsInline autoPlay aria-label="Camera preview" />
      <canvas ref={canvas} hidden />
      {state !== 'error' && (
        <div className="reticle" aria-hidden>
          <span /><span /><span /><span />
        </div>
      )}
      <div className="scanner-tools">
        <button type="button" className="scan-tool" onClick={toggleSound} aria-label={sound ? 'Mute scan sound' : 'Turn scan sound on'} title={sound ? 'Sound on' : 'Sound off'}>
          {sound ? <Volume2 /> : <VolumeX />}
        </button>
        {torch.available && state === 'live' && (
          <button type="button" className={`scan-tool${torch.on ? ' on' : ''}`} onClick={toggleTorch} aria-label={torch.on ? 'Turn flashlight off' : 'Turn flashlight on'} title="Flashlight">
            {torch.on ? <FlashlightOff /> : <Flashlight />}
          </button>
        )}
      </div>
      <div className="scanner-status" role="status" aria-live="polite">
        {state === 'starting' && 'Starting camera…'}
        {state === 'live' && (continuous ? 'Scan each tray. Keep going.' : 'Hold the label inside the frame')}
        {state === 'paused' && 'Scan captured'}
      </div>
      {state === 'error' && (
        <div className="scanner-error">
          <CameraOff aria-hidden />
          <p>{error}</p>
          <button className="btn btn-sm" onClick={start}><RotateCcw aria-hidden /> Try again</button>
        </div>
      )}
    </div>
  );
}

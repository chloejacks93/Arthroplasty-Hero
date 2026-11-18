import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { CameraOff, RotateCcw } from 'lucide-react';

const SCAN_INTERVAL_MS = 110; // ~9 decodes/second: responsive without draining the battery
const MAX_DECODE_WIDTH = 720;

/**
 * Live camera QR scanner.
 *  - Rear camera, inline playback (required on iPhone Safari), muted.
 *  - Decodes a downscaled frame on an interval with jsQR (works on iOS, where
 *    the native BarcodeDetector API is unavailable).
 *  - Stops the camera when paused or unmounted.
 * Props: onResult(text), paused (bool)
 */
export function QrScanner({ onResult, paused, continuous = false }) {
  // continuous: keep scanning after each read (multi-tray mode).
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const video = useRef(null);
  const canvas = useRef(null);
  const stream = useRef(null);
  const timer = useRef(null);
  const lastHit = useRef({ text: null, at: 0 });
  // Keep the latest callback without restarting the camera when it changes.
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  const [state, setState] = useState('starting'); // starting | live | error | paused
  const [error, setError] = useState('');
  const [hit, setHit] = useState(false);

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const tick = useCallback(() => {
    const v = video.current;
    const c = canvas.current;
    if (!v || !c || !stream.current) return;
    if (v.readyState >= 2 && v.videoWidth) {
      const scale = Math.min(1, MAX_DECODE_WIDTH / v.videoWidth);
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      if (c.width !== w) { c.width = w; c.height = h; }
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, w, h);
      const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
      const text = code?.data?.trim();
      if (text) {
        const now = Date.now();
        // Ignore the same code re-read within 2.5 s (camera still pointed at it).
        if (text !== lastHit.current.text || now - lastHit.current.at > 2500) {
          lastHit.current = { text, at: now };
          setHit(true);
          setTimeout(() => setHit(false), 450);
          if (navigator.vibrate) navigator.vibrate(40);
          onResultRef.current(text);
          if (continuousRef.current) {
            timer.current = setTimeout(tick, 900); // brief pause so the same label isn't re-read at once
            return;
          }
          return; // parent pauses us; do not schedule another tick
        }
      }
    }
    timer.current = setTimeout(tick, SCAN_INTERVAL_MS);
  }, []);

  const start = useCallback(async () => {
    stop();
    setError('');
    setState('starting');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setError('The camera is only available over a secure (https) connection. Enter the code manually below.');
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      stream.current = s;
      const v = video.current;
      v.srcObject = s;
      v.setAttribute('playsinline', ''); // iOS: never go full screen
      await v.play();
      setState('live');
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

  return (
    <div className={`scanner${hit ? ' hit' : ''} ${state}`}>
      <video ref={video} muted playsInline autoPlay aria-label="Camera preview" />
      <canvas ref={canvas} hidden />
      {state !== 'error' && (
        <div className="reticle" aria-hidden>
          <span /><span /><span /><span />
        </div>
      )}
      <div className="scanner-status" role="status" aria-live="polite">
        {state === 'starting' && 'Starting camera…'}
        {state === 'live' && (continuous ? 'Scan each tray. Keep going.' : 'Point the camera at the asset’s QR label')}
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

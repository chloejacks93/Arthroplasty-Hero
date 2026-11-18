// QR decoding for the camera scanner.
// Primary: ZXing (zxing-cpp compiled to WebAssembly), far better than jsQR at
// low-contrast, glossy, small, rotated or partly damaged labels, and it works
// in iPhone Safari. The .wasm file is bundled and served by this app (never a
// CDN). Fallback: jsQR, if WebAssembly is unavailable.
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import jsQR from 'jsqr';

let ready = null;
let zxingOk = false;

export function initDecoder() {
  if (!ready) {
    ready = Promise.resolve()
      .then(() => prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
        fireImmediately: true,
      }))
      .then(() => { zxingOk = true; return true; })
      .catch(() => { zxingOk = false; return false; });
  }
  return ready;
}

export const decoderName = () => (zxingOk ? 'zxing' : 'jsqr');

const BASE = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
};
// A second strategy for difficult frames: a different binarizer copes better
// with glare / uneven lighting, and denoising helps with print damage.
const HARD = { ...BASE, binarizer: 'GlobalHistogram', tryDenoise: true };

/** Decode one ImageData. `hard` selects the slower, more forgiving strategy. */
export async function decode(imageData, { hard = false } = {}) {
  if (zxingOk) {
    try {
      const res = await readBarcodes(imageData, hard ? HARD : BASE);
      const hit = res.find((r) => r.isValid && r.text);
      if (hit) return hit.text;
      return null;
    } catch {
      // fall through to jsQR for this frame
    }
  }
  const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
  return code?.data || null;
}

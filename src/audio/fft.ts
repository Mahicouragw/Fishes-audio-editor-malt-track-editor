/** Small, dependency-free radix-2 FFT. Used by the phase vocoder, spectral gates and isolation. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nextRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextRe;
      }
    }
  }
}

export function ifft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / re.length;
  for (let i = 0; i < re.length; i++) {
    re[i] *= inv;
    im[i] = -im[i] * inv;
  }
}

/** Convenience helpers used by tests and synchronous rendering. */
export function spectrum(signal: Float32Array): { magnitude: Float32Array; sampleRate: number } {
  const n = 2 ** Math.floor(Math.log2(signal.length || 1));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = signal[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const magnitude = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) magnitude[k] = Math.hypot(re[k], im[k]);
  return { magnitude, sampleRate: n };
}

/** Estimate the dominant frequency (Hz) of a real signal via parabolic interpolation. */
export function dominantFrequency(signal: Float32Array, sampleRate: number): number {
  const { magnitude } = spectrum(signal);
  let peak = 1;
  for (let k = 2; k < magnitude.length - 1; k++) {
    if (magnitude[k] > magnitude[peak]) peak = k;
  }
  const left = magnitude[peak - 1] ?? 0;
  const center = magnitude[peak];
  const right = magnitude[peak + 1] ?? 0;
  const denominator = left - 2 * center + right;
  const delta = denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;
  return ((peak + delta) * sampleRate) / (magnitude.length * 2);
}

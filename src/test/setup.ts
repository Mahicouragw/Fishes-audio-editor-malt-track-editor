import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

if (typeof window !== 'undefined' && !window.matchMedia) {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// jsdom has no AudioContext — provide a minimal stub for UI tests.
// decodeAudioData rejects so tests can never silently use fake audio.
if (typeof (globalThis as unknown as { AudioContext?: unknown }).AudioContext === 'undefined') {
  class MockAudioContext {
    state = 'running' as AudioContextState;
    currentTime = 0;
    sampleRate = 44100;
    baseLatency = 0;
    destination = {} as AudioNode;
    createGain() { return { gain: { value: 1, setTargetAtTime() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} } as unknown as GainNode; }
    createBuffer(channels: number, length: number, sampleRate: number) { return { duration: length / sampleRate, numberOfChannels: channels, sampleRate, length, getChannelData: () => new Float32Array(length), copyToChannel() {} } as unknown as AudioBuffer; }
    createBufferSource() { return { buffer: null, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null } as unknown as AudioBufferSourceNode; }
    createDynamicsCompressor() { return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect() {}, disconnect() {} } as unknown as DynamicsCompressorNode; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } as unknown as MediaStreamAudioSourceNode; }
    createMediaStreamDestination() { return { stream: {} as MediaStream } as unknown as MediaStreamAudioDestinationNode; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData() {}, connect() {}, disconnect() {} } as unknown as AnalyserNode; }
    close() { (this as unknown as { state: AudioContextState }).state = 'closed'; return Promise.resolve(); }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    decodeAudioData() { return Promise.reject(new Error('decode not supported in test')); }
  }
  (globalThis as unknown as Record<string, unknown>).AudioContext = MockAudioContext;
  (globalThis as unknown as Record<string, unknown>).webkitAudioContext = MockAudioContext;
}

// jsdom has no microphone — getUserMedia rejects so permission errors are
// exercised honestly (no fake recording streams).
if (typeof navigator !== 'undefined' && !(navigator as unknown as { mediaDevices?: unknown }).mediaDevices) {
  (navigator as unknown as Record<string, unknown>).mediaDevices = {
    getUserMedia: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
    enumerateDevices: async () => [],
  };
}

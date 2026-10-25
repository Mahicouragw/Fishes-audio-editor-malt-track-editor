/** A real PCM capture worklet; avoids browser-dependent MediaRecorder codecs. */
export const PCM_RECORDER_SOURCE = `
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'active') this.active = Boolean(event.data.value);
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (this.active && input && input.length && input[0] && input[0].length) {
      const channels = input.map((channel) => new Float32Array(channel));
      this.port.postMessage({ type: 'pcm', channels }, channels.map((c) => c.buffer));
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorderProcessor);
`;

const loaded = new WeakSet<BaseAudioContext>();

export async function ensurePcmWorklet(context: BaseAudioContext): Promise<void> {
  if (loaded.has(context)) return;
  const url = URL.createObjectURL(new Blob([PCM_RECORDER_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
    loaded.add(context);
  } finally {
    URL.revokeObjectURL(url);
  }
}

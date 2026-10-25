import type { AudioData } from '../types';
import { audioData } from './dsp';
import { encodeWavBlob } from './wav';
import { ensurePcmWorklet } from './worklet';

export interface StartRecordingOptions {
  deviceId?: string;
  countInSeconds?: number;
  monitoring?: boolean;
  onCountIn?: (remaining: number) => void;
}

export interface RecordedResult {
  data: AudioData;
  blob: Blob;
  duration: number;
  latencySeconds: number;
}

interface RecorderNode {
  disconnect(): void;
}

/**
 * Captures raw microphone PCM with AudioWorklet (ScriptProcessor fallback).
 * Recording is driven by a user gesture; getUserMedia is never called before start().
 */
export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private monitor: GainNode | null = null;
  private node: RecorderNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[][] = [];
  private channelCount = 1;
  private frames = 0;
  private active = false;
  private stopped = false;
  private latencySeconds = 0;

  static async listInputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput');
  }

  static get supported(): boolean {
    return Boolean((navigator.mediaDevices as unknown as { getUserMedia?: unknown })?.getUserMedia && (globalThis as unknown as { AudioContext?: unknown }).AudioContext);
  }

  async start(options: StartRecordingOptions = {}): Promise<void> {
    if (!PcmRecorder.supported) throw new Error('Microphone recording is not supported in this browser.');
    if (this.context) throw new Error('A recording is already in progress.');
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      const name = (error as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error('Microphone permission was denied. Allow microphone access in your browser settings and try again.');
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error('No microphone was found. Connect an input device and try again.');
      }
      throw new Error(`Could not start microphone: ${(error as Error).message || name || 'unknown error'}`);
    }
    this.stream = stream;
    const context = new AudioContext();
    this.context = context;
    await context.resume();
    this.latencySeconds = (context.baseLatency ?? 0) + ((context as AudioContext & { inputLatency?: number }).inputLatency ?? 0);
    const source = context.createMediaStreamSource(stream);
    this.source = source;
    this.channelCount = Math.max(1, stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    this.analyser = analyser;
    source.connect(analyser);
    const monitor = context.createGain();
    monitor.gain.value = options.monitoring ? 0.55 : 0;
    this.monitor = monitor;
    source.connect(monitor);
    monitor.connect(context.destination);

    const sink = context.createGain();
    sink.gain.value = 0;
    sink.connect(context.destination);
    this.sink = sink;

    const collect = (channels: Float32Array[]) => {
      if (!this.active || this.stopped) return;
      this.chunks.push(channels);
      this.frames += channels[0]?.length ?? 0;
      this.channelCount = Math.max(this.channelCount, channels.length);
    };

    try {
      await ensurePcmWorklet(context);
      const worklet = new AudioWorkletNode(context, 'pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: Math.min(2, this.channelCount),
        channelCountMode: 'explicit',
      });
      worklet.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'pcm') collect((event.data.channels as Float32Array[]) ?? []);
      };
      source.connect(worklet);
      worklet.connect(sink);
      this.node = worklet;
    } catch {
      // Deprecated but still available in some WebView browsers.
      const processor = context.createScriptProcessor(4096, Math.min(2, this.channelCount), Math.min(2, this.channelCount));
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const channels: Float32Array[] = [];
        for (let c = 0; c < input.numberOfChannels; c++) {
          channels.push(new Float32Array(input.getChannelData(c)));
        }
        collect(channels);
      };
      source.connect(processor);
      processor.connect(sink);
      this.node = processor;
    }

    const countIn = Math.max(0, options.countInSeconds ?? 0);
    if (countIn > 0 && !this.stopped) {
      const spacing = 0.6;
      const beeps = Math.ceil(countIn / spacing);
      for (let i = 0; i < beeps; i++) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = i === beeps - 1 ? 1100 : 750;
        gain.gain.setValueAtTime(0.0001, context.currentTime + i * spacing);
        gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + i * spacing + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + i * spacing + 0.12);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(context.currentTime + i * spacing);
        oscillator.stop(context.currentTime + i * spacing + 0.14);
      }
      await new Promise<void>((resolve) => {
        const started = performance.now();
        const tick = () => {
          if (this.stopped) return resolve();
          const elapsed = (performance.now() - started) / 1000;
          options.onCountIn?.(Math.max(0, countIn - elapsed));
          if (elapsed >= countIn) resolve();
          else setTimeout(tick, 80);
        };
        tick();
      });
    }
    if (!this.stopped) {
      this.active = true;
      (this.node as AudioWorkletNode | null)?.port?.postMessage({ type: 'active', value: true });
    }
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  get elapsed(): number {
    return this.frames / this.sampleRate;
  }

  get level(): number {
    if (!this.analyser) return 0;
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  }

  get isPaused(): boolean {
    return Boolean(this.context) && !this.active && !this.stopped;
  }

  pause(): void {
    this.active = false;
    (this.node as AudioWorkletNode | null)?.port?.postMessage({ type: 'active', value: false });
  }

  resume(): void {
    if (this.stopped) return;
    this.active = true;
    (this.node as AudioWorkletNode | null)?.port?.postMessage({ type: 'active', value: true });
  }

  setMonitoring(enabled: boolean): void {
    if (this.monitor && this.context) {
      this.monitor.gain.setTargetAtTime(enabled ? 0.55 : 0, this.context.currentTime, 0.015);
    }
  }

  async stop(): Promise<RecordedResult> {
    this.stopped = true;
    this.active = false;
    const context = this.context;
    try {
      (this.node as AudioWorkletNode | null)?.port?.postMessage({ type: 'active', value: false });
      this.node?.disconnect();
      this.source?.disconnect();
      this.analyser?.disconnect();
      this.monitor?.disconnect();
      this.sink?.disconnect();
      this.stream?.getTracks().forEach((track) => track.stop());
    } finally {
      if (context && context.state !== 'closed') await context.close();
    }
    const channels = Array.from({ length: this.channelCount }, (_, c) => {
      const out = new Float32Array(this.frames);
      let offset = 0;
      for (const chunk of this.chunks) {
        const source = chunk[Math.min(c, chunk.length - 1)] ?? chunk[0];
        if (!source) continue;
        out.set(source, offset);
        offset += source.length;
      }
      return out;
    });
    const data = audioData(channels, this.sampleRate);
    if (data.length === 0) throw new Error('No microphone audio was captured. Check the selected input device.');
    const blob = encodeWavBlob(data, { bitDepth: 16, channels: data.channels.length >= 2 ? 2 : 1 });
    return { data, blob, duration: data.length / data.sampleRate, latencySeconds: this.latencySeconds };
  }
}

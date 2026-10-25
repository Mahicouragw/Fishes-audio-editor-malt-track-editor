import { clamp } from '../types';

export interface ScheduledClip {
  id: string;
  buffer: AudioBuffer;
  /** Timeline start, seconds. */
  start: number;
  /** Offset into the AudioBuffer, seconds. */
  sourceStart: number;
  /** Playable length, seconds. */
  duration: number;
  /** Linear gain for this clip (track volume, mute/solo and clip gain already applied). */
  gain: number;
  /** Stereo position, -1 (hard left) … 0 (centre) … +1 (hard right). */
  pan?: number;
}

export interface EngineCallbacks {
  onPosition?: (position: number) => void;
  onEnded?: () => void;
}

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
}

/**
 * One playback clock for every track. All sources are scheduled against the
 * same AudioContext.currentTime, so tracks cannot drift relative to each other.
 */
export class PlaybackEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiterNode: DynamicsCompressorNode | null = null;
  private active: ActiveSource[] = [];
  private clips: ScheduledClip[] = [];
  private callbacks: EngineCallbacks = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private speechPoll: ReturnType<typeof setInterval> | null = null;
  private originContextTime = 0;
  private originTimeline = 0;
  private position = 0;
  private duration = 0;
  private playing = false;
  private paused = false;
  private token = 0;
  private volume = 0.85;
  private ducked = false;

  constructor(private readonly contextFactory: () => AudioContext = () => new AudioContext()) {}

  private ensureContext(): AudioContext {
    if (this.context && this.context.state !== 'closed') return this.context;
    const context = this.contextFactory();
    const master = context.createGain();
    master.gain.value = this.volume;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter);
    limiter.connect(context.destination);
    this.context = context;
    this.master = master;
    this.limiterNode = limiter;
    this.startSpeechDucking();
    return context;
  }

  private startSpeechDucking(): void {
    if (this.speechPoll || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    // Screen reader / speech synthesis output should not distort or rapidly gate music.
    this.speechPoll = setInterval(() => {
      const speaking = Boolean(window.speechSynthesis?.speaking);
      if (speaking === this.ducked) return;
      this.ducked = speaking;
      if (this.master && this.context) {
        this.master.gain.setTargetAtTime(this.volume * (speaking ? 0.28 : 1), this.context.currentTime, 0.08);
      }
    }, 220);
  }

  private clearSources(): void {
    this.token++;
    for (const { source, gain, panner } of this.active) {
      source.onended = null;
      try { source.stop(); } catch { /* already ended */ }
      source.disconnect();
      gain.disconnect();
      panner?.disconnect();
    }
    this.active = [];
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setVolume(value: number): void {
    this.volume = clamp(value, 0, 1);
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.volume * (this.ducked ? 0.28 : 1), this.context.currentTime, 0.02);
    }
  }

  getPosition(): number {
    if (this.playing && this.context) {
      return clamp(this.originTimeline + (this.context.currentTime - this.originContextTime), 0, this.duration);
    }
    return this.position;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Stops any previous playback engine first — only one clock can own the graph. */
  async play(clips: ScheduledClip[], from: number, duration: number, callbacks: EngineCallbacks = {}): Promise<void> {
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();
    this.clearSources();
    this.clearTimer();
    this.clips = clips;
    this.duration = Math.max(0, duration);
    this.callbacks = callbacks;
    const startAt = clamp(from, 0, this.duration);
    this.position = startAt;
    this.paused = false;
    if (this.duration <= 0 || startAt >= this.duration) {
      this.playing = false;
      callbacks.onEnded?.();
      return;
    }
    const now = context.currentTime + 0.045;
    this.originContextTime = now;
    this.originTimeline = startAt;
    const currentToken = this.token;
    for (const clip of clips) {
      if (!clip.buffer || clip.duration <= 0 || clip.gain === 0) continue;
      const relativeStart = clip.start - startAt;
      const localOffset = clip.sourceStart + Math.max(0, -relativeStart);
      const maxFromSource = Math.max(0, clip.buffer.duration - localOffset);
      const playable = Math.min(clip.duration - Math.max(0, -relativeStart), maxFromSource);
      if (playable <= 0.0005 || relativeStart >= (this.duration - startAt)) continue;
      const source = context.createBufferSource();
      source.buffer = clip.buffer;
      const gain = context.createGain();
      // The export pan law is unity at centre, so the live panner is
      // compensated by √2 to match the exported file exactly.
      const pan = clamp(clip.pan ?? 0, -1, 1);
      gain.gain.value = clamp(clip.gain, 0, 4) * (pan === 0 ? 1 : Math.SQRT2);
      let panner: StereoPannerNode | null = null;
      source.connect(gain);
      if (typeof context.createStereoPanner === 'function' && pan !== 0) {
        panner = context.createStereoPanner();
        panner.pan.value = pan;
        gain.connect(panner);
        panner.connect(this.master ?? context.destination);
      } else {
        gain.connect(this.master ?? context.destination);
      }
      const when = now + Math.max(0, relativeStart);
      try {
        source.start(when, Math.max(0, localOffset), playable);
      } catch (error) {
        source.disconnect();
        gain.disconnect();
        throw new Error(`Could not start audio: ${(error as Error).message}`);
      }
      source.onended = () => {
        if (currentToken !== this.token) return;
        source.disconnect();
        gain.disconnect();
        panner?.disconnect();
      };
      this.active.push({ source, gain, panner });
    }
    this.playing = true;
    this.timer = setInterval(() => {
      if (currentToken !== this.token || !this.playing) return;
      const position = this.getPosition();
      this.callbacks.onPosition?.(position);
      if (position >= this.duration - 0.005) {
        const ended = this.callbacks.onEnded;
        this.stopInternal(true);
        this.position = this.duration;
        this.callbacks.onPosition?.(this.duration);
        ended?.();
      }
    }, 40);
  }

  private stopInternal(keepPaused: boolean): void {
    this.clearSources();
    this.clearTimer();
    this.playing = false;
    this.paused = keepPaused;
  }

  pause(): number {
    if (!this.playing) return this.position;
    const position = this.getPosition();
    this.stopInternal(true);
    this.position = position;
    return position;
  }

  async resume(): Promise<void> {
    if (this.playing) return;
    if (!this.clips.length) {
      this.paused = false;
      return;
    }
    await this.play(this.clips, this.position, this.duration, this.callbacks);
  }

  stop(): void {
    this.stopInternal(false);
    this.position = 0;
    this.callbacks.onPosition?.(0);
  }

  async seek(seconds: number): Promise<void> {
    const target = clamp(seconds, 0, this.duration);
    if (this.playing) {
      await this.play(this.clips, target, this.duration, this.callbacks);
    } else {
      // Idle or paused: just move the cursor. Not marked paused so Play
      // always starts a fresh, correctly scheduled pass.
      this.position = target;
      this.paused = false;
      this.callbacks.onPosition?.(target);
    }
  }

  async skip(seconds: number, fallbackSkip = 5): Promise<number> {
    const delta = Number.isFinite(seconds) ? seconds : fallbackSkip;
    const target = clamp(this.getPosition() + delta, 0, this.duration);
    await this.seek(target);
    return target;
  }

  async restart(): Promise<void> {
    await this.play(this.clips, 0, this.duration, this.callbacks);
  }

  /** Called when a project is closed, media changes, or the editor unmounts. */
  async dispose(): Promise<void> {
    this.stopInternal(false);
    if (this.speechPoll) clearInterval(this.speechPoll);
    this.speechPoll = null;
    this.active = [];
    this.clips = [];
    this.callbacks = {};
    const context = this.context;
    this.context = null;
    this.master = null;
    this.limiterNode = null;
    if (context && context.state !== 'closed') await context.close();
  }
}



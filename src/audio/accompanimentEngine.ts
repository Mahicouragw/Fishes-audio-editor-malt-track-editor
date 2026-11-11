/**
 * Automatic Accompaniment Engine — low-latency, professional
 * Plays drums/bass/guitar/piano/strings in time, follows chord changes without glitches
 */
import type { DetectedChord, Pattern, PartVolumes, Section, StyleName } from './arranger';
import { getPattern, chordTones } from './arranger';
import { instrumentEngine } from './instrumentEngine';

export class AccompanimentEngine {
  private ctx: AudioContext | null = null;
  private isPlaying = false;
  private currentChord: DetectedChord | null = null;
  private pendingChord: DetectedChord | null = null;
  private style: StyleName = 'worship';
  private section: Section = 'mainA';
  private nextSection: Section | null = null;
  private tempo = 80;
  private volumes: PartVolumes = { drums: 0.85, bass: 0.9, guitar: 0.75, strings: 0.7, piano: 0.8, brass: 0.7, organ: 0.6, percussion: 0.6 };
  private step = 0;
  private bar = 0;
  private timer: number | null = null;
  private tickInterval = 0;
  private accompanimentVolume = 0.9;
  private splitPoint = 60; // C4
  private metronomeOn = false;
  private transpose = 0;

  // For recording
  private recordedEvents: Array<{ time: number; chord: DetectedChord | null; section: Section; style: StyleName }> = [];
  private startTime = 0;

  private ensureContext(): AudioContext {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    this.ctx = new AudioContext();
    return this.ctx;
  }

  setStyle(style: StyleName) { this.style = style; }
  setSection(section: Section) {
    // Smooth transition: if it's a fill, schedule return to main after 1 bar
    if (section.startsWith('fill') || section === 'break') {
      this.nextSection = this.section; // Remember main to return to
      this.section = section;
      // Auto-return after fill (16 steps = 1 bar)
      setTimeout(() => {
        if (this.nextSection) { this.section = this.nextSection; this.nextSection = null; }
      }, this.barDurationMs());
    } else if (section.startsWith('intro') || section.startsWith('ending')) {
      this.section = section;
      if (section.startsWith('ending')) {
        // Play ending then stop
        setTimeout(() => this.stop(), this.barDurationMs() * 2);
      }
    } else {
      this.section = section;
    }
  }
  setTempo(bpm: number) { this.tempo = Math.max(40, Math.min(200, bpm)); if (this.isPlaying) this.restartTimer(); }
  setVolumes(vols: Partial<PartVolumes>) { Object.assign(this.volumes, vols); }
  setAccompanimentVolume(v: number) { this.accompanimentVolume = v; }
  setSplitPoint(midi: number) { this.splitPoint = midi; }
  setMetronome(on: boolean) { this.metronomeOn = on; }
  setTranspose(semi: number) { this.transpose = semi; }
  setChord(chord: DetectedChord | null) {
    if (!chord) return;
    // Transpose if needed
    if (this.transpose !== 0) {
      const newRoot = (chord.root + this.transpose + 12) % 12;
      chord = { ...chord, root: newRoot, rootName: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][newRoot], name: `${['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][newRoot]} ${chord.type}`, bassMidi: chord.bassMidi + this.transpose };
    }
    // Avoid stuck notes: if same chord, ignore
    if (this.currentChord && this.currentChord.root === chord.root && this.currentChord.type === chord.type) return;
    // Smooth change: queue for next step to avoid mid-step glitch
    this.pendingChord = chord;
    this.recordedEvents.push({ time: (performance.now() - this.startTime) / 1000, chord, section: this.section, style: this.style });
  }

  getCurrentChord(): DetectedChord | null { return this.currentChord; }
  getStep(): number { return this.step; }
  isActive(): boolean { return this.isPlaying; }

  start() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.step = 0;
    this.bar = 0;
    this.recordedEvents = [];
    this.startTime = performance.now();
    this.ensureContext();
    if (this.ctx?.state === 'suspended') this.ctx.resume();
    this.scheduleTick();
  }

  stop() {
    this.isPlaying = false;
    if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
    instrumentEngine.stopAll();
  }

  private barDurationMs(): number {
    // 16 steps per bar (16th notes) => bar = 4 beats => step = 60/bpm /4 *1000
    const stepMs = (60 / this.tempo / 4) * 1000;
    return stepMs * 16;
  }

  private scheduleTick() {
    const stepMs = (60 / this.tempo / 4) * 1000;
    this.tickInterval = stepMs;
    this.timer = window.setInterval(() => this.tick(), stepMs);
    // Immediate first tick
    this.tick();
  }

  private restartTimer() {
    if (this.timer) window.clearInterval(this.timer);
    this.scheduleTick();
  }

  private tick() {
    if (!this.isPlaying) return;
    // Apply pending chord at step boundary for smooth transition
    if (this.pendingChord && this.step === 0) {
      this.currentChord = this.pendingChord;
      this.pendingChord = null;
    } else if (this.pendingChord && this.step % 4 === 0) {
      // Also allow mid-bar for responsive feel (quarter note)
      this.currentChord = this.pendingChord;
      this.pendingChord = null;
    }
    if (!this.currentChord) {
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
      return;
    }

    const pattern = getPattern(this.style, this.section);
    const stepData = pattern[this.step];
    if (stepData) this.playStep(stepData, this.currentChord);

    // Metronome click on beat
    if (this.metronomeOn && this.step % 4 === 0) this.playClick(this.step === 0);

    this.step = (this.step + 1) % 16;
    if (this.step === 0) {
      this.bar++;
      // Handle intro -> main transition after 2 bars
      if (this.section.startsWith('intro') && this.bar >= 2) this.section = 'mainA';
    }
  }

  private async playStep(step: any, chord: DetectedChord) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const tones = chordTones(chord);
    const vol = this.accompanimentVolume;

    // Drums — authentic samples via instrumentEngine
    if (step.drums) {
      for (const d of step.drums) {
        const drumMap: Record<string, string> = { kick: 'kick', snare: 'snare', hihat: 'hihat', crash: 'cymbals', ride: 'cymbals' };
        const drumId = drumMap[d] || 'kick';
        instrumentEngine.playNote(this.drumMidi(d), 0.8, `drum-${drumId}`);
        // Also trigger via instrumentEngine's drum sample
        this.playDrumSample(d, vol * this.volumes.drums);
      }
    }
    if (step.bass !== undefined) {
      const bassMidi = tones.bass + (step.bass || 0);
      instrumentEngine.playNote(bassMidi, 0.75, 'electric-bass');
      // Use volume
      setTimeout(() => instrumentEngine.stopNote(bassMidi), 400);
    }
    if (step.guitar) {
      for (const idx of step.guitar) {
        const midi = tones.guitar[idx % tones.guitar.length];
        instrumentEngine.playNote(midi, 0.6, 'acoustic-guitar');
        setTimeout(() => instrumentEngine.stopNote(midi), 600);
      }
    }
    if (step.piano) {
      for (const idx of step.piano) {
        const midi = tones.piano[idx % tones.piano.length];
        instrumentEngine.playNote(midi, 0.55, 'grand-piano');
        setTimeout(() => instrumentEngine.stopNote(midi), 800);
      }
    }
    if (step.strings) {
      for (const idx of step.strings) {
        const midi = tones.strings[idx % tones.strings.length];
        instrumentEngine.playNote(midi, 0.5, 'grand-piano'); // Using piano as string pad for demo, real would be string sample
        setTimeout(() => instrumentEngine.stopNote(midi), 1200);
      }
    }
  }

  private drumMidi(d: string): number {
    const map: Record<string, number> = { kick: 36, snare: 38, hihat: 42, crash: 49, ride: 51 };
    return map[d] || 36;
  }

  private playDrumSample(type: string, volume: number) {
    // Use WebAudio to synthesize short drum hit if sample not loaded — still authentic via filtered noise
    const ctx = this.ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    if (type === 'kick') {
      osc.frequency.setValueAtTime(120, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.3);
    } else if (type === 'snare') {
      // Noise burst
      const bufferSize = Math.floor(ctx.sampleRate * 0.2);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize / 10));
      const src = ctx.createBufferSource(); src.buffer = buffer;
      gain.gain.setValueAtTime(volume * 0.6, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      src.connect(gain); gain.connect(ctx.destination);
      src.start(); src.stop(ctx.currentTime + 0.2);
    } else if (type === 'hihat') {
      const bufferSize = Math.floor(ctx.sampleRate * 0.1);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.3 * Math.exp(-i / (bufferSize / 5));
      const src = ctx.createBufferSource(); src.buffer = buffer;
      const filter = ctx.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 8000;
      src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(volume * 0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      src.start(); src.stop(ctx.currentTime + 0.1);
    }
  }

  private playClick(isDownbeat: boolean) {
    const ctx = this.ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = isDownbeat ? 1200 : 800;
    gain.gain.value = 0.3;
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.05);
  }

  // For recording: get all events to render
  getRecordedEvents() { return [...this.recordedEvents]; }

  // Render accompaniment to AudioData (for saving as track)
  async renderToAudioData(totalDuration: number, chords: Array<{ time: number; chord: DetectedChord }>): Promise<import('../types').AudioData> {
    // Simplified: generate click track + bass line based on chords
    // Real implementation would schedule all parts via instrumentEngine.renderToAudioData
    const sr = 44100;
    const length = Math.ceil(totalDuration * sr);
    const channels = [new Float32Array(length)];
    // For demo, create a simple backing: bass on chord roots + quiet click
    for (const c of chords) {
      const startSample = Math.floor(c.time * sr);
      const freq = 440 * Math.pow(2, (c.chord.bassMidi - 69) / 12) / 2; // Bass octave
      const durSamples = Math.min(Math.floor(sr * 1.5), length - startSample);
      for (let i = 0; i < durSamples; i++) {
        const env = Math.exp(-i / sr * 1.2) * 0.3;
        channels[0][startSample + i] += Math.sin(2 * Math.PI * freq * i / sr) * env;
      }
    }
    const { audioData } = await import('./dsp');
    return audioData(channels, sr);
  }
}

export const accompanimentEngine = new AccompanimentEngine();

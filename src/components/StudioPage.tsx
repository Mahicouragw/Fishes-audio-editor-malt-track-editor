import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectStore } from '../store/projectStore';
import { Transport } from './Transport';
import { Timeline } from './Timeline';
import { TrackControls, VocalPanel, HarmonyPanel, RangeEffectsPanel } from './EffectsPanel';
import { RecordPanel } from './RecordPanel';
import { SilencePanel } from './SilencePanel';
import { MergePanel } from './MergePanel';
import { ExportDialog } from './ExportDialog';
import { PlaybackEngine, type ScheduledClip } from '../audio/engine';
import { loadAudioData, storeAudioData, cacheAudioData } from '../storage/assets';
import { audioDataToAudioBuffer } from '../audio/decode';
import { decodeWav } from '../audio/wav';
import { encodeWavBlob } from '../audio/wav';
import { prepareClipData, effectivePitchSemis, harmonyClipFactor } from '../audio/mixdown';
import { runDspJob } from '../audio/dspRunner';
import { useDsp } from '../audio/useDsp';
import type { SeparationResult } from '../audio/separation';
import type { AudioData, Clip, RangeEffect, Track } from '../types';
import { clamp, formatTime, makeId, projectDuration } from '../types';

export type StudioTab = 'effects' | 'record' | 'silence' | 'merge';

interface Prepared {
  key: string;
  buffer: AudioBuffer;
  duration: number;
}

function clipKey(track: Track, clip: Clip): string {
  const v = track.vocal;
  const vocalKey = v.enabled
    ? (v.status === 'ready' && v.vocalAssetId
      ? `stems|${v.vocalAssetId}|${v.instrumentalAssetId ?? 'none'}|${v.pitchSemis}|${v.preserveTempo}|${v.vocalVolume}|${v.mixWithAccompaniment}`
      : 'fallback')
    : 'off';
  return [clip.assetId, effectivePitchSemis(track), vocalKey, clip.fadeIn, clip.fadeOut, JSON.stringify(clip.effects), clip.sourceStart].join('|');
}

export function StudioPage({ store, initialTab = 'effects' }: { store: ProjectStore; initialTab?: StudioTab }) {
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const [showExport, setShowExport] = useState(false);
  const [activeTab, setActiveTab] = useState<StudioTab>(initialTab);
  const [prep, setPrep] = useState({ busy: false, progress: 0, message: '' });
  const engineRef = useRef<PlaybackEngine | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const preparedRef = useRef(new Map<string, Prepared>());
  const prepTokenRef = useRef(0);
  const positionRef = useRef(0);
  const fallbackAnnouncedRef = useRef<Set<string>>(new Set());

  const dsp = useDsp();
  const project = store.project;
  const selectedTrack = project.tracks.find((t) => t.id === project.selectedTrackId) ?? project.tracks[0] ?? null;

  const duration = useMemo(() => projectDuration(project, new Map<string, number>()), [project]);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const getEngine = useCallback(() => {
    if (!engineRef.current) engineRef.current = new PlaybackEngine();
    return engineRef.current;
  }, []);

  const getAudioContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }, []);

  useEffect(() => {
    getEngine().setVolume(store.settings.masterVolume);
  }, [getEngine, store.settings.masterVolume]);

  // Project changed: stop playback, drop cached renders, reset the cursor.
  const projectId = project.id;
  useEffect(() => {
    getEngine().stop();
    setPlaying(false);
    setPaused(false);
    setPosition(0);
    positionRef.current = 0;
    preparedRef.current.clear();
    fallbackAnnouncedRef.current.clear();
  }, [projectId, getEngine]);

  useEffect(() => () => {
    void getEngine().dispose().catch(() => undefined);
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
  }, [getEngine]);

  const toScheduledClip = useCallback((track: Track, clip: Clip, prepared: Prepared): ScheduledClip => {
    const playable = Math.max(0, Math.min(clip.duration, prepared.duration - clip.sourceStart));
    return {
      id: clip.id,
      buffer: prepared.buffer,
      start: clip.start,
      sourceStart: clip.sourceStart,
      duration: playable,
      gain: track.volume * clip.gain * harmonyClipFactor(track, clip, project.harmonies),
    };
  }, [project.harmonies]);

  /** Render every audible clip through its committed chain (worker, cached), then schedule. */
  const ensurePrepared = useCallback(async (): Promise<ScheduledClip[]> => {
    const token = ++prepTokenRef.current;
    const audible = (t: Track) => !t.muted && (project.tracks.some((s) => s.solo) ? t.solo : true);
    const wanted: Array<{ track: Track; clip: Clip; key: string }> = [];
    for (const track of project.tracks) {
      if (!audible(track)) continue;
      for (const clip of track.clips) wanted.push({ track, clip, key: clipKey(track, clip) });
    }
    const todo = wanted.filter((w) => preparedRef.current.get(w.key)?.key !== w.key);
    if (todo.length) {
      setPrep({ busy: true, progress: 0, message: 'Preparing audio' });
      try {
        for (let i = 0; i < todo.length; i++) {
          if (token !== prepTokenRef.current) throw new Error('Interrupted');
          const { track, clip, key } = todo[i];
          if (track.vocal.enabled && !(track.vocal.status === 'ready' && track.vocal.vocalAssetId)
            && !fallbackAnnouncedRef.current.has(track.id)) {
            fallbackAnnouncedRef.current.add(track.id);
            store.announce(`${track.name}: vocal processing is ON but no stems exist — pitch is applied to the whole track. Run vocal separation for stem-only processing.`);
          }
          setPrep({ busy: true, progress: i / todo.length, message: `Rendering ${clip.name}` });
          const data = await prepareClipData(track, clip, {
            onProgress: (p, m) => {
              if (token === prepTokenRef.current) setPrep({ busy: true, progress: (i + p) / todo.length, message: `${m} — ${clip.name}` });
            },
          });
          const buffer = await audioDataToAudioBuffer(getAudioContext(), data);
          preparedRef.current.set(key, { key, buffer, duration: buffer.duration });
        }
      } finally {
        if (token === prepTokenRef.current) setPrep({ busy: false, progress: 0, message: '' });
      }
    }
    return wanted.map((w) => toScheduledClip(w.track, w.clip, preparedRef.current.get(w.key)!));
  }, [getAudioContext, project, store, toScheduledClip]);

  const startPlayback = useCallback(async (from: number) => {
    setError('');
    if (prep.busy) return;
    try {
      const clips = await ensurePrepared();
      const d = Math.max(0, durationRef.current);
      if (!clips.length) {
        setError('No audible audio to play. Import or record audio first.');
        return;
      }
      const engine = getEngine();
      await engine.play(clips, from, d, {
        onPosition: (p) => {
          positionRef.current = p;
          setPosition(p);
        },
        onEnded: () => {
          setPlaying(false);
          setPaused(false);
          positionRef.current = d;
          setPosition(d);
          store.announce('Playback finished');
        },
      });
      setPlaying(true);
      setPaused(false);
    } catch (e) {
      setError((e as Error).message);
      setPlaying(false);
      setPaused(false);
    }
  }, [ensurePrepared, getEngine, prep.busy, store]);

  const handlePlay = useCallback(async () => {
    const engine = getEngine();
    if (engine.isPaused()) {
      await engine.resume();
      setPlaying(true);
      setPaused(false);
      store.announce('Resumed');
      return;
    }
    await startPlayback(positionRef.current);
  }, [getEngine, startPlayback, store]);

  const handlePause = useCallback(() => {
    const p = getEngine().pause();
    positionRef.current = p;
    setPosition(p);
    setPlaying(false);
    setPaused(true);
    store.announce(`Paused at ${formatTime(p)}`);
  }, [getEngine, store]);

  const handleStop = useCallback(() => {
    getEngine().stop();
    positionRef.current = 0;
    setPosition(0);
    setPlaying(false);
    setPaused(false);
    store.announce('Stopped');
  }, [getEngine, store]);

  const handleSeek = useCallback(async (t: number) => {
    const target = clamp(t, 0, durationRef.current);
    positionRef.current = target;
    setPosition(target);
    const engine = getEngine();
    if (engine.isPlaying() || engine.isPaused()) await engine.seek(target);
  }, [getEngine]);

  const handleSkip = useCallback(async (delta: number) => {
    const engine = getEngine();
    let target: number;
    if (engine.isPlaying() || engine.isPaused()) {
      target = await engine.skip(delta, store.settings.skipSeconds);
    } else {
      target = clamp(positionRef.current + delta, 0, durationRef.current);
    }
    positionRef.current = target;
    setPosition(target);
  }, [getEngine, store.settings.skipSeconds]);

  const handleRestart = useCallback(async () => {
    positionRef.current = 0;
    setPosition(0);
    const engine = getEngine();
    if (engine.isPlaying() || engine.isPaused()) await engine.seek(0);
    else await startPlayback(0);
  }, [getEngine, startPlayback]);

  /** Play a single rendered buffer (previews never touch the prepared cache). */
  const playPreview = useCallback(async (label: string, data: AudioData) => {
    try {
      const buffer = await audioDataToAudioBuffer(getAudioContext(), data);
      const engine = getEngine();
      await engine.play(
        [{ id: makeId('preview'), buffer, start: 0, sourceStart: 0, duration: buffer.duration, gain: 1 }],
        0,
        buffer.duration,
        {
          onPosition: (p) => { positionRef.current = p; setPosition(p); },
          onEnded: () => { setPlaying(false); setPaused(false); },
        },
      );
      setPlaying(true);
      setPaused(false);
      store.announce(`Preview: ${label}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [getAudioContext, getEngine, store]);

  const handlePreview = useCallback(async (kind: 'original' | 'vocal' | 'processed') => {
    if (!selectedTrack?.clips.length) { setError('Select a track with audio to preview'); return; }
    setError('');
    try {
      if (kind === 'original') {
        const data = await loadAudioData(selectedTrack.clips[0].assetId);
        await playPreview('original', data);
      } else if (kind === 'vocal') {
        if (!selectedTrack.vocal.vocalAssetId) throw new Error('No vocal stem available yet');
        const data = await loadAudioData(selectedTrack.vocal.vocalAssetId);
        await playPreview('isolated vocal stem', data);
      } else {
        const v = selectedTrack.vocal;
        const original = await loadAudioData(selectedTrack.clips[0].assetId);
        const vocal = v.vocalAssetId ? await loadAudioData(v.vocalAssetId) : null;
        const instrumental = v.instrumentalAssetId ? await loadAudioData(v.instrumentalAssetId) : null;
        if (!v.enabled || !vocal) throw new Error('Turn on Human Voice Processing and run separation first');
        const result = await runDspJob({
          kind: 'voiceOnly',
          original,
          vocal,
          instrumental,
          options: {
            enabled: true,
            semitones: v.pitchSemis,
            preserveTempo: v.preserveTempo,
            vocalVolume: v.vocalVolume,
            mixWithAccompaniment: v.mixWithAccompaniment,
          },
        });
        if (!result.data) throw new Error('Vocal processing produced no audio');
        await playPreview('processed vocals with accompaniment', result.data);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [playPreview, selectedTrack]);

  /** Preview a whole track, optionally with a temporary pitch (before committing it). */
  const previewTrack = useCallback(async (track: Track, semisOverride?: number) => {
    setError('');
    if (!track.clips.length) { setError(`${track.name} has no audio to preview`); return; }
    try {
      const simulated: Track = semisOverride === undefined ? track : { ...track, pitchSemis: semisOverride, pitchFineCents: 0 };
      const rendered: ScheduledClip[] = [];
      for (let i = 0; i < track.clips.length; i++) {
        const clip = track.clips[i];
        const data = await prepareClipData(simulated, clip, {
          onProgress: (p, m) => setPrep({ busy: true, progress: (i + p) / track.clips.length, message: `Preview: ${m}` }),
        });
        const buffer = await audioDataToAudioBuffer(getAudioContext(), data);
        const playable = Math.max(0, Math.min(clip.duration, buffer.duration - clip.sourceStart));
        rendered.push({ id: clip.id, buffer, start: clip.start, sourceStart: clip.sourceStart, duration: playable, gain: track.volume * clip.gain });
      }
      const end = Math.max(...rendered.map((c) => c.start + c.duration));
      const engine = getEngine();
      await engine.play(rendered, 0, end, {
        onPosition: (p) => { positionRef.current = p; setPosition(p); },
        onEnded: () => { setPlaying(false); setPaused(false); },
      });
      setPrep({ busy: false, progress: 0, message: '' });
      setPlaying(true);
      setPaused(false);
      store.announce(semisOverride === undefined ? `Preview: ${track.name}` : `Preview: ${track.name} at ${semisOverride >= 0 ? '+' : ''}${semisOverride} semitones (not applied yet)`);
    } catch (e) {
      setPrep({ busy: false, progress: 0, message: '' });
      setError((e as Error).message);
    }
  }, [getAudioContext, getEngine, store]);

  const handleTrackPitch = useCallback((trackId: string, semitones: number, cents = 0) => {
    store.setTrackPitch(trackId, semitones, cents);
    store.announce(`${(project.tracks.find((t) => t.id === trackId) ?? {}).name ?? 'Track'} pitch applied: ${semitones >= 0 ? '+' : ''}${semitones} semitones${cents ? `, ${cents} cents` : ''}`);
  }, [project.tracks, store]);

  const handleSeparate = useCallback(async () => {
    if (!selectedTrack || !selectedTrack.clips.length) { setError('Select a track with audio to separate'); return; }
    setError('');
    store.setVocalState(selectedTrack.id, { status: 'processing', error: undefined, warning: undefined });
    const clip = selectedTrack.clips[0];
    const trackId = selectedTrack.id;
    const trackName = selectedTrack.name;
    try {
      let vocal: AudioData;
      let instrumental: AudioData;
      let meta: { quality: number; method: 'local-approximate' | 'demucs-server'; message: string; warning?: string };
      const apiUrl = store.settings.separationApiUrl.trim();
      if (apiUrl) {
        const data = await loadAudioData(clip.assetId);
        const blob = encodeWavBlob(data, { bitDepth: 16, channels: data.channels.length >= 2 ? 2 : 1 });
        const form = new FormData();
        form.append('file', blob, 'track.wav');
        const base = apiUrl.replace(/\/$/, '');
        const response = await fetch(`${base}/separate`, { method: 'POST', body: form });
        if (!response.ok) throw new Error(`Separation server error: ${response.status} ${await response.text()}`);
        const result = (await response.json()) as { vocalUrl?: string; instrumentalUrl?: string; quality?: number; message?: string };
        if (!result.vocalUrl || !result.instrumentalUrl) throw new Error('Separation server did not return vocal and accompaniment stems');
        const fetchStem = async (rawUrl: string): Promise<AudioData> => {
          const stemResponse = await fetch(new URL(rawUrl, base).href);
          if (!stemResponse.ok) throw new Error(`Could not download stem: ${stemResponse.status}`);
          const buffer = await stemResponse.arrayBuffer();
          try {
            return decodeWav(buffer);
          } catch {
            const ctx = new AudioContext();
            try {
              const decoded = await ctx.decodeAudioData(buffer.slice(0));
              return {
                channels: Array.from({ length: decoded.numberOfChannels }, (_, c) => new Float32Array(decoded.getChannelData(c))),
                sampleRate: decoded.sampleRate,
                length: decoded.length,
              };
            } finally {
              if (ctx.state !== 'closed') await ctx.close();
            }
          }
        };
        [vocal, instrumental] = await Promise.all([fetchStem(result.vocalUrl), fetchStem(result.instrumentalUrl)]);
        meta = { quality: result.quality ?? 0.9, method: 'demucs-server', message: 'Separation completed by Demucs server', warning: undefined };
      } else {
        const data = await loadAudioData(clip.assetId);
        const outcome = await dsp.run({ kind: 'separate', data });
        const separation = (outcome.result ?? outcome.data) as SeparationResult | undefined;
        if (!separation || !separation.vocal) throw new Error('Vocal separation produced no stems');
        vocal = separation.vocal;
        instrumental = separation.instrumental;
        meta = { quality: separation.quality, method: 'local-approximate', message: separation.message, warning: separation.warning };
      }
      const vocalAsset = await storeAudioData(vocal, `${trackName} vocals`, 'processed');
      const instAsset = await storeAudioData(instrumental, `${trackName} instrumental`, 'processed');
      cacheAudioData(vocalAsset.id, vocal);
      cacheAudioData(instAsset.id, instrumental);
      store.setVocalState(trackId, {
        status: 'ready',
        method: meta.method,
        vocalAssetId: vocalAsset.id,
        instrumentalAssetId: instAsset.id,
        separatedFromAssetId: clip.assetId,
        quality: meta.quality,
        qualityMessage: meta.message,
        warning: meta.warning,
        error: undefined,
      });
      store.announce(`Vocal separation ready (${Math.round(meta.quality * 100)}% confidence)`);
    } catch (e) {
      store.setVocalState(trackId, { status: 'failed', error: (e as Error).message });
      setError((e as Error).message);
    }
  }, [selectedTrack, store, dsp]);

  const handleHarmony = useCallback(async (sourceId: string, targetId: string, semitones: number, vocalsOnly: boolean) => {
    setError('');
    const source = project.tracks.find((t) => t.id === sourceId);
    if (!source || !source.clips.length) { setError('Source track has no audio'); return; }
    try {
      let data = await loadAudioData(source.clips[0].assetId);
      if (vocalsOnly) {
        if (!source.vocal.vocalAssetId) throw new Error('No isolated vocals on the source track — run vocal separation first, or turn off “vocals only”');
        data = await loadAudioData(source.vocal.vocalAssetId);
      }
      const outcome = await dsp.run({ kind: 'pitch', data, semitones });
      if (!outcome.data) throw new Error('Harmony rendering produced no audio');
      await store.addHarmony(sourceId, targetId, semitones, outcome.data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [dsp, project.tracks, store]);

  const findClip = useCallback((clipId: string): { track: Track; clip: Clip } | null => {
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return null;
  }, [project.tracks]);

  const handleHarmonyPreview = useCallback(async (harmonyId: string) => {
    const layer = project.harmonies.find((h) => h.id === harmonyId);
    if (!layer?.clipId) { setError('Harmony layer has no audio'); return; }
    const found = findClip(layer.clipId);
    if (!found) { setError('Harmony clip not found'); return; }
    setError('');
    try {
      const prepared = preparedRef.current.get(clipKey(found.track, found.clip));
      let buffer: AudioBuffer;
      if (prepared) {
        buffer = prepared.buffer;
      } else {
        const data = await prepareClipData(found.track, found.clip);
        buffer = await audioDataToAudioBuffer(getAudioContext(), data);
      }
      const playable = Math.max(0, Math.min(found.clip.duration, buffer.duration - found.clip.sourceStart));
      const engine = getEngine();
      await engine.play(
        [{ id: found.clip.id, buffer, start: 0, sourceStart: found.clip.sourceStart, duration: playable, gain: 1 }],
        0,
        playable,
        { onEnded: () => { setPlaying(false); setPaused(false); } },
      );
      setPlaying(true);
      setPaused(false);
      store.announce(`Preview: ${layer.name}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [findClip, getAudioContext, getEngine, project.harmonies, store]);

  // Range effects — validate against the actual clip, preview before applying.
  const rangeTargetClip = useCallback((): { track: Track; clip: Clip } | null => {
    if (project.selectedClipId) {
      const found = findClip(project.selectedClipId);
      if (found) return found;
    }
    const track = selectedTrack ?? project.tracks[0];
    if (track?.clips.length) return { track, clip: track.clips[0] };
    return null;
  }, [findClip, project.selectedClipId, project.tracks, selectedTrack]);

  const rangeClipDuration = useCallback(async (): Promise<number> => {
    const target = rangeTargetClip();
    if (!target) return 0;
    try {
      const data = await loadAudioData(target.clip.assetId);
      return data.length / data.sampleRate;
    } catch {
      return target.clip.duration;
    }
  }, [rangeTargetClip]);

  const runRangeEffect = useCallback(async (effect: RangeEffect, apply: boolean): Promise<void> => {
    setError('');
    const target = rangeTargetClip();
    if (!target) throw new Error('No clip to apply the effect to — import audio first');
    const data = await loadAudioData(target.clip.assetId);
    const clipSeconds = data.length / data.sampleRate;
    if (effect.start >= effect.end) throw new Error('Start time must be earlier than end time');
    if (effect.start < 0 || effect.end > clipSeconds + 0.001) throw new Error(`Selection must be inside this clip (0 to ${formatTime(clipSeconds)})`);
    const outcome = await dsp.run({ kind: 'range', data, effect });
    if (!outcome.data) throw new Error('Effect produced no audio');
    if (!apply) {
      await playPreview(`${effect.type} on selected range (preview, not applied)`, outcome.data);
      return;
    }
    const asset = await storeAudioData(outcome.data, `${target.clip.name} (${effect.type})`, 'processed');
    cacheAudioData(asset.id, outcome.data);
    store.updateProject((p) => {
      for (const t of p.tracks) {
        const c = t.clips.find((x) => x.id === target.clip.id);
        if (c) {
          c.assetId = asset.id;
          c.duration = outcome.data!.length / outcome.data!.sampleRate;
          break;
        }
      }
      return p;
    });
    store.announce(`${effect.type} applied to ${formatTime(effect.start)}–${formatTime(effect.end)}; original kept for undo`);
  }, [dsp, playPreview, rangeTargetClip, store]);

  const handleRangePreview = useCallback(async (effect: RangeEffect) => {
    try {
      await runRangeEffect(effect, false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runRangeEffect]);

  const handleRangeApply = useCallback(async (effect: RangeEffect) => {
    try {
      await runRangeEffect(effect, true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runRangeEffect]);

  return (
    <div className="studio">
      <header className="studio-header">
        <h1>Multitrack Studio</h1>
        <div className="row wrap">
          <button type="button" className="btn" aria-label="Undo" disabled={!store.canUndo || dsp.busy} onClick={store.undo}>Undo</button>
          <button type="button" className="btn" aria-label="Redo" disabled={!store.canRedo || dsp.busy} onClick={store.redo}>Redo</button>
          <button type="button" className="btn" aria-label="New track" onClick={() => store.addTrack()}>New track</button>
          <button type="button" className="btn" aria-label="Save project" onClick={() => store.save().catch(() => undefined)}>Save project</button>
          <button type="button" className="btn btn-primary" aria-label="Export audio" onClick={() => setShowExport(true)}>Export</button>
          <span className="hint" aria-live="polite">{formatTime(position)} / {formatTime(duration)}</span>
        </div>
      </header>

      <Transport
        position={position} duration={duration} playing={playing} paused={paused} skipSeconds={store.settings.skipSeconds}
        onPlay={handlePlay} onPause={handlePause} onStop={handleStop}
        onSkipBack={() => handleSkip(-store.settings.skipSeconds)} onSkipForward={() => handleSkip(store.settings.skipSeconds)}
        onSeek={handleSeek} onRestart={handleRestart}
      />

      {prep.busy && (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(prep.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={prep.message}>
          <div className="progress-bar" style={{ width: `${prep.progress * 100}%` }} />
          <span aria-live="polite">{prep.message} {Math.round(prep.progress * 100)}%</span>
        </div>
      )}

      {dsp.busy && (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(dsp.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={dsp.message}>
          <div className="progress-bar" style={{ width: `${dsp.progress * 100}%` }} />
          <span aria-live="polite">{dsp.message} {Math.round(dsp.progress * 100)}%</span>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      <div className="studio-layout">
        <div className="studio-main">
          <Timeline
            project={project} position={position} duration={duration}
            onSeek={handleSeek}
            onSelectTrack={store.selectTrack}
            onSelectClip={store.selectClip}
            onSelection={store.setSelection}
            onSelectionEnd={(sel) => store.announce(sel ? `Selected ${formatTime(sel.start)} to ${formatTime(sel.end)}` : 'Selection cleared')}
            onMoveClip={(id, start) => store.updateClip(id, { start: Math.max(0, start) })}
            onTrimClip={(id, start, dur) => store.trimClip(id, start, dur)}
            onSplitClip={(id, at) => store.splitClip(id, at)}
            onDeleteClip={store.deleteClip}
          />
          <div className="zoom-row">
            <button type="button" className="btn btn-xs" aria-label="Zoom timeline in" onClick={() => store.setZoom(project.zoom * 1.25)}>Zoom in</button>
            <button type="button" className="btn btn-xs" aria-label="Zoom timeline out" onClick={() => store.setZoom(project.zoom / 1.25)}>Zoom out</button>
            <span className="hint">Shift+drag on the ruler (or timeline) to select a range</span>
          </div>
        </div>

        <aside className="studio-side" aria-label="Editing panels">
          <div className="tabs" role="tablist" aria-label="Studio panels">
            {(['effects', 'record', 'silence', 'merge'] as const).map((tab) => (
              <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={`tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>{tab}</button>
            ))}
          </div>

          {activeTab === 'effects' && (
            <>
              {selectedTrack && (
                <>
                  <TrackControls
                    track={selectedTrack}
                    busy={prep.busy || dsp.busy}
                    onPitch={(s, c) => handleTrackPitch(selectedTrack.id, s, c)}
                    onPreviewPitch={(s) => previewTrack(selectedTrack, s)}
                    onPreviewOriginal={() => previewTrack(selectedTrack)}
                    onVolume={(v) => store.setTrackVolume(selectedTrack.id, v)}
                    onMute={() => store.toggleMute(selectedTrack.id)}
                    onSolo={() => store.toggleSolo(selectedTrack.id)}
                    onRename={(n) => store.renameTrack(selectedTrack.id, n)}
                    onDuplicate={() => store.duplicateTrack(selectedTrack.id)}
                    onDelete={() => store.deleteTrack(selectedTrack.id)}
                  />
                  <VocalPanel
                    track={selectedTrack}
                    onToggle={(v) => store.setVocalState(selectedTrack.id, { enabled: v })}
                    onPitch={(s) => store.setVocalState(selectedTrack.id, { pitchSemis: s })}
                    onPreserve={(v) => store.setVocalState(selectedTrack.id, { preserveTempo: v })}
                    onVocalVolume={(v) => store.setVocalState(selectedTrack.id, { vocalVolume: v })}
                    onMix={(v) => store.setVocalState(selectedTrack.id, { mixWithAccompaniment: v })}
                    onSeparate={handleSeparate}
                    onPreview={handlePreview}
                    busy={dsp.busy} progress={dsp.progress} message={dsp.message}
                  />
                </>
              )}
              <HarmonyPanel
                tracks={project.tracks}
                harmonies={project.harmonies}
                onCreate={handleHarmony}
                onPreview={handleHarmonyPreview}
                onMute={(id, muted) => store.updateHarmony(id, { muted })}
                onGain={(id, gain) => store.updateHarmony(id, { gain })}
                onRemove={store.removeHarmony}
                onDuplicate={store.duplicateHarmony}
                busy={dsp.busy}
              />
              <RangeEffectsPanel
                duration={duration}
                selection={project.selection}
                clipDuration={rangeClipDuration}
                onSelection={store.setSelection}
                onPreview={handleRangePreview}
                onApply={handleRangeApply}
                busy={dsp.busy} progress={dsp.progress} message={dsp.message}
              />
            </>
          )}
          {activeTab === 'record' && <RecordPanel store={store} position={position} />}
          {activeTab === 'silence' && <SilencePanel store={store} />}
          {activeTab === 'merge' && <MergePanel store={store} />}
        </aside>
      </div>

      {showExport && <ExportDialog store={store} onClose={() => setShowExport(false)} />}
    </div>
  );
}

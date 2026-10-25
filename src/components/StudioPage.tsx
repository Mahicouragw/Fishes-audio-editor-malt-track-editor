import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectStore } from '../store/projectStore';
import { Transport } from './Transport';
import { Timeline } from './Timeline';
import { TrackControls, VocalPanel, HarmonyPanel, RangeEffectsPanel } from './EffectsPanel';
import { RecordPanel } from './RecordPanel';
import { SilencePanel } from './SilencePanel';
import { MergePanel } from './MergePanel';
import { ExportDialog } from './ExportDialog';
import { PlaybackEngine } from '../audio/engine';
import { loadAudioData } from '../storage/assets';
import { pitchShift, processVoiceOnly } from '../audio/dsp';
import { separateVocalsLocal } from '../audio/separation';
import { audioDataToAudioBuffer } from '../audio/decode';
import type { AudioData, RangeEffect } from '../types';
import { formatTime, projectDuration } from '../types';

export function StudioPage({ store }: { store: ProjectStore }) {
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const [showExport, setShowExport] = useState(false);
  const [separating, setSeparating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [harmonyBusy, setHarmonyBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<'effects' | 'record' | 'silence' | 'merge'>('effects');
  const engineRef = useRef<PlaybackEngine | null>(null);
  const selectedTrack = store.project.tracks.find((t) => t.id === store.project.selectedTrackId) ?? store.project.tracks[0] ?? null;

  const getEngine = useCallback(() => {
    if (!engineRef.current) engineRef.current = new PlaybackEngine();
    return engineRef.current;
  }, []);

  useEffect(() => {
    const engine = getEngine();
    engine.setVolume(store.settings.masterVolume);
  }, [getEngine, store.settings.masterVolume]);

  useEffect(() => {
    const lengths = new Map<string, number>();
    const load = async () => {
      for (const track of store.project.tracks) {
        for (const clip of track.clips) {
          try {
            const data = await loadAudioData(clip.assetId);
            lengths.set(clip.assetId, data.length / data.sampleRate);
          } catch { /* ignore */ }
        }
      }
      setDuration(projectDuration(store.project, lengths));
    };
    load();
  }, [store.project]);

  useEffect(() => () => { getEngine().dispose(); }, [getEngine]);

  const buildClips = useCallback(async () => {
    const context = new AudioContext();
    const clips = [];
    for (const track of store.project.tracks) {
      const audible = !track.muted && (store.project.tracks.some((t) => t.solo) ? track.solo : true);
      if (!audible) continue;
      for (const clip of track.clips) {
        let data: AudioData;
        try {
          data = await loadAudioData(clip.assetId);
        } catch (e) {
          setError(`Missing audio for ${clip.name}: ${(e as Error).message}`);
          continue;
        }
        // If vocal processing is ON and separation exists, use processed path
        if (track.vocal.enabled && track.vocal.status === 'ready' && track.vocal.vocalAssetId) {
          try {
            const vocal = await loadAudioData(track.vocal.vocalAssetId);
            const instrumental = track.vocal.instrumentalAssetId ? await loadAudioData(track.vocal.instrumentalAssetId) : null;
            data = processVoiceOnly(data, vocal, instrumental, {
              enabled: true, semitones: track.vocal.pitchSemis, preserveTempo: track.vocal.preserveTempo,
              vocalVolume: track.vocal.vocalVolume, mixWithAccompaniment: track.vocal.mixWithAccompaniment,
            });
          } catch (e) {
            setError((e as Error).message);
          }
        } else if (track.pitchSemis !== 0) {
          data = pitchShift(data, track.pitchSemis);
        }
        for (const effect of clip.effects) {
          if (!effect.enabled) continue;
          const { applyRangeEffect } = await import('../audio/dsp');
          data = applyRangeEffect(data, effect).data;
        }
        const buffer = await audioDataToAudioBuffer(context, data);
        clips.push({
          id: clip.id, buffer, start: clip.start, sourceStart: clip.sourceStart, duration: clip.duration, gain: track.volume * clip.gain,
        });
      }
    }
    return { clips, context, duration };
  }, [store.project]);

  const handlePlay = useCallback(async () => {
    setError('');
    try {
      const { clips, context, duration: d } = await buildClips();
      if (!clips.length) { setError('No audible tracks to play'); await context.close(); return; }
      const engine = getEngine();
      // Close the temporary context after buffers are created; engine uses its own context but buffers are transferable
      await context.close();
      await engine.play(clips as unknown as import('../audio/engine').ScheduledClip[], position, d, {
        onPosition: setPosition,
        onEnded: () => { setPlaying(false); setPaused(false); setPosition(d); },
      });
      setPlaying(true);
      setPaused(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [buildClips, getEngine, position]);

  const handlePause = useCallback(() => {
    const p = getEngine().pause();
    setPosition(p);
    setPlaying(false);
    setPaused(true);
  }, [getEngine]);

  const handleStop = useCallback(() => {
    getEngine().stop();
    setPlaying(false);
    setPaused(false);
    setPosition(0);
  }, [getEngine]);

  const handleSeek = useCallback(async (t: number) => {
    setPosition(t);
    await getEngine().seek(t);
  }, [getEngine]);

  const handleSkip = useCallback(async (delta: number) => {
    const t = await getEngine().skip(delta, store.settings.skipSeconds);
    setPosition(t);
  }, [getEngine, store.settings.skipSeconds]);

  const handleRestart = useCallback(async () => {
    await getEngine().restart();
    setPosition(0);
    setPlaying(true);
  }, [getEngine]);

  const handleSeparate = useCallback(async () => {
    if (!selectedTrack || !selectedTrack.clips.length) { setError('Select a track with audio to separate'); return; }
    setSeparating(true);
    setError('');
    store.setVocalState(selectedTrack.id, { status: 'processing', error: undefined });
    try {
      // Prefer server if configured
      if (store.settings.separationApiUrl) {
        const clip = selectedTrack.clips[0];
        const data = await loadAudioData(clip.assetId);
        const { encodeWavBlob } = await import('../audio/wav');
        const blob = encodeWavBlob(data, { bitDepth: 16, channels: data.channels.length >= 2 ? 2 : 1 });
        const form = new FormData();
        form.append('file', blob, 'track.wav');
        const response = await fetch(`${store.settings.separationApiUrl.replace(/\/$/, '')}/separate`, { method: 'POST', body: form });
        if (!response.ok) throw new Error(`Separation server error: ${response.status} ${await response.text()}`);
        const result = await response.json() as { vocalUrl: string; instrumentalUrl: string; quality?: number };
        // Fetch stems and store
        const fetchStem = async (url: string) => {
          const r = await fetch(url);
          const b = await r.blob();
          const ctx = new AudioContext();
          const buf = await ctx.decodeAudioData(await b.arrayBuffer());
          await ctx.close();
          const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => new Float32Array(buf.getChannelData(c)));
          return { channels, sampleRate: buf.sampleRate, length: buf.length } as AudioData;
        };
        const vocal = await fetchStem(result.vocalUrl);
        const instrumental = await fetchStem(result.instrumentalUrl);
        const { storeAudioData, cacheAudioData } = await import('../storage/assets');
        const vocalAsset = await storeAudioData(vocal, `${selectedTrack.name} vocals`, 'processed');
        const instAsset = await storeAudioData(instrumental, `${selectedTrack.name} instrumental`, 'processed');
        cacheAudioData(vocalAsset.id, vocal);
        cacheAudioData(instAsset.id, instrumental);
        store.setVocalState(selectedTrack.id, {
          status: 'ready', method: 'demucs-server', vocalAssetId: vocalAsset.id, instrumentalAssetId: instAsset.id,
          separatedFromAssetId: selectedTrack.clips[0].assetId, quality: result.quality ?? 0.85,
          qualityMessage: 'Separation via Demucs server', error: undefined,
        });
        setSeparating(false);
        return;
      }
      const clip = selectedTrack.clips[0];
      const data = await loadAudioData(clip.assetId);
      const result = separateVocalsLocal(data, (p, m) => { setProgress(p); setMessage(m); });
      const { storeAudioData, cacheAudioData } = await import('../storage/assets');
      const vocalAsset = await storeAudioData(result.vocal, `${selectedTrack.name} vocals (approx)`, 'processed');
      const instAsset = await storeAudioData(result.instrumental, `${selectedTrack.name} instrumental (approx)`, 'processed');
      cacheAudioData(vocalAsset.id, result.vocal);
      cacheAudioData(instAsset.id, result.instrumental);
      store.setVocalState(selectedTrack.id, {
        status: 'ready', method: 'local-approximate', vocalAssetId: vocalAsset.id, instrumentalAssetId: instAsset.id,
        separatedFromAssetId: clip.assetId, quality: result.quality, qualityMessage: result.message, error: undefined,
      } as Partial<import('../types').VocalState> & { warning?: string } as unknown as Partial<import('../types').VocalState>);
      // Store warning in a separate field via announcement
      if (result.warning) setError(result.warning);
    } catch (e) {
      store.setVocalState(selectedTrack.id, { status: 'failed', error: (e as Error).message });
      setError((e as Error).message);
    } finally {
      setSeparating(false);
      setProgress(0);
      setMessage('');
    }
  }, [selectedTrack, store]);

  const handlePreview = useCallback(async (kind: 'original' | 'vocal' | 'processed') => {
    if (!selectedTrack) return;
    try {
      let data: AudioData;
      if (kind === 'original') {
        data = await loadAudioData(selectedTrack.clips[0].assetId);
      } else if (kind === 'vocal') {
        if (!selectedTrack.vocal.vocalAssetId) throw new Error('No vocal stem available');
        data = await loadAudioData(selectedTrack.vocal.vocalAssetId);
      } else {
        const original = await loadAudioData(selectedTrack.clips[0].assetId);
        const vocal = selectedTrack.vocal.vocalAssetId ? await loadAudioData(selectedTrack.vocal.vocalAssetId) : null;
        const instrumental = selectedTrack.vocal.instrumentalAssetId ? await loadAudioData(selectedTrack.vocal.instrumentalAssetId) : null;
        data = processVoiceOnly(original, vocal, instrumental, {
          enabled: selectedTrack.vocal.enabled, semitones: selectedTrack.vocal.pitchSemis, preserveTempo: selectedTrack.vocal.preserveTempo,
          vocalVolume: selectedTrack.vocal.vocalVolume, mixWithAccompaniment: selectedTrack.vocal.mixWithAccompaniment,
        });
      }
      const context = new AudioContext();
      const buffer = await audioDataToAudioBuffer(context, data);
      await context.close();
      const engine = getEngine();
      await engine.play([{ id: 'preview', buffer, start: 0, sourceStart: 0, duration: buffer.duration, gain: 1 }], 0, buffer.duration, {
        onEnded: () => setPlaying(false),
      });
      setPlaying(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [getEngine, selectedTrack]);

  const handleHarmony = useCallback(async (sourceId: string, targetId: string, semitones: number, vocalsOnly: boolean) => {
    setHarmonyBusy(true);
    setError('');
    try {
      const source = store.project.tracks.find((t) => t.id === sourceId);
      if (!source || !source.clips.length) throw new Error('Source track has no audio');
      let data = await loadAudioData(source.clips[0].assetId);
      if (vocalsOnly) {
        if (!source.vocal.vocalAssetId) throw new Error('No isolated vocals for source track');
        data = await loadAudioData(source.vocal.vocalAssetId);
      }
      const shifted = pitchShift(data, semitones, (p, m) => { setProgress(p); setMessage(m); });
      await store.addHarmony(sourceId, targetId, semitones, shifted);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setHarmonyBusy(false);
      setProgress(0);
      setMessage('');
    }
  }, [store]);

  const handleRangeEffect = useCallback(async (effect: RangeEffect) => {
    const target = selectedTrack ?? store.project.tracks[0];
    if (!target || !target.clips.length) { setError('Select a track with audio'); return; }
    const clip = target.clips[0];
    try {
      const data = await loadAudioData(clip.assetId);
      const { applyRangeEffect } = await import('../audio/dsp');
      const { data: processed } = applyRangeEffect(data, effect);
      const { storeAudioData, cacheAudioData } = await import('../storage/assets');
      const asset = await storeAudioData(processed, `${clip.name} (${effect.type})`, 'processed');
      cacheAudioData(asset.id, processed);
      store.updateProject((p) => {
        const t = p.tracks.find((x) => x.id === target.id);
        const c = t?.clips.find((x) => x.id === clip.id);
        if (c) { c.assetId = asset.id; c.duration = processed.length / processed.sampleRate; }
        return p;
      });
      store.announce(`Applied ${effect.type} to selection`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedTrack, store]);

  return (
    <div className="studio">
      <header className="studio-header">
        <h1>Multitrack Studio</h1>
        <div className="row wrap">
          <button type="button" className="btn" aria-label="Undo" disabled={!store.canUndo} onClick={store.undo}>Undo</button>
          <button type="button" className="btn" aria-label="Redo" disabled={!store.canRedo} onClick={store.redo}>Redo</button>
          <button type="button" className="btn" aria-label="New track" onClick={() => store.addTrack()}>New track</button>
          <button type="button" className="btn" aria-label="Save project" onClick={store.save}>Save project</button>
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

      {error && <div className="error" role="alert">{error}</div>}

      <div className="studio-layout">
        <div className="studio-main">
          <Timeline
            project={store.project} position={position} duration={duration}
            onSeek={handleSeek}
            onSelectTrack={store.selectTrack}
            onSelectClip={(id) => store.updateProject((p) => { p.selectedClipId = id; return p; }, false)}
            onMoveClip={(id, start) => store.updateClip(id, { start })}
            onTrimClip={(id, start, dur) => store.trimClip(id, start, dur)}
            onSplitClip={(id, at) => store.splitClip(id, at)}
            onDeleteClip={store.deleteClip}
          />
          <div className="zoom-row">
            <button type="button" className="btn btn-xs" aria-label="Zoom timeline in" onClick={() => store.setZoom(store.project.zoom * 1.25)}>Zoom in</button>
            <button type="button" className="btn btn-xs" aria-label="Zoom timeline out" onClick={() => store.setZoom(store.project.zoom / 1.25)}>Zoom out</button>
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
                    onPitch={(s, c) => store.setTrackPitch(selectedTrack.id, s, c)}
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
                    busy={separating} progress={progress} message={message}
                  />
                </>
              )}
              <HarmonyPanel tracks={store.project.tracks} onCreate={handleHarmony} busy={harmonyBusy} />
              <RangeEffectsPanel duration={duration} selection={store.project.selection} onSelection={store.setSelection} onApply={handleRangeEffect} busy={false} />
            </>
          )}
          {activeTab === 'record' && <RecordPanel store={store} />}
          {activeTab === 'silence' && <SilencePanel store={store} />}
          {activeTab === 'merge' && <MergePanel store={store} />}
        </aside>
      </div>

      {showExport && <ExportDialog store={store} onClose={() => setShowExport(false)} />}
    </div>
  );
}

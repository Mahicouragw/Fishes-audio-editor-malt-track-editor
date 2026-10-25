import { useState } from 'react';
import { mergeAudio } from '../audio/dsp';
import type { ProjectStore } from '../store/projectStore';
import { loadAudioData, storeAudioData, cacheAudioData } from '../storage/assets';

export function MergePanel({ store }: { store: ProjectStore }) {
  const [mode, setMode] = useState<'sequential' | 'timeline'>('sequential');
  const [gap, setGap] = useState(0);
  const [overlap, setOverlap] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [order, setOrder] = useState<string[]>(() => store.project.tracks.flatMap((t) => t.clips.map((c) => c.id)));

  const move = (id: string, delta: number) => {
    const index = order.indexOf(id);
    const next = [...order];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  };

  const doMerge = async () => {
    setError('');
    setBusy(true);
    try {
      const allClips = store.project.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
      const ordered = order.map((id) => allClips.find((x) => x.clip.id === id)).filter(Boolean) as typeof allClips;
      if (ordered.length < 2) throw new Error('Import at least two clips to merge');
      const datas = await Promise.all(ordered.map(async ({ clip }) => loadAudioData(clip.assetId)));
      const sampleRate = Math.max(...datas.map((d) => d.sampleRate));
      const merged = mergeAudio(datas, sampleRate, { gapSeconds: gap, overlapSeconds: overlap, mode, timelineStarts: mode === 'timeline' ? ordered.map(({ clip }) => clip.start) : undefined });
      const asset = await storeAudioData(merged, `Merge ${new Date().toLocaleTimeString()}`, 'processed');
      cacheAudioData(asset.id, merged);
      store.updateProject((p) => {
        // Create a new track for the merged result
        const id = `track-${Date.now()}`;
        p.tracks.push({ id, name: `Merge ${p.tracks.length + 1}`, volume: 1, muted: false, solo: false, pitchSemis: 0, pitchFineCents: 0, clips: [{ id: `clip-${Date.now()}`, assetId: asset.id, name: 'Merged audio', start: 0, sourceStart: 0, duration: merged.length / merged.sampleRate, gain: 1, fadeIn: 0, fadeOut: 0, effects: [] }], vocal: { enabled: false, status: 'not-run', method: 'none', quality: 0, qualityMessage: 'Vocal separation has not been run for this track.', pitchSemis: 0, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true } });
        p.media.push({ assetId: asset.id, name: 'Merged audio', mime: asset.mime, size: asset.size, kind: 'processed', createdAt: Date.now() });
        return p;
      });
      store.announce('Audio merged');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clips = store.project.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));

  return (
    <section className="panel" aria-label="Merge audio">
      <h3 className="panel-title">Merge Audio</h3>
      <label className="field">
        <span>Mode</span>
        <select value={mode} aria-label="Merge mode" onChange={(e) => setMode(e.target.value as 'sequential' | 'timeline')}>
          <option value="sequential">Sequential (arrange order)</option>
          <option value="timeline">Timeline mixing (use current positions)</option>
        </select>
      </label>
      <label className="field">
        <span>Gap between files: {gap.toFixed(2)}s</span>
        <input type="range" min={0} max={3} step={0.05} value={gap} aria-label={`Gap ${gap} seconds`} onChange={(e) => setGap(Number(e.target.value))} />
      </label>
      <label className="field">
        <span>Overlap: {overlap.toFixed(2)}s</span>
        <input type="range" min={0} max={2} step={0.05} value={overlap} aria-label={`Overlap ${overlap} seconds`} onChange={(e) => setOverlap(Number(e.target.value))} />
      </label>
      {mode === 'sequential' && clips.length > 0 && (
        <ol className="merge-order" aria-label="Merge order">
          {order.map((id) => {
            const entry = clips.find((x) => x.clip.id === id);
            if (!entry) return null;
            return (
              <li key={id} className="merge-item">
                <span>{entry.clip.name} ({entry.track.name})</span>
                <span className="row">
                  <button type="button" className="btn btn-xs" aria-label={`Move ${entry.clip.name} up`} onClick={() => move(id, -1)}>Up</button>
                  <button type="button" className="btn btn-xs" aria-label={`Move ${entry.clip.name} down`} onClick={() => move(id, 1)}>Down</button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <button type="button" className="btn btn-primary" aria-label="Merge audio" disabled={busy} onClick={doMerge}>{busy ? 'Merging' : 'Merge and preview'}</button>
      <p className="hint">The merged result is rendered from real PCM samples and appears as a new track you can preview and export.</p>
    </section>
  );
}

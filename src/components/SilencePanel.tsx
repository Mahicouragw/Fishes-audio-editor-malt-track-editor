import { useState } from 'react';
import type { SilenceRegion } from '../audio/dsp';
import { detectSilence, removeRegions } from '../audio/dsp';
import { formatTime } from '../types';
import type { ProjectStore } from '../store/projectStore';
import { loadAudioData, storeAudioData, cacheAudioData } from '../storage/assets';

export function SilencePanel({ store }: { store: ProjectStore }) {
  const [threshold, setThreshold] = useState(-40);
  const [minDuration, setMinDuration] = useState(0.4);
  const [preserve, setPreserve] = useState(120);
  const [regions, setRegions] = useState<SilenceRegion[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [trackId, setTrackId] = useState(store.project.tracks[0]?.id ?? '');

  const analyse = async () => {
    setError('');
    setBusy(true);
    try {
      const track = store.project.tracks.find((t) => t.id === trackId) ?? store.project.tracks[0];
      if (!track || !track.clips.length) throw new Error('Select a track that has audio to analyse.');
      // Analyse first clip for simplicity; multitrack note explained in UI
      const clip = track.clips[0];
      const data = await loadAudioData(clip.assetId);
      const found = detectSilence(data, { thresholdDb: threshold, minDuration, preserveMs: preserve, windowMs: 30 });
      setRegions(found);
      setSelected(new Set(found.map((_, i) => i)));
      store.announce(`Found ${found.length} silent regions`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setError('');
    setBusy(true);
    try {
      const track = store.project.tracks.find((t) => t.id === trackId);
      if (!track || !track.clips.length) throw new Error('No track selected');
      const clip = track.clips[0];
      const data = await loadAudioData(clip.assetId);
      const chosen = regions.filter((_, i) => selected.has(i));
      if (!chosen.length) throw new Error('Select at least one region to remove');
      const cleaned = removeRegions(data, chosen);
      const asset = await storeAudioData(cleaned, `${clip.name} (silence removed)`, 'processed');
      cacheAudioData(asset.id, cleaned);
      store.updateProject((p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        if (!t) return p;
        const c = t.clips.find((x) => x.id === clip.id);
        if (c) { c.assetId = asset.id; c.duration = cleaned.length / cleaned.sampleRate; }
        p.media.push({ assetId: asset.id, name: asset.name, mime: asset.mime, size: asset.size, kind: 'processed', createdAt: Date.now() });
        return p;
      });
      store.announce('Silence removed; original kept for undo');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-label="Remove silence">
      <h3 className="panel-title">Remove Silence</h3>
      <p className="hint">Analyses the real audio signal. Short pauses can be preserved to avoid cutting breaths.</p>
      <label className="field">
        <span>Track</span>
        <select value={trackId} aria-label="Track to analyse for silence" onChange={(e) => setTrackId(e.target.value)}>
          {store.project.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Silence threshold: {threshold} dB</span>
        <input type="range" min={-60} max={-15} step={1} value={threshold} aria-label={`Silence threshold ${threshold} decibels`} onChange={(e) => setThreshold(Number(e.target.value))} />
      </label>
      <label className="field">
        <span>Minimum silence: {minDuration.toFixed(2)}s</span>
        <input type="range" min={0.05} max={2} step={0.05} value={minDuration} aria-label={`Minimum silence duration ${minDuration} seconds`} onChange={(e) => setMinDuration(Number(e.target.value))} />
      </label>
      <label className="field">
        <span>Preserve around speech: {preserve} ms</span>
        <input type="range" min={0} max={400} step={10} value={preserve} aria-label={`Preserve ${preserve} milliseconds around speech`} onChange={(e) => setPreserve(Number(e.target.value))} />
      </label>
      <div className="row">
        <button type="button" className="btn btn-primary" aria-label="Analyse silence" disabled={busy} onClick={analyse}>{busy ? 'Analysing' : 'Preview silent regions'}</button>
        <button type="button" className="btn" aria-label="Remove selected silent regions" disabled={busy || !regions.length} onClick={apply}>Remove selected</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {regions.length > 0 && (
        <ul className="region-list" aria-label="Detected silent regions">
          {regions.map((r, i) => (
            <li key={i}>
              <label className="checkbox">
                <input type="checkbox" checked={selected.has(i)} aria-label={`Silent region ${formatTime(r.start)} to ${formatTime(r.end)}`} onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(i); else next.delete(i);
                  setSelected(next);
                }} />
                <span>{formatTime(r.start)} – {formatTime(r.end)} ({r.duration.toFixed(3)}s, {r.levelDb.toFixed(1)} dB)</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Multitrack projects are processed per track; removing silence from one track independently can desynchronize it — the original is kept so you can undo.</p>
    </section>
  );
}

import { useState } from 'react';
import type { SilenceRegion } from '../audio/dsp';
import { useDsp } from '../audio/useDsp';
import { formatTime } from '../types';
import type { ProjectStore } from '../store/projectStore';
import { loadAudioData, storeAudioData, cacheAudioData } from '../storage/assets';

export function SilencePanel({ store }: { store: ProjectStore }) {
  const [threshold, setThreshold] = useState(-40);
  const [minDuration, setMinDuration] = useState(0.4);
  const [preserve, setPreserve] = useState(120);
  const [regions, setRegions] = useState<SilenceRegion[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [trackId, setTrackId] = useState(store.project.tracks[0]?.id ?? '');
  const [analysedAssetId, setAnalysedAssetId] = useState<string | null>(null);
  const dsp = useDsp();
  const busy = dsp.busy;

  const target = store.project.tracks.find((t) => t.id === trackId) ?? store.project.tracks[0];

  const analyse = async () => {
    setError('');
    if (!target || !target.clips.length) { setError('Select a track that has audio to analyse.'); return; }
    const clip = target.clips[0];
    try {
      const data = await loadAudioData(clip.assetId);
      const outcome = await dsp.run({ kind: 'detectSilence', data, options: { thresholdDb: threshold, minDuration, preserveMs: preserve, windowMs: 30 } });
      const found = (outcome.result as SilenceRegion[]) ?? [];
      setRegions(found);
      setSelected(new Set(found.map((_, i) => i)));
      setAnalysedAssetId(clip.assetId);
      store.announce(`Found ${found.length} silent regions`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const apply = async () => {
    setError('');
    if (!target || !target.clips.length) { setError('No track selected'); return; }
    const clip = target.clips[0];
    if (analysedAssetId !== clip.assetId) {
      // The clip changed since the last analysis — re-analyse so we never cut stale regions.
      setRegions([]);
      setError('The audio changed since the last analysis. Run Preview again.');
      return;
    }
    const chosen = regions.filter((_, i) => selected.has(i));
    if (!chosen.length) { setError('Select at least one region to remove'); return; }
    try {
      const data = await loadAudioData(clip.assetId);
      const outcome = await dsp.run({ kind: 'removeSilence', data, regions: chosen });
      if (!outcome.data) throw new Error('Silence removal produced no audio');

      const asset = await storeAudioData(outcome.data, `${clip.name} (silence removed)`, 'processed');
      cacheAudioData(asset.id, outcome.data);
      store.updateProject((p) => {
        const t = p.tracks.find((x) => x.id === target.id);
        if (!t) return p;
        const c = t.clips.find((x) => x.id === clip.id);
        if (c) { c.assetId = asset.id; c.duration = outcome.data!.length / outcome.data!.sampleRate; }
        p.media.push({ assetId: asset.id, name: asset.name, mime: asset.mime, size: asset.size, kind: 'processed', createdAt: Date.now() });
        return p;
      });
      setRegions([]);
      setSelected(new Set());
      setAnalysedAssetId(null);
      store.announce(`Removed ${chosen.length} silent regions; original kept for undo`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="panel" aria-label="Remove silence">
      <h3 className="panel-title">Remove Silence</h3>
      <p className="hint">Analyses the real audio signal (RMS envelope). Short pauses can be preserved to avoid cutting breaths. Only regions you confirm are removed; the original clip stays available for undo.</p>
      <label className="field">
        <span>Track</span>
        <select value={trackId} aria-label="Track to analyse for silence" onChange={(e) => { setTrackId(e.target.value); setRegions([]); setAnalysedAssetId(null); }}>
  {store.project.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}{t.clips.length ? '' : ' (empty)'}</option>)}
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
        <button type="button" className="btn btn-primary" aria-label="Analyse silence" disabled={busy} onClick={analyse}>{busy ? `Analysing ${Math.round(dsp.progress * 100)}%` : 'Preview silent regions'}</button>
        <button type="button" className="btn" aria-label="Remove selected silent regions" disabled={busy || !regions.length} onClick={apply}>Remove selected</button>
      </div>
  {busy && (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(dsp.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={dsp.message}>
          <div className="progress-bar" style={{ width: `${dsp.progress * 100}%` }} />
          <span aria-live="polite">{dsp.message} {Math.round(dsp.progress * 100)}%</span>
        </div>
      )}
  {error && <div className="error" role="alert">{error}</div>}
  {regions.length > 0 && (
        <ul className="region-list" aria-label={`Detected silent regions, ${selected.size} of ${regions.length} selected`}>
  {regions.map((r, i) => (
            <li key={i}>
              <label className="checkbox">
                <input type="checkbox" checked={selected.has(i)} aria-label={`Silent region ${formatTime(r.start)} to ${formatTime(r.end)}, ${r.duration.toFixed(3)} seconds, ${r.levelDb.toFixed(1)} decibels`} onChange={(e) => {
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
      <p className="hint">In a multitrack project, removing silence from one track shortens only that track — the others keep their timing, so dependent tracks can drift relative to it. Undo restores the original clip.</p>
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useDsp } from '../audio/useDsp';
import { makeTrack, makeClip } from '../store/projectStore';
import type { ProjectStore } from '../store/projectStore';
import { loadAudioData, storeAudioData, cacheAudioData } from '../storage/assets';

export function MergePanel({ store }: { store: ProjectStore }) {
  const [mode, setMode] = useState<'sequential' | 'timeline'>('sequential');
  const [gap, setGap] = useState(0);
  const [overlap, setOverlap] = useState(0);
  const [error, setError] = useState('');
  const dsp = useDsp();
  const busy = dsp.busy;
  const clips = useMemo(
    () => store.project.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t }))),
    [store.project.tracks],
  );
  const [order, setOrder] = useState<string[]>(() => clips.map((x) => x.clip.id));

  // Keep the merge order in sync with the project (new clips appear, deleted
  // ones disappear) without disturbing the user's ordering of the rest.
  useEffect(() => {
    setOrder((prev) => {
      const ids = new Set(clips.map((x) => x.clip.id));
      const kept = prev.filter((id) => ids.has(id));
      const added = clips.map((x) => x.clip.id).filter((id) => !kept.includes(id));
      if (kept.length === prev.length && added.length === 0) return prev;
      return [...kept, ...added];
    });
  }, [clips]);

  const move = (id: string, delta: number) => {
    setOrder((prev) => {
      const index = prev.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const doMerge = async () => {
    setError('');
    const allClips = store.project.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
    const ordered = order.map((id) => allClips.find((x) => x.clip.id === id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    if (ordered.length < 2) { setError('Import at least two clips to merge'); return; }
    try {
      const datas = [];
      for (let i = 0; i < ordered.length; i++) {
        const { clip } = ordered[i];
        const data = await loadAudioData(clip.assetId);
        datas.push(data);
      }
      const sampleRate = Math.max(...datas.map((d) => d.sampleRate));
      const outcome = await dsp.run({
        kind: 'merge',
        datas,
        sampleRate,
        options: { gapSeconds: gap, overlapSeconds: overlap, mode, timelineStarts: mode === 'timeline' ? ordered.map(({ clip }) => clip.start) : undefined },
      });
      if (!outcome.data) throw new Error('Merge produced no audio');
      const merged = outcome.data;
      const asset = await storeAudioData(merged, `Merge ${new Date().toLocaleTimeString()}`, 'processed');
      cacheAudioData(asset.id, merged);
      const track = makeTrack(`Merge ${store.project.tracks.length + 1}`);
      const clip = makeClip(asset.id, 'Merged audio', 0, merged.length / merged.sampleRate);
      track.clips.push(clip);
      store.updateProject((p) => {
        p.tracks.push(track);
        p.media.push({ assetId: asset.id, name: 'Merged audio', mime: asset.mime, size: asset.size, kind: 'processed', createdAt: Date.now() });
        return p;
      });
      store.announce('Audio merged into a new track');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="panel" aria-label="Merge audio">
      <h3 className="panel-title">Merge Audio</h3>
      <label className="field">
        <span>Mode</span>
        <select value={mode} aria-label="Merge mode" onChange={(e) => setMode(e.target.value as 'sequential' | 'timeline')}>
          <option value="sequential">Sequential (arrange order below)</option>
          <option value="timeline">Timeline mixing (use current track positions, gaps and overlaps)</option>
        </select>
      </label>
      {mode === 'sequential' && (
        <>
          <label className="field">
            <span>Gap between files: {gap.toFixed(2)}s</span>
            <input type="range" min={0} max={3} step={0.05} value={gap} aria-label={`Gap between files ${gap} seconds`} onChange={(e) => setGap(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Overlap (crossfade sum): {overlap.toFixed(2)}s</span>
            <input type="range" min={0} max={2} step={0.05} value={overlap} aria-label={`Overlap ${overlap} seconds`} onChange={(e) => setOverlap(Number(e.target.value))} />
          </label>
          {clips.length > 0 && (
            <ol className="merge-order" aria-label={`Merge order, ${order.length} clips`}>
              {order.map((id, index) => {
                const entry = clips.find((x) => x.clip.id === id);
                if (!entry) return null;
                return (
                  <li key={id} className="merge-item">
                    <span>{index + 1}. {entry.clip.name} ({entry.track.name})</span>
                    <span className="row">
                      <button type="button" className="btn btn-xs" aria-label={`Move ${entry.clip.name} up in merge order`} onClick={() => move(id, -1)} disabled={index === 0}>Up</button>
                      <button type="button" className="btn btn-xs" aria-label={`Move ${entry.clip.name} down in merge order`} onClick={() => move(id, 1)} disabled={index === order.length - 1}>Down</button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
      {busy && (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(dsp.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={dsp.message}>
          <div className="progress-bar" style={{ width: `${dsp.progress * 100}%` }} />
          <span>{dsp.message} {Math.round(dsp.progress * 100)}%</span>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <button type="button" className="btn btn-primary" aria-label="Merge audio" disabled={busy || clips.length < 2} onClick={doMerge}>
        {busy ? `Merging ${Math.round(dsp.progress * 100)}%` : 'Merge and preview'}
      </button>
      <p className="hint">The merged result is rendered from real PCM samples (sample-accurate concatenation or timeline summing) and appears as a new track you can preview, adjust and export.</p>
    </section>
  );
}

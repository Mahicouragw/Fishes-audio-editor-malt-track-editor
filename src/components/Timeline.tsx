import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../types';
import { formatTime } from '../types';
import { loadAudioData } from '../storage/assets';

function Waveform({ assetId, height = 48 }: { assetId: string; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const clientWidth = canvas.clientWidth;
    if (clientWidth <= 0) return;
    void (async () => {
      try {
        const data = await loadAudioData(assetId);
        if (!canvasRef.current) return;
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(canvasRef.current.clientWidth * dpr));
        const h = Math.max(1, Math.round(height * dpr));
        canvasRef.current.width = width;
        canvasRef.current.height = h;
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, h);
        const channel = data.channels[0];
        if (!channel || !channel.length) return;
        const mid = h / 2;
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = Math.max(1, dpr);
        ctx.beginPath();
        const step = Math.max(1, Math.floor(channel.length / width));
        for (let x = 0; x < width; x++) {
          const start = Math.floor((x / width) * channel.length);
          let min = 1;
          let max = -1;
          for (let i = start; i < Math.min(channel.length, start + step); i++) {
            const v = channel[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          const y1 = mid + min * mid * 0.9;
          const y2 = mid + max * mid * 0.9;
          ctx.moveTo(x, y1);
          ctx.lineTo(x, y2);
        }
        ctx.stroke();
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [assetId, height]);

  useEffect(() => {
    setError('');
    draw();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  if (error) return <div className="waveform-error" role="alert">Waveform: {error}</div>;
  return <canvas ref={canvasRef} className="waveform" style={{ height }} aria-hidden="true" />;
}

export function Timeline({
  project, position, duration, onSeek, onSelectTrack, onSelectClip, onSelection, onSelectionEnd,
  onMoveClip, onTrimClip, onSplitClip, onDeleteClip,
}: {
  project: Project; position: number; duration: number;
  onSeek: (t: number) => void;
  onSelectTrack: (id: string) => void;
  onSelectClip: (id: string | null) => void;
  onSelection: (s: { start: number; end: number } | null) => void;
  onSelectionEnd: (s: { start: number; end: number } | null) => void;
  onMoveClip: (clipId: string, start: number) => void;
  onTrimClip: (clipId: string, start: number, duration: number) => void;
  onSplitClip: (clipId: string, at: number) => void;
  onDeleteClip: (clipId: string) => void;
}) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: 'seek' | 'select'; anchor: number } | null>(null);
  const pixelsPerSecond = Math.max(4, 80 * project.zoom);
  const width = Math.max(600, duration * pixelsPerSecond + 200);

  const timeAtX = useCallback((clientX: number): number => {
    const ruler = rulerRef.current;
    if (!ruler) return 0;
    const rect = ruler.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pixelsPerSecond);
  }, [pixelsPerSecond]);

  const handleRulerPointerDown = (e: React.PointerEvent) => {
    const t = timeAtX(e.clientX);
    if (e.shiftKey) {
      dragRef.current = { mode: 'select', anchor: t };
      onSelection({ start: t, end: t });
    } else {
      dragRef.current = { mode: 'seek', anchor: t };
      onSeek(t);
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleRulerPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const t = timeAtX(e.clientX);
    if (drag.mode === 'seek') onSeek(t);
    else onSelection({ start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) });
  };

  const handleRulerPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (drag?.mode === 'select') {
      const t = timeAtX(e.clientX);
      const selection = { start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) };
      if (selection.end - selection.start < 0.01) {
        onSelection(null);
        onSelectionEnd(null);
      } else {
        onSelection(selection);
        onSelectionEnd(selection);
      }
    }
  };

  const handleRulerKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = (e.key === 'ArrowLeft' ? -1 : 1) * step;
      if (e.shiftKey) {
        // Extend (or start) a selection from the current cursor.
        const base = project.selection ? (delta < 0 ? project.selection.start : project.selection.end) : position;
        const next = Math.max(0, base + delta);
        onSelection({ start: Math.min(base, next), end: Math.max(base, next) });
      } else {
        onSeek(Math.max(0, position + delta));
      }
    } else if (e.key === 'Escape') {
      onSelection(null);
      onSelectionEnd(null);
    }
  };

  return (
    <div className="timeline" role="region" aria-label="Multitrack timeline">
      <div
        ref={rulerRef}
        className="timeline-ruler"
        style={{ width }}
        role="slider"
        tabIndex={0}
        aria-label="Timeline position and range selection. Arrow keys seek, Shift plus arrows selects a range, Escape clears the selection."
        aria-valuemin={0}
        aria-valuemax={Math.max(0.001, duration)}
        aria-valuenow={Number(position.toFixed(3))}
        aria-valuetext={project.selection
          ? `Selection ${formatTime(project.selection.start)} to ${formatTime(project.selection.end)}; cursor ${formatTime(position)}`
          : formatTime(position)}
        onPointerDown={handleRulerPointerDown}
        onPointerMove={handleRulerPointerMove}
        onPointerUp={handleRulerPointerUp}
        onKeyDown={handleRulerKeyDown}
      >
        {Array.from({ length: Math.min(240, Math.ceil(duration) + 1) }, (_, i) => (
          <span key={i} className="ruler-mark" style={{ left: i * pixelsPerSecond }}>{formatTime(i)}</span>
        ))}
        {project.selection && (
          <div
            className="selection-range selection-ruler"
            style={{ left: project.selection.start * pixelsPerSecond, width: (project.selection.end - project.selection.start) * pixelsPerSecond }}
            aria-hidden="true"
          />
        )}
        <div className="playhead" style={{ left: position * pixelsPerSecond }} aria-hidden="true" />
      </div>
      <div className="timeline-tracks" role="list" aria-label="Tracks">
        {project.tracks.map((track) => {
          const isSelected = project.selectedTrackId === track.id;
          const isAudible = !track.muted && (project.tracks.some((t) => t.solo) ? track.solo : true);
          return (
            <div
              key={track.id}
              role="listitem"
              className={`track-row ${isSelected ? 'selected' : ''} ${isAudible ? '' : 'muted'}`}
              aria-label={`${track.name}${isSelected ? ', selected' : ''}${track.muted ? ', muted' : ''}${track.solo ? ', solo' : ''}`}
            >
              <button
                type="button"
                className="track-label"
                aria-label={`Select ${track.name}`}
                aria-pressed={isSelected}
                onClick={() => onSelectTrack(track.id)}
              >
                <span className="track-name">{track.name}</span>
                <span className="track-meta">{track.pitchSemis !== 0 || track.pitchFineCents !== 0 ? `Pitch ${track.pitchSemis >= 0 ? '+' : ''}${track.pitchSemis}${track.pitchFineCents ? `.${track.pitchFineCents}` : ''}` : 'Original pitch'} · Vol {Math.round(track.volume * 100)}% · {track.clips.length} clip{track.clips.length === 1 ? '' : 's'}</span>
              </button>
              <div className="track-lane" style={{ width }} onClick={(e) => e.stopPropagation()}>
                {track.clips.map((clip) => {
                  const left = clip.start * pixelsPerSecond;
                  const w = Math.max(40, clip.duration * pixelsPerSecond);
                  const selected = project.selectedClipId === clip.id;
                  return (
                    <div
                      key={clip.id}
                      className={`clip ${selected ? 'clip-selected' : ''}`}
                      style={{ left, width: w }}
                      role="button"
                      tabIndex={0}
                      aria-label={`${clip.name}, starts at ${formatTime(clip.start)}, duration ${formatTime(clip.duration)}${selected ? ', selected' : ''}`}
                      aria-pressed={selected}
                      onClick={(e) => { e.stopPropagation(); onSelectClip(clip.id); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onDeleteClip(clip.id); }
                        if (e.key === 'Enter') { e.preventDefault(); onSelectClip(clip.id); }
                      }}
                    >
                      <Waveform assetId={clip.assetId} height={44} />
                      <span className="clip-name">{clip.name}</span>
                      <span className="clip-actions">
                        <button type="button" className="btn btn-xs" aria-label={`Move ${clip.name} earlier by 100 milliseconds`} onClick={(e) => { e.stopPropagation(); onMoveClip(clip.id, Math.max(0, clip.start - 0.1)); }}>-0.1s</button>
                        <button type="button" className="btn btn-xs" aria-label={`Move ${clip.name} later by 100 milliseconds`} onClick={(e) => { e.stopPropagation(); onMoveClip(clip.id, clip.start + 0.1); }}>+0.1s</button>
                        <button type="button" className="btn btn-xs" aria-label={`Split ${clip.name} at playhead`} onClick={(e) => { e.stopPropagation(); onSplitClip(clip.id, position); }}>Split</button>
                        <button type="button" className="btn btn-xs btn-danger" aria-label={`Delete ${clip.name}`} onClick={(e) => { e.stopPropagation(); onDeleteClip(clip.id); }}>Delete</button>
                      </span>
                      <label className="clip-field">
                        <span>Start (s, ms precision)</span>
                        <input
                          type="number" step={0.001} min={0} value={Number(clip.start.toFixed(3))}
                          aria-label={`${clip.name} start time in seconds, 0.001 equals one millisecond`}
                          onChange={(e) => onMoveClip(clip.id, Math.max(0, Number(e.target.value) || 0))}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </label>
                      <label className="clip-field">
                        <span>Duration (s)</span>
                        <input
                          type="number" step={0.001} min={0.01} value={Number(clip.duration.toFixed(3))}
                          aria-label={`${clip.name} duration in seconds`}
                          onChange={(e) => onTrimClip(clip.id, clip.start, Math.max(0.01, Number(e.target.value) || clip.duration))}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </label>
                    </div>
                  );
                })}
                {duration > 0 && <div className="playhead-line" style={{ left: position * pixelsPerSecond }} aria-hidden="true" />}
                {project.selection && (
                  <div
                    className="selection-range"
                    style={{ left: project.selection.start * pixelsPerSecond, width: (project.selection.end - project.selection.start) * pixelsPerSecond }}
                    aria-hidden="true"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

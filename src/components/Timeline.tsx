import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../types';
import { formatTime } from '../types';
import { loadAudioData } from '../storage/assets';

function Waveform({ assetId, height = 48 }: { assetId: string; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadAudioData(assetId);
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth * dpr;
        const h = height * dpr;
        canvas.width = width;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, h);
        const channel = data.channels[0];
        const step = Math.max(1, Math.floor(channel.length / width));
        const mid = h / 2;
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
          const start = Math.floor((x / width) * channel.length);
          let min = 1, max = -1;
          for (let i = start; i < start + step && i < channel.length; i++) {
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
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [assetId, height]);
  if (error) return <div className="waveform-error" role="alert">{error}</div>;
  return <canvas ref={canvasRef} className="waveform" style={{ height }} aria-hidden="true" />;
}

export function Timeline({
  project, position, duration, onSeek, onSelectTrack, onSelectClip, onMoveClip, onTrimClip, onSplitClip, onDeleteClip,
}: {
  project: Project; position: number; duration: number;
  onSeek: (t: number) => void;
  onSelectTrack: (id: string) => void;
  onSelectClip: (id: string | null) => void;
  onMoveClip: (clipId: string, start: number) => void;
  onTrimClip: (clipId: string, start: number, duration: number) => void;
  onSplitClip: (clipId: string, at: number) => void;
  onDeleteClip: (clipId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pixelsPerSecond = useMemo(() => 80 * project.zoom, [project.zoom]);
  const width = Math.max(600, duration * pixelsPerSecond + 200);

  const handleTimelineClick = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + containerRef.current.scrollLeft;
    onSeek(x / pixelsPerSecond);
  };

  return (
    <div className="timeline" role="region" aria-label="Multitrack timeline">
      <div className="timeline-ruler" style={{ width }} aria-hidden="true">
        {Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => (
          <span key={i} className="ruler-mark" style={{ left: i * pixelsPerSecond }}>{formatTime(i)}</span>
        ))}
        <div className="playhead" style={{ left: position * pixelsPerSecond }} aria-hidden="true" />
      </div>
      <div
        ref={containerRef}
        className="timeline-tracks"
        onClick={handleTimelineClick}
        role="list"
        aria-label="Tracks"
      >
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
                onClick={(e) => { e.stopPropagation(); onSelectTrack(track.id); }}
              >
                <span className="track-name">{track.name}</span>
                <span className="track-meta">{track.pitchSemis !== 0 ? `Pitch ${track.pitchSemis >= 0 ? '+' : ''}${track.pitchSemis}` : 'Original pitch'} · Vol {Math.round(track.volume * 100)}%</span>
              </button>
              <div className="track-lane" style={{ width }} onClick={(e) => e.stopPropagation()}>
                {track.clips.map((clip) => {
                  const left = clip.start * pixelsPerSecond;
                  const w = clip.duration * pixelsPerSecond;
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
                        if (e.key === 'Delete' || e.key === 'Backspace') onDeleteClip(clip.id);
                        if (e.key === 'Enter') onSelectClip(clip.id);
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
                        <span>Start (seconds)</span>
                        <input
                          type="number" step={0.001} value={clip.start.toFixed(3)}
                          aria-label={`${clip.name} start time in seconds`}
                          onChange={(e) => onMoveClip(clip.id, Number(e.target.value) || 0)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </label>
                      <label className="clip-field">
                        <span>Duration (seconds)</span>
                        <input
                          type="number" step={0.001} value={clip.duration.toFixed(3)}
                          aria-label={`${clip.name} duration in seconds`}
                          onChange={(e) => onTrimClip(clip.id, clip.start, Number(e.target.value) || clip.duration)}
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
                    aria-label={`Selection from ${formatTime(project.selection.start)} to ${formatTime(project.selection.end)}`}
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

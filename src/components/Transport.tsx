import { Pause, Play, SkipBack, SkipForward, Square, RotateCcw } from 'lucide-react';
import { formatTime } from '../types';

export function Transport({
  position, duration, playing, paused, skipSeconds,
  onPlay, onPause, onStop, onSkipBack, onSkipForward, onSeek, onRestart,
}: {
  position: number; duration: number; playing: boolean; paused: boolean; skipSeconds: number;
  onPlay: () => void; onPause: () => void; onStop: () => void; onSkipBack: () => void; onSkipForward: () => void;
  onSeek: (v: number) => void; onRestart: () => void;
}) {
  return (
    <section className="transport" aria-label="Transport">
      <div className="transport-time" aria-live="off">
        <span className="time-current" aria-label={`Current time ${formatTime(position)}`}>{formatTime(position)}</span>
        <span aria-hidden="true"> / </span>
        <span className="time-total" aria-label={`Total duration ${formatTime(duration)}`}>{formatTime(duration)}</span>
      </div>
      <div className="transport-controls">
        <button type="button" className="btn btn-icon" aria-label="Restart playback" onClick={onRestart}><RotateCcw size={18} aria-hidden="true" /></button>
        <button type="button" className="btn btn-icon" aria-label={`Skip backward ${skipSeconds} seconds`} onClick={onSkipBack}><SkipBack size={20} aria-hidden="true" /></button>
        {/* One button, three states: Play → Pause → Resume. The accessible
            name always says what pressing it will do. */}
        {!playing ? (
          <button type="button" className="btn btn-primary btn-play" aria-label={paused ? 'Resume playback' : 'Play'} onClick={onPlay}>
            <Play size={22} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-play" aria-label="Pause playback" onClick={onPause}>
            <Pause size={22} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="btn btn-icon" aria-label={`Skip forward ${skipSeconds} seconds`} onClick={onSkipForward}><SkipForward size={20} aria-hidden="true" /></button>
        <button type="button" className="btn btn-icon" aria-label="Stop" onClick={onStop}><Square size={18} aria-hidden="true" /></button>
      </div>
      <label className="transport-seek">
        <span className="sr-only">Seek position</span>
        <input
          type="range" min={0} max={Math.max(duration, 0.001)} step={0.01} value={Math.min(position, duration)}
          aria-label="Seek" aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      </label>
    </section>
  );
}

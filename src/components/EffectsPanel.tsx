import { useState } from 'react';
import type { RangeEffect, Track } from '../types';
import { formatTime, parseTime, makeId } from '../types';

export function TrackControls({ track, onPitch, onVolume, onMute, onSolo, onRename, onDuplicate, onDelete }: {
  track: Track;
  onPitch: (semis: number, cents: number) => void;
  onVolume: (v: number) => void;
  onMute: () => void; onSolo: () => void; onRename: (n: string) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const [name, setName] = useState(track.name);
  return (
    <section className="panel" aria-label={`${track.name} controls`}>
      <h3 className="panel-title">{track.name}</h3>
      <label className="field">
        <span>Track name</span>
        <input type="text" value={name} aria-label={`${track.name} name`} onChange={(e) => setName(e.target.value)} onBlur={() => onRename(name)} />
      </label>
      <div className="row">
        <button type="button" className={`btn ${track.muted ? 'btn-active' : ''}`} aria-pressed={track.muted} aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`} onClick={onMute}>{track.muted ? 'Unmute' : 'Mute'}</button>
        <button type="button" className={`btn ${track.solo ? 'btn-active' : ''}`} aria-pressed={track.solo} aria-label={`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`} onClick={onSolo}>Solo</button>
        <button type="button" className="btn" aria-label={`Duplicate ${track.name}`} onClick={onDuplicate}>Duplicate</button>
        <button type="button" className="btn btn-danger" aria-label={`Delete ${track.name}`} onClick={onDelete}>Delete</button>
      </div>
      <label className="field">
        <span>Volume: {Math.round(track.volume * 100)}%</span>
        <input type="range" min={0} max={2} step={0.01} value={track.volume} aria-label={`${track.name} volume`} onChange={(e) => onVolume(Number(e.target.value))} />
      </label>
      <div className="field">
        <span>Pitch: {track.pitchSemis >= 0 ? `+${track.pitchSemis}` : track.pitchSemis} semitones {track.pitchFineCents ? `${track.pitchFineCents}¢` : ''}</span>
        <div className="row">
          <button type="button" className="btn" aria-label={`Decrease pitch of ${track.name}`} onClick={() => onPitch(track.pitchSemis - 1, track.pitchFineCents)}>-1</button>
          <input
            type="range" min={-12} max={12} step={1} value={track.pitchSemis}
            aria-label={`${track.name} pitch, ${track.pitchSemis} semitones`}
            onChange={(e) => onPitch(Number(e.target.value), track.pitchFineCents)}
          />
          <button type="button" className="btn" aria-label={`Increase pitch of ${track.name}`} onClick={() => onPitch(track.pitchSemis + 1, track.pitchFineCents)}>+1</button>
          <button type="button" className="btn" aria-label={`Reset pitch of ${track.name}`} onClick={() => onPitch(0, 0)}>Reset</button>
        </div>
        <label className="field">
          <span>Fine tuning (cents)</span>
          <input type="range" min={-50} max={50} step={1} value={track.pitchFineCents} aria-label={`${track.name} fine tuning`} onChange={(e) => onPitch(track.pitchSemis, Number(e.target.value))} />
        </label>
      </div>
    </section>
  );
}

export function VocalPanel({ track, onToggle, onPitch, onPreserve, onVocalVolume, onMix, onSeparate, onPreview, busy, progress, message }: {
  track: Track;
  onToggle: (v: boolean) => void; onPitch: (s: number) => void; onPreserve: (v: boolean) => void; onVocalVolume: (v: number) => void; onMix: (v: boolean) => void;
  onSeparate: () => void; onPreview: (kind: 'original' | 'vocal' | 'processed') => void;
  busy: boolean; progress: number; message: string;
}) {
  const v = track.vocal;
  return (
    <section className="panel" aria-label="Human voice processing">
      <h3 className="panel-title">Human Voice Processing</h3>
      <button
        type="button" role="switch" aria-checked={v.enabled}
        aria-label={`Human Voice Processing, ${v.enabled ? 'on' : 'off'}`}
        className={`switch ${v.enabled ? 'on' : 'off'}`}
        onClick={() => onToggle(!v.enabled)}
      >
        <span className="switch-track"><span className="switch-thumb" /></span>
        <span>{v.enabled ? 'ON' : 'OFF'}</span>
      </button>
      <p className="hint">When ON, pitch and effects apply to the isolated vocal stem only. When OFF, effects apply to the whole track.</p>
      <div className="status">
        <span>Status: {v.status}</span>
        <span>{v.qualityMessage}</span>
        {v.warning && <span className="warning" role="alert">{v.warning}</span>}
        {v.error && <span className="error" role="alert">{v.error}</span>}
        {v.status === 'ready' && <span>Confidence {(v.quality * 100).toFixed(0)}% · Method {v.method === 'local-approximate' ? 'local approximate (not a trained model)' : v.method}</span>}
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" aria-label="Run vocal separation" onClick={onSeparate} disabled={busy}>{busy ? `Separating ${Math.round(progress * 100)}%` : 'Run vocal separation'}</button>
        <button type="button" className="btn" aria-label="Preview original track audio" onClick={() => onPreview('original')}>Original vocal preview</button>
        <button type="button" className="btn" aria-label="Preview isolated vocal stem" onClick={() => onPreview('vocal')} disabled={v.status !== 'ready'}>Processed vocal preview</button>
      </div>
      {busy && <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><div className="progress-bar" style={{ width: `${progress * 100}%` }} />{message}</div>}
      <label className="field">
        <span>Vocal pitch: {v.pitchSemis >= 0 ? `+${v.pitchSemis}` : v.pitchSemis}</span>
        <input type="range" min={-12} max={12} step={1} value={v.pitchSemis} aria-label={`Vocal pitch, ${v.pitchSemis} semitones`} onChange={(e) => onPitch(Number(e.target.value))} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={v.preserveTempo} aria-label="Preserve tempo when pitch shifting vocals" onChange={(e) => onPreserve(e.target.checked)} />
        <span>Preserve tempo</span>
      </label>
      <label className="field">
        <span>Vocal volume: {Math.round(v.vocalVolume * 100)}%</span>
        <input type="range" min={0} max={2} step={0.01} value={v.vocalVolume} aria-label="Vocal volume" onChange={(e) => onVocalVolume(Number(e.target.value))} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={v.mixWithAccompaniment} aria-label="Mix processed vocals with original accompaniment" onChange={(e) => onMix(e.target.checked)} />
        <span>Mix processed vocals with original accompaniment</span>
      </label>
      <button type="button" className="btn" aria-label="Restore original audio for this track" onClick={() => { onToggle(false); onPitch(0); }}>Restore original audio</button>
      <p className="hint">Local separation is approximate. Instruments that are centred or harmonic can remain in the vocal stem. For studio quality, connect a Demucs server in Settings.</p>
    </section>
  );
}

export function HarmonyPanel({ tracks, onCreate, busy }: {
  tracks: Track[];
  onCreate: (sourceId: string, targetId: string, semitones: number, vocalsOnly: boolean) => void;
  busy: boolean;
}) {
  const [source, setSource] = useState(tracks[0]?.id ?? '');
  const [target, setTarget] = useState(tracks[1]?.id ?? tracks[0]?.id ?? '');
  const [semis, setSemis] = useState(7);
  const [vocalsOnly, setVocalsOnly] = useState(false);
  const presets = [0, 3, 4, 7, -3, -4, -7, 12, -12];
  return (
    <section className="panel" aria-label="Harmony generator">
      <h3 className="panel-title">Harmony Generator</h3>
      <p className="hint">Each harmony is a real processed audio signal, independently adjustable and muteable.</p>
      <label className="field">
        <span>Source track</span>
        <select value={source} aria-label="Harmony source track" onChange={(e) => setSource(e.target.value)}>
          {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Target track</span>
        <select value={target} aria-label="Harmony target track" onChange={(e) => setTarget(e.target.value)}>
          {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <div className="field">
        <span>Semitone offset: {semis >= 0 ? `+${semis}` : semis}</span>
        <div className="row wrap">
          {presets.map((p) => (
            <button key={p} type="button" className={`btn btn-xs ${semis === p ? 'btn-active' : ''}`} aria-pressed={semis === p} aria-label={`Harmony ${p >= 0 ? `plus ${p}` : `minus ${Math.abs(p)}`} semitones`} onClick={() => setSemis(p)}>{p >= 0 ? `+${p}` : p}</button>
          ))}
        </div>
        <input type="range" min={-12} max={12} step={1} value={semis} aria-label={`Harmony semitones, ${semis}`} onChange={(e) => setSemis(Number(e.target.value))} />
        <input type="number" min={-24} max={24} step={1} value={semis} aria-label="Custom harmony semitones" onChange={(e) => setSemis(Number(e.target.value) || 0)} />
      </div>
      <label className="field checkbox">
        <input type="checkbox" checked={vocalsOnly} aria-label="Apply harmonization only to isolated human vocals" onChange={(e) => setVocalsOnly(e.target.checked)} />
        <span>Apply only to isolated vocals</span>
      </label>
      <button type="button" className="btn btn-primary" aria-label={`Create harmony ${semis} semitones`} disabled={busy || !source || !target} onClick={() => onCreate(source, target, semis, vocalsOnly)}>Create harmony layer</button>
    </section>
  );
}

export function RangeEffectsPanel({ duration, selection, onSelection, onApply, busy }: {
  duration: number; selection: { start: number; end: number } | null;
  onSelection: (s: { start: number; end: number } | null) => void;
  onApply: (effect: RangeEffect) => void; busy: boolean;
}) {
  const [start, setStart] = useState(selection?.start ?? 5);
  const [end, setEnd] = useState(selection?.end ?? Math.min(duration, 25));
  const [type, setType] = useState<RangeEffect['type']>('pitch');
  const [semis, setSemis] = useState(4);
  const [gain, setGain] = useState(1);
  const [reverb, setReverb] = useState(1.2);
  const [delay, setDelay] = useState(0.25);
  const [echoMix, setEchoMix] = useState(0.3);
  const [eqLow, setEqLow] = useState(0);
  const [eqMid, setEqMid] = useState(0);
  const [eqHigh, setEqHigh] = useState(0);
  const [threshold, setThreshold] = useState(-40);

  const apply = () => {
    if (start >= end) { alert('Start time must be earlier than end time.'); return; }
    if (start < 0 || end > duration + 0.001) { alert('Selection must be within the track duration.'); return; }
    const effect: RangeEffect = {
      id: makeId('effect'), type, start, end, enabled: true,
      params: {
        semitones: semis, gain, reverbSeconds: reverb, reverbMix: 0.35, echoDelay: delay, echoFeedback: 0.35, echoMix, eqLow, eqMid, eqHigh, noiseThresholdDb: threshold,
      },
    };
    onSelection({ start, end });
    onApply(effect);
  };

  return (
    <section className="panel" aria-label="Time-range effects">
      <h3 className="panel-title">Selected Time-Range Effects</h3>
      <p className="hint">Example: Start 00:05.000 End 00:25.000 — only this range is modified.</p>
      <div className="row">
        <label className="field">
          <span>Start</span>
          <input type="text" value={formatTime(start)} aria-label="Selection start time" onChange={(e) => { const v = parseTime(e.target.value); if (v !== null) setStart(v); }} />
          <input type="number" step={0.001} value={start.toFixed(3)} aria-label="Selection start in seconds" onChange={(e) => setStart(Number(e.target.value) || 0)} />
        </label>
        <label className="field">
          <span>End</span>
          <input type="text" value={formatTime(end)} aria-label="Selection end time" onChange={(e) => { const v = parseTime(e.target.value); if (v !== null) setEnd(v); }} />
          <input type="number" step={0.001} value={end.toFixed(3)} aria-label="Selection end in seconds" onChange={(e) => setEnd(Number(e.target.value) || 0)} />
        </label>
      </div>
      <label className="field">
        <span>Effect</span>
        <select value={type} aria-label="Range effect type" onChange={(e) => setType(e.target.value as RangeEffect['type'])}>
          <option value="pitch">Pitch shift</option>
          <option value="reverb">Reverb</option>
          <option value="echo">Echo / Delay</option>
          <option value="eq">Equalization</option>
          <option value="volume">Volume</option>
          <option value="fadeIn">Fade in</option>
          <option value="fadeOut">Fade out</option>
          <option value="noiseReduction">Noise reduction</option>
        </select>
      </label>
      {type === 'pitch' && (
        <label className="field">
          <span>Semitones: {semis >= 0 ? `+${semis}` : semis}</span>
          <input type="range" min={-12} max={12} step={1} value={semis} aria-label={`Range pitch ${semis} semitones`} onChange={(e) => setSemis(Number(e.target.value))} />
        </label>
      )}
      {type === 'volume' && (
        <label className="field">
          <span>Gain: {gain.toFixed(2)}</span>
          <input type="range" min={0} max={2} step={0.01} value={gain} aria-label="Range volume gain" onChange={(e) => setGain(Number(e.target.value))} />
        </label>
      )}
      {type === 'reverb' && (
        <label className="field">
          <span>Reverb size: {reverb.toFixed(2)}s</span>
          <input type="range" min={0.2} max={3} step={0.1} value={reverb} aria-label="Reverb size" onChange={(e) => setReverb(Number(e.target.value))} />
        </label>
      )}
      {type === 'echo' && (
        <div className="row">
          <label className="field">
            <span>Delay: {delay.toFixed(2)}s</span>
            <input type="range" min={0.05} max={1} step={0.01} value={delay} aria-label="Echo delay" onChange={(e) => setDelay(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Mix: {Math.round(echoMix * 100)}%</span>
            <input type="range" min={0} max={1} step={0.01} value={echoMix} aria-label="Echo mix" onChange={(e) => setEchoMix(Number(e.target.value))} />
          </label>
        </div>
      )}
      {type === 'eq' && (
        <div className="row">
          <label className="field"><span>Low {eqLow}dB</span><input type="range" min={-12} max={12} step={1} value={eqLow} aria-label="EQ low" onChange={(e) => setEqLow(Number(e.target.value))} /></label>
          <label className="field"><span>Mid {eqMid}dB</span><input type="range" min={-12} max={12} step={1} value={eqMid} aria-label="EQ mid" onChange={(e) => setEqMid(Number(e.target.value))} /></label>
          <label className="field"><span>High {eqHigh}dB</span><input type="range" min={-12} max={12} step={1} value={eqHigh} aria-label="EQ high" onChange={(e) => setEqHigh(Number(e.target.value))} /></label>
        </div>
      )}
      {type === 'noiseReduction' && (
        <label className="field"><span>Threshold {threshold} dB</span><input type="range" min={-60} max={-10} step={1} value={threshold} aria-label="Noise reduction threshold" onChange={(e) => setThreshold(Number(e.target.value))} /></label>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary" aria-label="Apply effect to selected range" disabled={busy} onClick={apply}>Apply to Selection</button>
        <button type="button" className="btn" aria-label="Clear selection" onClick={() => onSelection(null)}>Clear</button>
      </div>
    </section>
  );
}

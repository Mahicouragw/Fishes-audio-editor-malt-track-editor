import { useEffect, useState } from 'react';
import type { HarmonyLayer, RangeEffect, Track } from '../types';
import { formatTime, parseTime, makeId } from '../types';
import { describePan } from '../audio/harmony';

export function describeSemis(semis: number): string {
  if (semis === 0) return 'original pitch';
  return `${semis > 0 ? 'plus' : 'minus'} ${Math.abs(semis)} semitones`;
}

export function TrackControls({ track, busy, onPitch, onPreviewPitch, onPreviewOriginal, onVolume, onPan, onMute, onSolo, onRename, onDuplicate, onDuplicateOriginal, onDelete }: {
  track: Track;
  busy: boolean;
  onPitch: (semis: number, cents: number) => void;
  onPreviewPitch: (semis: number) => void;
  onPreviewOriginal: () => void;
  onVolume: (v: number) => void;
  onPan: (pan: number) => void;
  onMute: () => void; onSolo: () => void; onRename: (n: string) => void;
  onDuplicate: () => void; onDuplicateOriginal: () => void; onDelete: () => void;
}) {
  const [name, setName] = useState(track.name);
  const [pendingSemis, setPendingSemis] = useState(track.pitchSemis);
  const [pendingCents, setPendingCents] = useState(track.pitchFineCents);

  // Sync with the store when it changes outside this panel (undo/redo, apply).
  useEffect(() => {
    setPendingSemis(track.pitchSemis);
    setPendingCents(track.pitchFineCents);
  }, [track.pitchSemis, track.pitchFineCents, track.id]);

  const dirty = pendingSemis !== track.pitchSemis || pendingCents !== track.pitchFineCents;

  return (
    <section className="panel" aria-label={`${track.name} controls`}>
      <h3 className="panel-title">Track: {track.name}</h3>
      <label className="field">
        <span>Track name</span>
        <input type="text" value={name} aria-label={`${track.name} name`} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name !== track.name) onRename(name); }} />
      </label>
      <div className="row">
        <button type="button" className={`btn ${track.muted ? 'btn-active' : ''}`} aria-pressed={track.muted} aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`} onClick={onMute}>{track.muted ? 'Unmute' : 'Mute'}</button>
        <button type="button" className={`btn ${track.solo ? 'btn-active' : ''}`} aria-pressed={track.solo} aria-label={`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`} onClick={onSolo}>Solo</button>
        <button type="button" className="btn" aria-label={`Duplicate ${track.name} with its settings`} onClick={onDuplicate}>Duplicate</button>
        <button type="button" className="btn" aria-label={`Duplicate ${track.name} at original pitch without effects`} onClick={onDuplicateOriginal}>Duplicate lead (unprocessed)</button>
        <button type="button" className="btn btn-danger" aria-label={`Delete ${track.name}`} onClick={onDelete}>Delete</button>
      </div>
      <label className="field">
        <span>Volume: {Math.round(track.volume * 100)}%</span>
        <input type="range" min={0} max={2} step={0.01} value={track.volume} aria-label={`${track.name} volume, ${Math.round(track.volume * 100)} percent`} onChange={(e) => onVolume(Number(e.target.value))} />
      </label>
      <fieldset className="field" aria-label={`${track.name} stereo pan`}>
        <legend>Pan: {describePan(track.pan ?? 0)}</legend>
        <div className="row wrap">
          <button type="button" className="btn btn-xs" aria-label={`Pan ${track.name} hard left`} onClick={() => onPan(-1)}>L</button>
          <button type="button" className="btn btn-xs" aria-label={`Centre the pan of ${track.name}`} onClick={() => onPan(0)}>C</button>
          <button type="button" className="btn btn-xs" aria-label={`Pan ${track.name} hard right`} onClick={() => onPan(1)}>R</button>
        </div>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={track.pan ?? 0}
          aria-label={`${track.name} pan, ${describePan(track.pan ?? 0)}`}
          onChange={(e) => onPan(Number(e.target.value))}
        />
        <p className="hint">Real stereo pan (constant power). It is applied in live playback and in the exported file.</p>
      </fieldset>
      <div className="field">
        <span>Pitch (preview, then apply): {describeSemis(pendingSemis)}{pendingCents ? `, ${pendingCents > 0 ? '+' : ''}${pendingCents} cents` : ''}</span>
        <div className="row">
          <button type="button" className="btn" aria-label={`Decrease pitch of ${track.name} by one semitone`} disabled={busy || pendingSemis <= -12} onClick={() => setPendingSemis((s) => Math.max(-12, s - 1))}>-1</button>
          <input
            type="range" min={-12} max={12} step={1} value={pendingSemis}
            aria-label={`${track.name} pitch, ${describeSemis(pendingSemis)}`}
            disabled={busy}
            onChange={(e) => setPendingSemis(Number(e.target.value))}
          />
          <button type="button" className="btn" aria-label={`Increase pitch of ${track.name} by one semitone`} disabled={busy || pendingSemis >= 12} onClick={() => setPendingSemis((s) => Math.min(12, s + 1))}>+1</button>
        </div>
        <label className="field">
          <span>Fine tuning (cents): {pendingCents > 0 ? `+${pendingCents}` : pendingCents}</span>
          <input type="range" min={-50} max={50} step={1} value={pendingCents} aria-label={`${track.name} fine tuning, ${pendingCents} cents`} disabled={busy} onChange={(e) => setPendingCents(Number(e.target.value))} />
        </label>
        <div className="row" aria-live="polite">
          <button type="button" className="btn" aria-label={`Preview ${track.name} at ${describeSemis(pendingSemis)}`} disabled={busy} onClick={() => onPreviewPitch(pendingSemis)}>Preview</button>
          <button type="button" className="btn" aria-label={`Preview ${track.name} at original pitch`} disabled={busy} onClick={onPreviewOriginal}>Preview original</button>
          <button type="button" className="btn btn-primary" aria-label={`Apply pitch ${describeSemis(pendingSemis)} to ${track.name}`} disabled={busy || !dirty} onClick={() => onPitch(pendingSemis, pendingCents)}>Apply</button>
          <button type="button" className="btn" aria-label={`Cancel pitch change on ${track.name}`} disabled={busy || !dirty} onClick={() => { setPendingSemis(track.pitchSemis); setPendingCents(track.pitchFineCents); }}>Cancel</button>
          <button type="button" className="btn" aria-label={`Reset pitch of ${track.name} to original`} disabled={busy || (pendingSemis === 0 && pendingCents === 0)} onClick={() => { setPendingSemis(0); setPendingCents(0); }}>Reset</button>
        </div>
        <p className="hint">Pitch is a real formant-preserving spectral shift: tempo and duration stay identical, and the vocal-tract character is kept. Applied pitch is committed to the track; Undo restores the previous value.</p>
      </div>
    </section>
  );
}

export function VocalPanel({ track, onToggle, onPitch, onVocalVolume, onMix, onSeparate, onPreview, busy, progress, message }: {
  track: Track;
  onToggle: (v: boolean) => void; onPitch: (s: number) => void; onVocalVolume: (v: number) => void; onMix: (v: boolean) => void;
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
        disabled={busy}
        onClick={() => onToggle(!v.enabled)}
      >
        <span className="switch-track"><span className="switch-thumb" /></span>
        <span>{v.enabled ? 'ON' : 'OFF'}</span>
      </button>
      <p className="hint">When ON, pitch applies to the isolated vocal stem only (stems from real separation). When OFF, processing applies to the whole track. The original audio is never modified in place.</p>
      <div className="status">
        <span>Status: {v.status === 'not-run' ? 'not run' : v.status}</span>
        <span>{v.qualityMessage}</span>
        {v.status === 'ready' && <span>Confidence {(v.quality * 100).toFixed(0)}% · Method: {v.method === 'local-approximate' ? 'local approximate (STFT mask, not a trained model)' : 'Demucs server'}</span>}
        {v.warning && <span className="warning" role="status">{v.warning}</span>}
        {v.error && <span className="error" role="alert">{v.error}</span>}
      </div>
      {busy && (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={message}>
          <div className="progress-bar" style={{ width: `${progress * 100}%` }} />
          <span aria-live="polite">{message} {Math.round(progress * 100)}%</span>
        </div>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary" aria-label="Run vocal separation" onClick={onSeparate} disabled={busy}>
          {busy ? `Separating ${Math.round(progress * 100)}%` : 'Run vocal separation'}
        </button>
        <button type="button" className="btn" aria-label="Preview original track audio" onClick={() => onPreview('original')} disabled={busy}>Original</button>
        <button type="button" className="btn" aria-label="Preview isolated vocal stem" onClick={() => onPreview('vocal')} disabled={busy || v.status !== 'ready' || !v.vocalAssetId}>Vocal stem</button>
        <button type="button" className="btn" aria-label="Preview processed vocals mixed with accompaniment" onClick={() => onPreview('processed')} disabled={busy || v.status !== 'ready' || !v.vocalAssetId}>Processed mix</button>
      </div>
      <label className="field">
        <span>Vocal pitch: {describeSemis(v.pitchSemis)}</span>
        <input type="range" min={-12} max={12} step={1} value={v.pitchSemis} aria-label={`Vocal pitch, ${describeSemis(v.pitchSemis)}`} disabled={busy} onChange={(e) => onPitch(Number(e.target.value))} />
      </label>
      {v.enabled && v.status === 'ready' && (
        <p className="hint">
          While Human Voice Processing is ON, this vocal pitch is what you hear: it is applied to the separated vocal
          (tempo preserved) and mixed with the untouched accompaniment. The track pitch above only applies when this is OFF.
        </p>
      )}
      <p className="hint" role="note">
        Tempo and duration are always preserved: pitch is shifted by formant-preserving spectral remapping, never by
        changing playback speed or sample rate.
      </p>
      <label className="field">
        <span>Vocal volume: {Math.round(v.vocalVolume * 100)}%</span>
        <input type="range" min={0} max={2} step={0.01} value={v.vocalVolume} aria-label="Vocal volume, percent" disabled={busy} onChange={(e) => onVocalVolume(Number(e.target.value))} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={v.mixWithAccompaniment} aria-label="Mix processed vocals with original accompaniment" disabled={busy} onChange={(e) => onMix(e.target.checked)} />
        <span>Mix processed vocals with original accompaniment</span>
      </label>
      <button type="button" className="btn" aria-label="Restore original audio for this track" onClick={() => { onToggle(false); onPitch(0); }} disabled={busy}>Restore original audio</button>
      <p className="hint">Local separation is an honest approximation (REPET-style background estimate + stereo-centre + harmonic salience mask). Centred or harmonic instruments can remain in the stem. For studio quality, connect a Demucs server in Settings. This is never presented as an EQ trick.</p>
    </section>
  );
}

function clampInt(v: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, v)));
}

const RANGE_HARMONY_INTERVALS = [0, 3, 4, 7, -3, -4, -7];

export function RangeEffectsPanel({ duration, selection, clipDuration, onSelection, onPreview, onApply, busy, progress, message }: {
  duration: number;
  selection: { start: number; end: number } | null;
  /** Resolves the length (seconds) of the clip this panel would act on. */
  clipDuration: () => Promise<number>;
  onSelection: (s: { start: number; end: number } | null) => void;
  onPreview: (effect: RangeEffect) => void;
  onApply: (effect: RangeEffect) => void;
  busy: boolean;
  progress: number;
  message: string;
}) {
  const [start, setStart] = useState(selection?.start ?? 5);
  const [end, setEnd] = useState(selection?.end ?? Math.min(25, duration || 25));
  const [type, setType] = useState<RangeEffect['type']>('pitch');
  const [semis, setSemis] = useState(4);
  const [intervals, setIntervals] = useState<number[]>([3, 7]);
  const [customInterval, setCustomInterval] = useState('');
  const [harmonyGain, setHarmonyGain] = useState(0.35);
  const [gain, setGain] = useState(1);
  const [reverb, setReverb] = useState(1.2);
  const [reverbMix, setReverbMix] = useState(0.35);
  const [delay, setDelay] = useState(0.25);
  const [echoMix, setEchoMix] = useState(0.3);
  const [eqLow, setEqLow] = useState(0);
  const [eqMid, setEqMid] = useState(0);
  const [eqHigh, setEqHigh] = useState(0);
  const [threshold, setThreshold] = useState(-40);
  const [validation, setValidation] = useState('');

  useEffect(() => {
    if (selection) {
      setStart(selection.start);
      setEnd(selection.end);
      setValidation('');
    }
  }, [selection]);

  const effectFromState = (): RangeEffect => ({
    id: makeId('effect'),
    type,
    start,
    end,
    enabled: true,
    params: {
      semitones: semis,
      intervals: Number.isFinite(Number(customInterval)) && customInterval.trim() !== ''
        ? [...new Set([...intervals, clampInt(Number(customInterval), -24, 24)])]
        : intervals,
      harmonyGain,
      reverbSeconds: reverb,
      reverbMix,
      echoDelay: delay,
      echoFeedback: 0.35,
      echoMix,
      eqLow,
      eqMid,
      eqHigh,
      gain,
      noiseThresholdDb: threshold,
    },
  });

  const validate = async (): Promise<boolean> => {
    if (start >= end) { setValidation('Start time must be earlier than end time.'); return false; }
    if (start < 0 || end < 0) { setValidation('Times must be zero or greater.'); return false; }
    if (end > duration + 0.001) { setValidation(`End time is beyond the project end (${formatTime(duration)}).`); return false; }
    const clipLen = await clipDuration();
    if (clipLen > 0 && (end > clipLen + 0.001 || start >= clipLen)) {
      setValidation(`The selection must fit inside the target clip (0 to ${formatTime(clipLen)}).`);
      return false;
    }
    setValidation('');
    return true;
  };

  const run = async (apply: boolean) => {
    if (busy) return;
    const ok = await validate();
    if (!ok) return;
    const effect = effectFromState();
    onSelection({ start, end });
    if (apply) onApply(effect);
    else onPreview(effect);
  };

  return (
    <section className="panel" aria-label="Time-range effects">
      <h3 className="panel-title">Selected Time-Range Effects</h3>
      <p className="hint">Only the selected range is modified; audio before and after is preserved (wet tails are added, never cut). Example: Start 00:05.000 End 00:25.000.</p>
      <div className="row">
        <label className="field">
          <span>Start</span>
          <input type="text" value={formatTime(start)} aria-label="Selection start time" onChange={(e) => { const v = parseTime(e.target.value); if (v !== null) setStart(v); }} />
          <input type="number" step={0.001} min={0} value={Number(start.toFixed(3))} aria-label="Selection start in seconds (0.001 = 1 millisecond)" onChange={(e) => setStart(Number(e.target.value) || 0)} />
        </label>
        <label className="field">
          <span>End</span>
          <input type="text" value={formatTime(end)} aria-label="Selection end time" onChange={(e) => { const v = parseTime(e.target.value); if (v !== null) setEnd(v); }} />
          <input type="number" step={0.001} min={0} value={Number(end.toFixed(3))} aria-label="Selection end in seconds (0.001 = 1 millisecond)" onChange={(e) => setEnd(Number(e.target.value) || 0)} />
        </label>
      </div>
      <label className="field">
        <span>Effect</span>
        <select value={type} aria-label="Range effect type" onChange={(e) => setType(e.target.value as RangeEffect['type'])}>
          <option value="pitch">Pitch shift</option>
          <option value="harmony">Harmony (layers)</option>
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
          <span>Semitones: {describeSemis(semis)}</span>
          <input type="range" min={-12} max={12} step={1} value={semis} aria-label={`Range pitch, ${describeSemis(semis)}`} onChange={(e) => setSemis(Number(e.target.value))} />
        </label>
      )}
      {type === 'harmony' && (
        <>
          <div className="field">
            <span>Intervals</span>
            <div className="row wrap">
              {RANGE_HARMONY_INTERVALS.map((p) => (
                <button key={p} type="button" className={`btn btn-xs ${intervals.includes(p) ? 'btn-active' : ''}`} aria-pressed={intervals.includes(p)} aria-label={`Interval ${describeSemis(p)}`} onClick={() => setIntervals((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p])}>{p >= 0 ? `+${p}` : p}</button>
              ))}
              <input type="number" min={-24} max={24} step={1} value={customInterval} placeholder="Custom" aria-label="Custom harmony interval in semitones" onChange={(e) => setCustomInterval(e.target.value)} />
            </div>
          </div>
          <label className="field">
            <span>Harmony level: {Math.round(harmonyGain * 100)}%</span>
            <input type="range" min={0} max={1} step={0.05} value={harmonyGain} aria-label="Harmony level" onChange={(e) => setHarmonyGain(Number(e.target.value))} />
          </label>
        </>
      )}
      {type === 'volume' && (
        <label className="field">
          <span>Gain: {gain.toFixed(2)}×</span>
          <input type="range" min={0} max={2} step={0.01} value={gain} aria-label="Range volume gain" onChange={(e) => setGain(Number(e.target.value))} />
        </label>
      )}
      {type === 'reverb' && (
        <div className="row">
          <label className="field">
            <span>Reverb size: {reverb.toFixed(2)}s</span>
            <input type="range" min={0.2} max={3} step={0.1} value={reverb} aria-label="Reverb size in seconds" onChange={(e) => setReverb(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Wet: {Math.round(reverbMix * 100)}%</span>
            <input type="range" min={0} max={1} step={0.05} value={reverbMix} aria-label="Reverb wet mix" onChange={(e) => setReverbMix(Number(e.target.value))} />
          </label>
        </div>
      )}
      {type === 'echo' && (
        <div className="row">
          <label className="field">
            <span>Delay: {delay.toFixed(2)}s</span>
            <input type="range" min={0.05} max={1} step={0.01} value={delay} aria-label="Echo delay in seconds" onChange={(e) => setDelay(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Mix: {Math.round(echoMix * 100)}%</span>
            <input type="range" min={0} max={1} step={0.01} value={echoMix} aria-label="Echo mix" onChange={(e) => setEchoMix(Number(e.target.value))} />
          </label>
        </div>
      )}
      {type === 'eq' && (
        <div className="row">
          <label className="field"><span>Low {eqLow}dB</span><input type="range" min={-12} max={12} step={1} value={eqLow} aria-label="EQ low shelf gain in decibels" onChange={(e) => setEqLow(Number(e.target.value))} /></label>
          <label className="field"><span>Mid {eqMid}dB</span><input type="range" min={-12} max={12} step={1} value={eqMid} aria-label="EQ mid gain in decibels" onChange={(e) => setEqMid(Number(e.target.value))} /></label>
          <label className="field"><span>High {eqHigh}dB</span><input type="range" min={-12} max={12} step={1} value={eqHigh} aria-label="EQ high shelf gain in decibels" onChange={(e) => setEqHigh(Number(e.target.value))} /></label>
        </div>
      )}
      {type === 'noiseReduction' && (
        <label className="field"><span>Threshold {threshold} dB</span><input type="range" min={-60} max={-10} step={1} value={threshold} aria-label="Noise reduction threshold in decibels" onChange={(e) => setThreshold(Number(e.target.value))} /></label>
      )}
      {validation && <div className="error" role="alert">{validation}</div>}
      {busy && (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={message}>
          <div className="progress-bar" style={{ width: `${progress * 100}%` }} />
          <span aria-live="polite">{message} {Math.round(progress * 100)}%</span>
        </div>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary" aria-label="Apply effect to selected range" disabled={busy} onClick={() => run(true)}>Apply to Selection</button>
        <button type="button" className="btn" aria-label="Preview effect on selected range without applying" disabled={busy} onClick={() => run(false)}>Preview</button>
        <button type="button" className="btn" aria-label="Clear selection" onClick={() => onSelection(null)}>Clear</button>
      </div>
    </section>
  );
}

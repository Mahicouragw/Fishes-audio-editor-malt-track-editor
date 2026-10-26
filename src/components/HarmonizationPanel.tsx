import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HarmonyKey, HarmonyLayer, HarmonyRange, HarmonyScale, RangeEffect, Track } from '../types';
import { formatTime, makeId, parseTime } from '../types';
import {
  HARMONY_INTERVAL_PRESETS,
  HARMONY_KEYS,
  HARMONY_PRESET_A,
  HARMONY_PRESET_B,
  HARMONY_PRESET_C,
  HARMONY_PRESETS,
  HARMONY_TRACK_SLOTS,
  activeRanges,
  describeDelay,
  describeInterval,
  describeKeyConflict,
  describePan,
  describeScope,
  nearestInKeyInterval,
  validateHarmonyRange,
  validateHarmonyRanges,
  voicesFromPreset,
  type HarmonyPreset,
  type HarmonyScopeSpec,
  type HarmonyVoiceDraft,
} from '../audio/harmony';

export type HarmonyDraftVoice = HarmonyVoiceDraft;

export interface HarmonyDraft {
  sourceTrackId: string;
  scope: HarmonyScopeSpec;
  voices: HarmonyDraftVoice[];
  vocalsOnly: boolean;
  /** Render a real duplicate of the +0 voice on its own track. */
  separateOriginalTrack: boolean;
  key: HarmonyKey;
  scale: HarmonyScale;
}

export interface HarmonizationPanelProps {
  tracks: Track[];
  harmonies: HarmonyLayer[];
  /** The track the harmonies are generated from. */
  sourceTrackId: string;
  onSourceTrackChange: (trackId: string) => void;
  /** Actual measured duration of the source media, in seconds. */
  mediaDuration: number;
  /** True when the source track has separated vocal stems available. */
  hasVocalStems: boolean;
  onRunSeparation: () => void;
  ranges: HarmonyRange[];
  onAddRange: () => void;
  onUpdateRange: (id: string, patch: Partial<HarmonyRange>) => void;
  onRemoveRange: (id: string) => void;
  songKey: HarmonyKey;
  scale: HarmonyScale;
  onKeyChange: (key: HarmonyKey) => void;
  onScaleChange: (scale: HarmonyScale) => void;
  /** Group id of the harmony voices currently applied to the source track. */
  activeGroupId: string | null;
  /** Mute or restore every applied harmony voice (A/B against the original). */
  onCompare: (muted: boolean) => void;
  onSoloHarmony: () => void;
  busy: boolean;
  progress: number;
  message: string;
  error: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** True while a rendered preview (not the project timeline) is playing. */
  previewPlaying: boolean;
  /** True while that preview is paused — the control becomes "Resume preview". */
  previewPaused: boolean;
  onPausePreview: () => void;
  onResumePreview: () => void;
  onStopPreview: () => void;
  onPreview: (draft: HarmonyDraft) => void;
  onApply: (draft: HarmonyDraft) => void;
  onCancel: () => void;
  onLayerPatch: (layerId: string, patch: Partial<HarmonyLayer>) => void;
  onLayerOffset: (layerId: string, offsetSeconds: number) => void;
  onLayerPreview: (layerId: string) => void;
  onLayerRemove: (layerId: string) => void;
  onLayerDuplicate: (layerId: string) => void;
  onLayerRerender: (layerId: string, semitones: number, effects: RangeEffect[]) => void;
}

const DEFAULT_RANGE_START = 5;
const DEFAULT_RANGE_END = 25;

function presetAnnouncement(preset: HarmonyPreset): string {
  const parts = preset.voices.map((voice) =>
    `${voice.name}: ${voice.semitones === 0 ? 'original pitch' : `${voice.semitones >= 0 ? 'plus' : 'minus'} ${Math.abs(voice.semitones)} semitones`}, ${voice.delayMs} milliseconds, ${Math.round(voice.gain * 100)} percent`
  );
  return `${preset.label} settings loaded. ${parts.join('. ')}. Every value can be edited.`;
}

export function HarmonizationPanel(props: HarmonizationPanelProps) {
  const {
    tracks, harmonies, sourceTrackId, onSourceTrackChange, mediaDuration, hasVocalStems, onRunSeparation,
    ranges, onAddRange, onUpdateRange, onRemoveRange, songKey, scale, onKeyChange, onScaleChange,
    activeGroupId, onCompare, onSoloHarmony, busy, progress, message, error, canUndo, canRedo, onUndo, onRedo,
    previewPlaying, previewPaused, onPausePreview, onResumePreview, onStopPreview,
  } = props;

  const [scopeMode, setScopeMode] = useState<'entire-song' | 'range'>('entire-song');
  const [voices, setVoices] = useState<HarmonyDraftVoice[]>(() => voicesFromPreset(HARMONY_PRESET_A));
  const [vocalsOnly, setVocalsOnly] = useState(false);
  const [separateOriginalTrack, setSeparateOriginalTrack] = useState(false);
  const [validation, setValidation] = useState('');
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!tracks.some((t) => t.id === sourceTrackId)) {
      onSourceTrackChange(tracks[0]?.id ?? '');
    }
  }, [onSourceTrackChange, sourceTrackId, tracks]);

  const enabledRanges = useMemo(
    () => ranges.filter((r) => r.enabled !== false).map((r) => ({ start: r.start, end: r.end })),
    [ranges],
  );

  const scope: HarmonyScopeSpec = useMemo(
    () => ({ scope: scopeMode, start: ranges[0]?.start ?? DEFAULT_RANGE_START, end: ranges[0]?.end ?? DEFAULT_RANGE_END, ranges }),
    [scopeMode, ranges],
  );

  const rangeProblem = scopeMode === 'range' ? validateHarmonyRanges(enabledRanges, mediaDuration) : null;

  const trackName = useCallback(
    (id: string) => tracks.find((t) => t.id === id)?.name ?? 'Unknown track',
    [tracks],
  );

  const loadPreset = useCallback((preset: HarmonyPreset) => {
    setVoices(voicesFromPreset(preset));
    setValidation('');
    setAnnouncement(presetAnnouncement(preset));
  }, []);

  const updateVoice = useCallback((id: string, patch: Partial<HarmonyDraftVoice>) => {
    setVoices((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }, []);

  const addVoice = useCallback(() => {
    setVoices((prev) => {
      const used = new Set(prev.map((v) => v.semitones));
      let semitones = 3;
      while (used.has(semitones)) semitones = semitones >= 24 ? -24 : semitones + 1;
      return [
        ...prev,
        {
          id: makeId('voice'),
          semitones,
          enabled: true,
          gain: 0.3,
          offsetSeconds: 0,
          pan: 0,
          detuneCents: 0,
          name: `Voice ${prev.length + 1} — Harmony ${semitones >= 0 ? '+' : ''}${semitones}`,
          targetTrackName: '',
          effects: [],
        },
      ];
    });
  }, []);

  const removeVoice = useCallback((id: string) => {
    setVoices((prev) => prev.filter((v) => v.id !== id));
  }, []);

  const snapToKey = useCallback(() => {
    setVoices((prev) => prev.map((voice) => {
      if (voice.semitones === 0) return voice;
      const snapped = nearestInKeyInterval(voice.semitones, songKey, scale);
      return snapped === voice.semitones ? voice : { ...voice, semitones: snapped };
    }));
    setAnnouncement(`Intervals snapped to ${songKey} ${scale}. The lead voice stays at original pitch.`);
  }, [songKey, scale]);

  const draft = useMemo<HarmonyDraft>(() => ({
    sourceTrackId,
    scope: { ...scope, ranges: scopeMode === 'range' ? enabledRanges : undefined },
    voices,
    vocalsOnly,
    separateOriginalTrack,
    key: songKey,
    scale,
  }), [sourceTrackId, scope, scopeMode, enabledRanges, voices, vocalsOnly, separateOriginalTrack, songKey, scale]);

  const run = (apply: boolean) => {
    if (busy) return;
    if (scopeMode === 'range') {
      const problem = validateHarmonyRanges(enabledRanges, mediaDuration);
      if (problem) {
        setValidation(problem);
        setAnnouncement(`Cannot apply. ${problem}`);
        return;
      }
    }
    if (!voices.some((v) => v.enabled)) {
      setValidation('Enable at least one harmony voice.');
      setAnnouncement('Cannot apply. Enable at least one harmony voice.');
      return;
    }
    if (vocalsOnly && !hasVocalStems) {
      const problem = 'Human Voice Mode needs separated vocal stems. Run vocal separation first, or turn Human Voice Mode off.';
      setValidation(problem);
      setAnnouncement(problem);
      return;
    }
    setValidation('');
    if (apply) props.onApply(draft);
    else props.onPreview(draft);
  };

  const resetToOriginal = () => {
    setVoices((prev) => prev.map((voice) => ({ ...voice, semitones: 0, detuneCents: 0 })));
    setValidation('');
    setAnnouncement('All voices reset to original pitch. The lead is unchanged.');
  };

  const sourceTrack = tracks.find((t) => t.id === sourceTrackId);
  const appliedVoices = harmonies.filter((h) => h.sourceTrackId === sourceTrackId);
  const groupVoices = activeGroupId ? harmonies.filter((h) => h.groupId === activeGroupId) : appliedVoices;
  const harmonyMuted = groupVoices.length > 0 && groupVoices.every((h) => h.muted);

  const voiceLabel = (voice: HarmonyDraftVoice): string => {
    if (voice.semitones === 0 && voice.detuneCents === 0) return 'Original lead, +0 semitones';
    if (voice.semitones === 0) return `Double, +0 semitones, detuned ${voice.detuneCents} cents`;
    return `${describeInterval(voice.semitones)}`;
  };

  return (
    <section className="panel" aria-label="Harmonization">
      <h3 className="panel-title">Harmonization</h3>
      <p className="hint">
        Harmony voices are real pitch-shifted audio: formant-preserving spectral shifting keeps the vocal-tract
        character (no chipmunk), and tempo/duration never change. The lead +0 voice reuses the source audio.
      </p>

      <label className="field">
        <span>Source track</span>
        <select value={sourceTrackId} aria-label="Harmonization source track" onChange={(e) => onSourceTrackChange(e.target.value)}>
          {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>

      <fieldset className="field" aria-label="Harmonization range mode">
        <legend>Apply to</legend>
        <div className="row wrap">
          <label className="checkbox">
            <input
              type="radio"
              name="harmony-scope"
              checked={scopeMode === 'entire-song'}
              aria-label="Entire Song"
              onChange={() => setScopeMode('entire-song')}
            />
            <span>Entire Song</span>
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="harmony-scope"
              checked={scopeMode === 'range'}
              aria-label="Selected Time Ranges"
              onChange={() => setScopeMode('range')}
            />
            <span>Selected Time Ranges</span>
          </label>
        </div>
      </fieldset>

      {scopeMode === 'range' && (
        <section className="panel" aria-label="Harmonization time ranges" style={{ padding: 0, border: 0 }}>
          <h4 className="panel-subtitle">Time ranges</h4>
          <p className="hint">
            Add as many non-contiguous ranges as you need (for example 00:05–00:25, 01:25–01:35, 02:25–02:35).
            Only samples inside an enabled range are processed; every other section is left untouched.
          </p>
          {ranges.length === 0 ? (
            <p className="hint" role="status">No ranges yet. Add one to harmonize a chorus only.</p>
          ) : (
            <ul className="region-list" aria-label="Time ranges for harmonization">
              {ranges.map((range, index) => {
                const problem = validateHarmonyRange(range.start, range.end, mediaDuration);
                return (
                  <li key={range.id} className="merge-item">
                    <span>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={range.enabled !== false}
                          aria-label={`Enable time range ${index + 1}, ${formatTime(range.start)} to ${formatTime(range.end)}`}
                          onChange={(e) => onUpdateRange(range.id, { enabled: e.target.checked })}
                        />
                        <span>Range {index + 1}</span>
                      </label>
                      <span className="hint" style={{ display: 'block' }}>
                        {formatTime(range.start)} – {formatTime(range.end)} · {(range.end - range.start).toFixed(3)}s
                      </span>
                      {problem && <span className="error" role="alert">{problem}</span>}
                    </span>
                    <span className="row wrap">
                      <label className="field">
                        <span>Start</span>
                        <input
                          type="text"
                          value={formatTime(range.start)}
                          aria-label={`Range ${index + 1} start time`}
                          onChange={(e) => { const parsed = parseTime(e.target.value); if (parsed !== null) onUpdateRange(range.id, { start: parsed }); }}
                        />
                        <input
                          type="number"
                          min={0}
                          step={0.001}
                          value={Number(range.start.toFixed(3))}
                          aria-label={`Range ${index + 1} start in seconds`}
                          onChange={(e) => onUpdateRange(range.id, { start: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </label>
                      <label className="field">
                        <span>End</span>
                        <input
                          type="text"
                          value={formatTime(range.end)}
                          aria-label={`Range ${index + 1} end time`}
                          onChange={(e) => { const parsed = parseTime(e.target.value); if (parsed !== null) onUpdateRange(range.id, { end: parsed }); }}
                        />
                        <input
                          type="number"
                          min={0}
                          step={0.001}
                          value={Number(range.end.toFixed(3))}
                          aria-label={`Range ${index + 1} end in seconds`}
                          onChange={(e) => onUpdateRange(range.id, { end: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn-xs btn-danger"
                        aria-label={`Remove time range ${index + 1}`}
                        onClick={() => onRemoveRange(range.id)}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" className="btn btn-xs" aria-label="Add time range" onClick={onAddRange}>+ Add range</button>
        </section>
      )}

      <p className="hint" role="status" aria-live="polite" data-testid="harmony-scope-summary">
        {describeScope({ ...scope, ranges: scopeMode === 'range' ? enabledRanges : undefined }, mediaDuration)}
      </p>
      {rangeProblem && <div className="error" role="alert">{rangeProblem}</div>}

      <fieldset className="field" aria-label="Harmony presets">
        <legend>Harmony presets</legend>
        <div className="row wrap">
          {HARMONY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="btn btn-xs"
              aria-label={`${preset.label}. ${preset.description}`}
              onClick={() => loadPreset(preset)}
              disabled={busy}
            >
              {preset.id === 'preset-a' ? 'Preset A — Major (0, +4, +7, +0)' : preset.id === 'preset-b' ? 'Preset B — Alternative (0, +3, +7, +0)' : 'Preset C — Double-tracking'}
            </button>
          ))}
        </div>
        <p className="hint">
          Presets load the starting pitch, delay and volume for every voice; all of them stay editable. Preset C is a
          vocal doubler (tiny opposite detune plus short delays), because a genuine second take cannot be invented from
          one recording.
        </p>
      </fieldset>
      {announcement && <p className="hint" role="status" aria-live="polite" data-testid="harmony-announcement">{announcement}</p>}

      <fieldset className="field" aria-label="Musical key and scale">
        <legend>Key and scale</legend>
        <div className="row wrap">
          <label className="field">
            <span>Key</span>
            <select value={songKey} aria-label="Song key" onChange={(e) => onKeyChange(e.target.value as HarmonyKey)}>
              {HARMONY_KEYS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Scale</span>
            <select value={scale} aria-label="Song scale" onChange={(e) => onScaleChange(e.target.value as HarmonyScale)}>
              <option value="major">Major</option>
              <option value="minor">Minor</option>
            </select>
          </label>
          <button type="button" className="btn btn-xs" aria-label={`Snap harmony intervals to ${songKey} ${scale}`} onClick={snapToKey}>
            Snap to key
          </button>
        </div>
        <p className="hint">
          A fixed interval is not automatically wrong — use this as a warning and as an optional snap. The lead voice is
          never transposed by this control.
        </p>
      </fieldset>

      <div className="field">
        <span>Interval for the first harmony voice</span>
        <div className="row wrap">
          {HARMONY_INTERVAL_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="btn btn-xs"
              aria-label={`Harmony interval ${preset.label} (${preset.semitones >= 0 ? '+' : ''}${preset.semitones})`}
              onClick={() => {
                const target = voices.find((v) => v.semitones !== 0) ?? voices[0];
                if (target) updateVoice(target.id, { semitones: preset.semitones });
              }}
              disabled={busy || !voices.length}
            >
              {preset.label} ({preset.semitones >= 0 ? '+' : ''}{preset.semitones})
            </button>
          ))}
        </div>
      </div>

      <ul className="region-list" aria-label="Harmony voices">
        {voices.map((voice, index) => {
          const label = voiceLabel(voice);
          const conflict = describeKeyConflict(voice.semitones, songKey, scale);
          const autoName = voice.name || `Voice ${index + 1}`;
          const target = voice.semitones === 0 && voice.detuneCents === 0
            ? `${trackName(sourceTrackId)} (original lead)`
            : voice.targetTrackName
              ? voice.targetTrackName
              : `${autoName} (auto)`;
          const otherTracks = tracks
            .filter((t) => t.id !== sourceTrackId)
            .map((t) => t.name);
          return (
            <li key={voice.id} className="merge-item">
              <span>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={voice.enabled}
                    aria-label={`Enable harmony voice ${index + 1}, ${label}`}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { enabled: e.target.checked })}
                  />
                  <span>{autoName} · {label}</span>
                </label>
                <span className="hint" style={{ display: 'block' }}>→ {target}</span>
                {conflict && <span className="warning" role="status">{conflict}</span>}
                {voice.semitones === 0 && voice.detuneCents === 0 && voice.offsetSeconds > 0 && (
                  <span className="warning" role="status">
                    A plain delayed copy of the lead comb-filters with it.{' '}
                    <button
                      type="button"
                      className="btn btn-xs"
                      aria-label={`De-correlate copy ${index + 1} by detuning it six cents`}
                      onClick={() => updateVoice(voice.id, { detuneCents: -6 })}
                      disabled={busy}
                    >
                      De-correlate (−6 cents)
                    </button>
                  </span>
                )}
              </span>
              <span className="row wrap">
                <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>Pitch</span>
                  <input
                    type="number"
                    min={-24}
                    max={24}
                    step={1}
                    value={voice.semitones}
                    aria-label={`Harmony voice ${index + 1} pitch, ${voice.semitones >= 0 ? 'plus' : 'minus'} ${Math.abs(voice.semitones)} semitones`}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { semitones: Math.max(-24, Math.min(24, Math.round(Number(e.target.value) || 0))) })}
                    style={{ width: 72 }}
                  />
                </label>
                <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>Detune</span>
                  <input
                    type="number"
                    min={-50}
                    max={50}
                    step={1}
                    value={voice.detuneCents}
                    aria-label={`Harmony voice ${index + 1} detune, ${voice.detuneCents} cents`}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { detuneCents: Math.max(-50, Math.min(50, Number(e.target.value) || 0)) })}
                    style={{ width: 72 }}
                  />
                </label>
                <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>Delay</span>
                  <input
                    type="number"
                    min={0}
                    max={500}
                    step={1}
                    value={Math.round(voice.offsetSeconds * 1000)}
                    aria-label={`Harmony voice ${index + 1} delay, ${describeDelay(voice.offsetSeconds)}`}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { offsetSeconds: Math.max(0, Math.min(500, Number(e.target.value) || 0)) / 1000 })}
                    style={{ width: 72 }}
                  />
                </label>
                <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={voice.gain}
                    aria-label={`Harmony voice ${index + 1} volume, ${Math.round(voice.gain * 100)} percent`}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { gain: Number(e.target.value) })}
                    style={{ width: 80 }}
                  />
                </label>
                <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>Pan</span>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={voice.pan}
                    aria-label={`Harmony voice ${index + 1} pan, ${describePan(voice.pan)}`}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { pan: Number(e.target.value) })}
                    style={{ width: 80 }}
                  />
                </label>
                <select
                  aria-label={`Harmony voice ${index + 1} target track`}
                  value={voice.targetTrackName}
                  disabled={busy}
                  onChange={(e) => updateVoice(voice.id, { targetTrackName: e.target.value })}
                >
                  <option value="">{autoName} (auto)</option>
                  {HARMONY_TRACK_SLOTS.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
                  {otherTracks.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                {voices.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-xs btn-danger"
                    aria-label={`Remove harmony voice ${index + 1}`}
                    onClick={() => removeVoice(voice.id)}
                    disabled={busy}
                  >
                    Remove
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <button type="button" className="btn btn-xs" aria-label="Add harmony voice" onClick={addVoice} disabled={busy}>+ Add voice</button>

      <label className="field checkbox">
        <input
          type="checkbox"
          checked={vocalsOnly}
          aria-label="Human Voice Mode: apply harmonization only to isolated human vocals"
          disabled={busy || !hasVocalStems}
          onChange={(e) => setVocalsOnly(e.target.checked)}
        />
        <span>
          Human Voice Mode — isolate the human voice before shifting it
          {hasVocalStems
            ? ' (separated stems are used; the accompaniment is not shifted)'
            : ' (needs vocal separation first — this control is disabled without stems)'}
        </span>
      </label>
      {!hasVocalStems && (
        <button type="button" className="btn btn-xs" aria-label="Run vocal separation for the source track" onClick={onRunSeparation} disabled={busy}>
          Run vocal separation
        </button>
      )}
      {/*
        Honest wording: formant preservation is not a hidden toggle that only
        works in one mode. Every rendered voice — +3, +4, +7 alike, with or
        without Human Voice Mode — goes through the same natural-vocal pitch
        shifter, and the tests measure each interval's formants. Human Voice
        Mode only decides *what* is shifted (the isolated vocal stem), never
        *how* it is shifted.
      */}
      <p className="hint">
        Every voice is pitch-shifted with real formant preservation, whichever
        interval you pick. Human Voice Mode only chooses the source: the
        separated vocal stem, so the accompaniment is not transposed — the lead
        and the accompaniment still play in the mix.
      </p>
      <label className="field checkbox">
        <input
          type="checkbox"
          checked={separateOriginalTrack}
          aria-label="Create a separate track for the original plus zero voice"
          disabled={busy}
          onChange={(e) => setSeparateOriginalTrack(e.target.checked)}
        />
        <span>Create a separate track for the original (+0) voice instead of reusing the source audio</span>
      </label>

      {validation && <div className="error" role="alert">{validation}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {busy && (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={message}>
          <div className="progress-bar" style={{ width: `${progress * 100}%` }} />
          <span>{message} {Math.round(progress * 100)}%</span>
        </div>
      )}

      <div className="row wrap">
        <button type="button" className="btn" aria-label="Preview harmony" onClick={() => run(false)} disabled={busy}>Preview</button>
        <button type="button" className="btn btn-primary" aria-label="Apply harmony" onClick={() => run(true)} disabled={busy}>Apply</button>
        {/* Cancel stays enabled while a render is running: it stops the job
            instead of leaving the panel busy until the page is reloaded. */}
        <button type="button" className="btn" aria-label="Cancel harmony" onClick={props.onCancel}>Cancel</button>
        <button type="button" className="btn" aria-label="Reset harmony to original pitch" onClick={resetToOriginal} disabled={busy}>Reset to original pitch</button>
        <button type="button" className="btn" aria-label="Undo last edit" onClick={onUndo} disabled={!canUndo || busy}>Undo</button>
        <button type="button" className="btn" aria-label="Redo last undone edit" onClick={onRedo} disabled={!canRedo || busy}>Redo</button>
      </div>

      {/*
        Preview playback lives next to the Preview button so it is reachable
        without scrolling to the main transport. Pause keeps the playhead and
        the whole harmony draft untouched; Resume continues from that sample.
      */}
      {(previewPlaying || previewPaused) && (
        <div className="row wrap" role="group" aria-label="Preview playback">
          <span className="hint" role="status" data-testid="harmony-preview-state">
            {previewPaused ? 'Preview paused' : 'Preview playing'}
          </span>
          {previewPaused ? (
            <button type="button" className="btn btn-primary" aria-label="Resume preview" onClick={onResumePreview}>
              Resume
            </button>
          ) : (
            <button type="button" className="btn btn-primary" aria-label="Pause preview" onClick={onPausePreview}>
              Pause
            </button>
          )}
          <button type="button" className="btn" aria-label="Stop preview" onClick={onStopPreview}>Stop</button>
        </div>
      )}

      {appliedVoices.length > 0 && (
        <div className="field">
          <span>Compare</span>
          <div className="row wrap">
            <button
              type="button"
              className={`btn btn-xs ${harmonyMuted ? 'btn-active' : ''}`}
              aria-pressed={harmonyMuted}
              aria-label={harmonyMuted ? 'Restore the harmonized mix' : 'Mute all harmony voices and hear the original'}
              onClick={() => (activeGroupId ? onCompare(!harmonyMuted) : onCompare(true))}
            >
              {harmonyMuted ? 'Restore harmony mix' : 'Hear original only'}
            </button>
            <button type="button" className="btn btn-xs" aria-label="Solo the harmony voices" onClick={onSoloHarmony}>
              Solo harmony
            </button>
          </div>
        </div>
      )}

      <h4 className="panel-subtitle">Applied harmony voices</h4>
      {appliedVoices.length === 0 ? (
        <p className="hint">No harmony voices are applied to {sourceTrack?.name ?? 'this track'} yet.</p>
      ) : (
        <ul className="region-list" aria-label="Applied harmony voices">
          {appliedVoices.map((layer, index) => (
            <AppliedVoiceRow
              key={layer.id}
              layer={layer}
              index={index}
              trackName={trackName}
              busy={busy}
              onPatch={props.onLayerPatch}
              onOffset={props.onLayerOffset}
              onPreview={props.onLayerPreview}
              onRemove={props.onLayerRemove}
              onDuplicate={props.onLayerDuplicate}
              onRerender={props.onLayerRerender}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface AppliedVoiceRowProps {
  layer: HarmonyLayer;
  index: number;
  trackName: (id: string) => string;
  busy: boolean;
  onPatch: (layerId: string, patch: Partial<HarmonyLayer>) => void;
  onOffset: (layerId: string, offsetSeconds: number) => void;
  onPreview: (layerId: string) => void;
  onRemove: (layerId: string) => void;
  onDuplicate: (layerId: string) => void;
  onRerender: (layerId: string, semitones: number, effects: RangeEffect[]) => void;
}

function AppliedVoiceRow({
  layer, index, trackName, busy, onPatch, onOffset, onPreview, onRemove, onDuplicate, onRerender,
}: AppliedVoiceRowProps) {
  const effects = layer.effects ?? [];
  const [semis, setSemis] = useState(layer.semitones);
  const [reverb, setReverb] = useState(effects.some((e) => e.type === 'reverb'));
  const [echo, setEcho] = useState(effects.some((e) => e.type === 'echo'));

  useEffect(() => { setSemis(layer.semitones); }, [layer.semitones]);
  useEffect(() => {
    setReverb((layer.effects ?? []).some((e) => e.type === 'reverb'));
    setEcho((layer.effects ?? []).some((e) => e.type === 'echo'));
  }, [layer.effects]);

  const label = layer.originalVoice ? 'Original lead (+0)' : describeInterval(layer.semitones);
  const pan = layer.pan ?? 0;
  const scopeText = layer.scope === 'entire-song'
    ? 'entire song'
    : `ranges ${formatTime(layer.rangeStart ?? 0)}–${formatTime(layer.rangeEnd ?? 0)}`;

  const buildEffects = (): RangeEffect[] => {
    const list: RangeEffect[] = [];
    if (reverb) {
      list.push({
        id: `fx-${layer.id}-reverb`,
        type: 'reverb',
        start: 0,
        end: Math.max(0.001, layer.rangeEnd && layer.scope === 'range' ? layer.rangeEnd : 3600),
        params: { reverbSeconds: 1.2, reverbMix: 0.3 },
        enabled: true,
      });
    }
    if (echo) {
      list.push({
        id: `fx-${layer.id}-echo`,
        type: 'echo',
        start: 0,
        end: Math.max(0.001, layer.rangeEnd && layer.scope === 'range' ? layer.rangeEnd : 3600),
        params: { echoDelay: 0.25, echoFeedback: 0.35, echoMix: 0.25 },
        enabled: true,
      });
    }
    return list;
  };

  return (
    <li className="merge-item">
      <span>
        {layer.name} · {layer.originalVoice ? `${trackName(layer.sourceTrackId)} (original pitch)` : `${trackName(layer.sourceTrackId)} → ${trackName(layer.targetTrackId)}`}
        <span className="hint" style={{ display: 'block' }}>
          {label} · delay {describeDelay(layer.offsetSeconds ?? 0)} · volume {Math.round(layer.gain * 100)}% · pan {describePan(pan)} · {scopeText}
          {layer.vocalsOnly ? ' · vocals only' : ''}
          {effects.length ? ` · ${effects.map((e) => e.type).join(', ')}` : ''}
        </span>
      </span>
      <span className="row wrap">
        <button type="button" className="btn btn-xs" aria-label={`Preview harmony voice ${index + 1}, ${layer.name}`} onClick={() => onPreview(layer.id)} disabled={busy}>Preview</button>
        <button
          type="button"
          className={`btn btn-xs ${layer.muted ? 'btn-active' : ''}`}
          aria-pressed={layer.muted}
          aria-label={`${layer.muted ? 'Unmute' : 'Mute'} harmony voice ${index + 1}, ${layer.name}`}
          onClick={() => onPatch(layer.id, { muted: !layer.muted })}
          disabled={busy}
        >
          {layer.muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          className={`btn btn-xs ${layer.solo ? 'btn-active' : ''}`}
          aria-pressed={layer.solo}
          aria-label={`${layer.solo ? 'Unsolo' : 'Solo'} harmony voice ${index + 1}, ${layer.name}`}
          onClick={() => onPatch(layer.id, { solo: !layer.solo })}
          disabled={busy}
        >
          {layer.solo ? 'Unsolo' : 'Solo'}
        </button>
        <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={layer.gain}
            aria-label={`Applied voice ${index + 1} volume, ${Math.round(layer.gain * 100)} percent`}
            onChange={(e) => onPatch(layer.id, { gain: Number(e.target.value) })}
            style={{ width: 80 }}
          />
        </label>
        <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span>Pan</span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={pan}
            aria-label={`Applied voice ${index + 1} pan, ${describePan(pan)}`}
            onChange={(e) => onPatch(layer.id, { pan: Number(e.target.value) })}
            style={{ width: 80 }}
          />
        </label>
        <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span>Delay</span>
          <input
            type="number"
            min={0}
            max={500}
            step={1}
            value={Math.round((layer.offsetSeconds ?? 0) * 1000)}
            aria-label={`Applied voice ${index + 1} delay, ${describeDelay(layer.offsetSeconds ?? 0)}`}
            onChange={(e) => onOffset(layer.id, Math.max(0, Math.min(500, Number(e.target.value) || 0)) / 1000)}
            style={{ width: 72 }}
            disabled={busy}
          />
        </label>
        {!layer.originalVoice && (
          <>
            <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span>Semitones</span>
              <input
                type="number"
                min={-24}
                max={24}
                step={1}
                value={semis}
                aria-label={`Applied voice ${index + 1} semitones`}
                onChange={(e) => setSemis(Math.max(-24, Math.min(24, Math.round(Number(e.target.value) || 0))))}
                style={{ width: 72 }}
                disabled={busy}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={reverb}
                aria-label={`Reverb on applied voice ${index + 1}`}
                onChange={(e) => setReverb(e.target.checked)}
                disabled={busy}
              />
              <span>Reverb</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={echo}
                aria-label={`Echo on applied voice ${index + 1}`}
                onChange={(e) => setEcho(e.target.checked)}
                disabled={busy}
              />
              <span>Echo</span>
            </label>
            <button
              type="button"
              className="btn btn-xs"
              aria-label={`Update harmony voice ${index + 1}, ${layer.name}`}
              onClick={() => onRerender(layer.id, semis, buildEffects())}
              disabled={busy}
            >
              Update voice
            </button>
          </>
        )}
        <button type="button" className="btn btn-xs" aria-label={`Duplicate harmony voice ${index + 1}, ${layer.name}`} onClick={() => onDuplicate(layer.id)} disabled={busy}>Duplicate</button>
        <button type="button" className="btn btn-xs btn-danger" aria-label={`Remove harmony voice ${index + 1}, ${layer.name}`} onClick={() => onRemove(layer.id)} disabled={busy}>Remove</button>
      </span>
    </li>
  );
}

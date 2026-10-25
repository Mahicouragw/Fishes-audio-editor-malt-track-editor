import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HarmonyLayer, RangeEffect, Track } from '../types';
import { formatTime, parseTime } from '../types';
import {
  HARMONY_INTERVAL_PRESETS,
  HARMONY_PRESET_A,
  HARMONY_PRESET_B,
  HARMONY_TRACK_SLOTS,
  describeInterval,
  describeScope,
  validateHarmonyRange,
  voicesFromIntervals,
  type HarmonyScopeSpec,
} from '../audio/harmony';

export interface HarmonyDraftVoice {
  id: string;
  semitones: number;
  enabled: boolean;
  gain: number;
  offsetSeconds: number;
  /** Name of the target track. Empty means "auto-assign". */
  targetTrackName: string;
  effects: RangeEffect[];
}

export interface HarmonyDraft {
  sourceTrackId: string;
  scope: HarmonyScopeSpec;
  voices: HarmonyDraftVoice[];
  vocalsOnly: boolean;
  /** Render a real duplicate of the +0 voice on its own track. */
  separateOriginalTrack: boolean;
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
  busy: boolean;
  progress: number;
  message: string;
  error: string;
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

function scopeKey(scope: HarmonyScopeSpec): string {
  return `${scope.scope}|${scope.start.toFixed(3)}|${scope.end.toFixed(3)}`;
}

export function HarmonizationPanel(props: HarmonizationPanelProps) {
  const {
    tracks, harmonies, sourceTrackId, onSourceTrackChange, mediaDuration, hasVocalStems, busy, progress, message, error,
  } = props;

  const [scopeMode, setScopeMode] = useState<'entire-song' | 'range'>('entire-song');
  const [rangeStart, setRangeStart] = useState(DEFAULT_RANGE_START);
  const [rangeEnd, setRangeEnd] = useState(DEFAULT_RANGE_END);
  const [voices, setVoices] = useState<HarmonyDraftVoice[]>(() => voicesFromIntervals(HARMONY_PRESET_A.intervals));
  const [vocalsOnly, setVocalsOnly] = useState(false);
  const [separateOriginalTrack, setSeparateOriginalTrack] = useState(false);
  const [validation, setValidation] = useState('');

  // Follow the selected track when the user picks another one.
  useEffect(() => {
    if (!tracks.some((t) => t.id === sourceTrackId)) {
      onSourceTrackChange(tracks[0]?.id ?? '');
    }
  }, [onSourceTrackChange, sourceTrackId, tracks]);

  const scope: HarmonyScopeSpec = useMemo(
    () => ({ scope: scopeMode, start: rangeStart, end: rangeEnd }),
    [scopeMode, rangeStart, rangeEnd],
  );

  const rangeProblem = scopeMode === 'range'
    ? validateHarmonyRange(rangeStart, rangeEnd, mediaDuration)
    : null;

  const trackName = useCallback(
    (id: string) => tracks.find((t) => t.id === id)?.name ?? 'Unknown track',
    [tracks],
  );

  const setPreset = useCallback((intervals: number[]) => {
    setVoices(voicesFromIntervals(intervals));
    setValidation('');
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
            id: `voice-${Date.now().toString(36)}-${prev.length}`,
            semitones,
            enabled: true,
            gain: 0.8,
            offsetSeconds: 0,
            targetTrackName: '',
            effects: [],
          },
        ];
    });
  }, []);

  const removeVoice = useCallback((id: string) => {
    setVoices((prev) => prev.filter((v) => v.id !== id));
  }, []);

  const draft = useMemo<HarmonyDraft>(() => ({
    sourceTrackId,
    scope,
    voices,
    vocalsOnly,
    separateOriginalTrack,
  }), [sourceTrackId, scope, voices, vocalsOnly, separateOriginalTrack]);

  const run = (apply: boolean) => {
    if (busy) return;
    if (scopeMode === 'range') {
      const problem = validateHarmonyRange(rangeStart, rangeEnd, mediaDuration);
      if (problem) {
        setValidation(problem);
        return;
      }
    }
    if (!voices.some((v) => v.enabled)) {
      setValidation('Enable at least one harmony voice.');
      return;
    }
    setValidation('');
    if (apply) props.onApply(draft);
    else props.onPreview(draft);
  };

  const resetToOriginal = () => {
    setVoices((prev) => prev.map((v) => ({ ...v, semitones: 0 })));
    setValidation('');
  };

  const sourceTrack = tracks.find((t) => t.id === sourceTrackId);
  const appliedVoices = harmonies.filter((h) => h.sourceTrackId === sourceTrackId);

  return (
    <section className="panel" aria-label="Harmonization">
      <h3 className="panel-title">Harmonization</h3>
      <p className="hint">
        Harmony voices are real pitch-shifted signals (phase vocoder — tempo and duration preserved).
        The +0 voice is the original-pitch voice and reuses the source audio, so no duplicate audio is created for it.
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
              aria-label="Selected Time Range"
              onChange={() => setScopeMode('range')}
            />
            <span>Selected Time Range</span>
          </label>
        </div>
      </fieldset>

      {scopeMode === 'range' ? (
        <div className="row">
          <label className="field">
            <span>Start</span>
            <input
              type="text"
              value={formatTime(rangeStart)}
              aria-label="Harmonization range start"
              onChange={(e) => { const v = parseTime(e.target.value); if (v !== null) setRangeStart(v); }}
            />
            <input
              type="number"
              step={0.001}
              min={0}
              value={Number(rangeStart.toFixed(3))}
              aria-label="Harmonization range start in seconds"
              onChange={(e) => setRangeStart(Number(e.target.value) || 0)}
            />
          </label>
          <label className="field">
            <span>End</span>
            <input
              type="text"
              value={formatTime(rangeEnd)}
              aria-label="Harmonization range end"
              onChange={(e) => { const v = parseTime(e.target.value); if (v !== null) setRangeEnd(v); }}
            />
            <input
              type="number"
              step={0.001}
              min={0}
              value={Number(rangeEnd.toFixed(3))}
              aria-label="Harmonization range end in seconds"
              onChange={(e) => setRangeEnd(Number(e.target.value) || 0)}
            />
          </label>
        </div>
      ) : null}

      <p className="hint" role="status" aria-live="polite" data-testid="harmony-scope-summary">
        {describeScope(scope, mediaDuration)}
      </p>
      {scopeMode === 'range' && (
        <p className="hint">
          A range-limited voice sounds only inside the range; the untouched source keeps playing outside it, so the
          original audio is never duplicated.
        </p>
      )}
      {rangeProblem && <div className="error" role="alert">{rangeProblem}</div>}

      <div className="field">
        <span>Harmony presets</span>
        <div className="row wrap">
          <button
            type="button"
            className="btn btn-xs"
            aria-label={HARMONY_PRESET_A.label}
            onClick={() => setPreset(HARMONY_PRESET_A.intervals)}
            disabled={busy}
          >
            Preset A (0, +4, +7)
          </button>
          <button
            type="button"
            className="btn btn-xs"
            aria-label={HARMONY_PRESET_B.label}
            onClick={() => setPreset(HARMONY_PRESET_B.intervals)}
            disabled={busy}
          >
            Preset B (0, +3, +7)
          </button>
        </div>
      </div>

      <div className="field">
        <span>Interval</span>
        <div className="row wrap">
          {HARMONY_INTERVAL_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="btn btn-xs"
              aria-label={`Harmony interval ${preset.label} (${preset.semitones >= 0 ? '+' : ''}${preset.semitones})`}
              onClick={() => updateVoice(voices[0]?.id ?? '', { semitones: preset.semitones })}
              disabled={busy || !voices.length}
            >
              {preset.label} ({preset.semitones >= 0 ? '+' : ''}{preset.semitones})
            </button>
          ))}
          <input
            type="number"
            min={-24}
            max={24}
            step={1}
            value={voices[0]?.semitones ?? 0}
            aria-label="Custom harmony semitones"
            disabled={busy || !voices.length}
            onChange={(e) => updateVoice(voices[0]?.id ?? '', { semitones: Math.max(-24, Math.min(24, Math.round(Number(e.target.value) || 0))) })}
          />
        </div>
      </div>

      <ul className="region-list" aria-label="Harmony voices">
        {voices.map((voice, index) => {
          const label = voice.semitones === 0 ? 'Original' : describeInterval(voice.semitones);
          const autoName = `Voice ${index + 1}`;
          const target = voice.semitones === 0
            ? `${trackName(sourceTrackId)} (original pitch)`
            : voice.targetTrackName
              ? voice.targetTrackName
              : `${autoName} (auto)`;
          const slotOptions = HARMONY_TRACK_SLOTS.filter((slot) => {
            const owner = tracks.find((t) => t.name === slot);
            return !owner || owner.id !== sourceTrackId;
          });
          const otherTracks = tracks
            .filter((t) => t.id !== sourceTrackId && !HARMONY_TRACK_SLOTS.includes(t.name))
            .map((t) => t.name);
          return (
            <li key={voice.id} className="merge-item">
              <span>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={voice.enabled}
                    aria-label={`Enable harmony voice ${label}`}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { enabled: e.target.checked })}
                  />
                  <span>{label}</span>
                </label>
                <span className="hint" style={{ display: 'block' }}>→ {target}</span>
              </span>
              <span className="row">
                <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={voice.gain}
                    aria-label={`Harmony voice ${label} volume, ${Math.round(voice.gain * 100)} percent`}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { gain: Number(e.target.value) })}
                    style={{ width: 80 }}
                  />
                </label>
                <input
                  type="number"
                  min={-24}
                  max={24}
                  step={1}
                  value={voice.semitones}
                  aria-label={`Harmony voice ${label} semitones`}
                  disabled={busy}
                  onChange={(e) => updateVoice(voice.id, { semitones: Math.max(-24, Math.min(24, Math.round(Number(e.target.value) || 0))) })}
                  style={{ width: 72 }}
                />
                {voice.semitones !== 0 && (
                  <select
                    aria-label={`Harmony voice ${label} target track`}
                    value={voice.targetTrackName}
                    disabled={busy}
                    onChange={(e) => updateVoice(voice.id, { targetTrackName: e.target.value })}
                  >
                    <option value="">{autoName} (auto)</option>
                    {slotOptions.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
                    {otherTracks.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                )}
                {voices.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-xs btn-danger"
                    aria-label={`Remove harmony voice ${label}`}
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
          aria-label="Apply harmonization only to isolated human vocals"
          disabled={busy || !hasVocalStems}
          onChange={(e) => setVocalsOnly(e.target.checked)}
        />
        <span>
          Apply only to isolated human vocals
          {hasVocalStems
            ? ' (separated stems are used — the accompaniment stays untouched)'
            : ' (run vocal separation on the source track first)'}
        </span>
      </label>
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
          <span aria-live="polite">{message} {Math.round(progress * 100)}%</span>
        </div>
      )}

      <div className="row wrap">
        <button type="button" className="btn" aria-label="Preview harmony" onClick={() => run(false)} disabled={busy}>Preview</button>
        <button type="button" className="btn btn-primary" aria-label="Apply harmony" onClick={() => run(true)} disabled={busy}>Apply</button>
        <button type="button" className="btn" aria-label="Cancel harmony" onClick={props.onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn" aria-label="Reset harmony to original pitch" onClick={resetToOriginal} disabled={busy}>Reset to original pitch</button>
      </div>

      <h4 className="panel-subtitle">Applied harmony voices</h4>
      {appliedVoices.length === 0 ? (
        <p className="hint">No harmony voices are applied to {sourceTrack?.name ?? 'this track'} yet.</p>
      ) : (
        <ul className="region-list" aria-label="Applied harmony voices">
          {appliedVoices.map((layer) => (
            <AppliedVoiceRow
              key={layer.id}
              layer={layer}
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
  layer, trackName, busy, onPatch, onOffset, onPreview, onRemove, onDuplicate, onRerender,
}: AppliedVoiceRowProps) {
  // Defensive defaults: projects saved before per-voice effects existed have
  // no `effects` array.
  const effects = layer.effects ?? [];
  const [semis, setSemis] = useState(layer.semitones);
  const [reverb, setReverb] = useState(effects.some((e) => e.type === 'reverb'));
  const [echo, setEcho] = useState(effects.some((e) => e.type === 'echo'));
  const [offset, setOffset] = useState(layer.offsetSeconds ?? 0);

  useEffect(() => { setSemis(layer.semitones); }, [layer.semitones]);
  useEffect(() => { setOffset(layer.offsetSeconds ?? 0); }, [layer.offsetSeconds]);
  useEffect(() => {
    setReverb((layer.effects ?? []).some((e) => e.type === 'reverb'));
    setEcho((layer.effects ?? []).some((e) => e.type === 'echo'));
  }, [layer.effects]);

  const label = layer.originalVoice ? 'Original (+0)' : describeInterval(layer.semitones);
  const scopeText = layer.scope === 'entire-song'
    ? 'entire song'
    : `range ${formatTime(layer.rangeStart ?? 0)}–${formatTime(layer.rangeEnd ?? 0)}`;

  const buildEffects = (): RangeEffect[] => {
    const effects: RangeEffect[] = [];
    if (reverb) {
      effects.push({
        id: `fx-${layer.id}-reverb`,
        type: 'reverb',
        start: 0,
        end: Math.max(0.001, layer.rangeEnd && layer.scope === 'range' ? layer.rangeEnd : 3600),
        params: { reverbSeconds: 1.2, reverbMix: 0.3 },
        enabled: true,
      });
    }
    if (echo) {
      effects.push({
        id: `fx-${layer.id}-echo`,
        type: 'echo',
        start: 0,
        end: Math.max(0.001, layer.rangeEnd && layer.scope === 'range' ? layer.rangeEnd : 3600),
        params: { echoDelay: 0.25, echoFeedback: 0.35, echoMix: 0.25 },
        enabled: true,
      });
    }
    return effects;
  };

  return (
    <li className="merge-item">
      <span>
        {layer.name} · {layer.originalVoice ? `${trackName(layer.sourceTrackId)} (original pitch)` : `${trackName(layer.sourceTrackId)} → ${trackName(layer.targetTrackId)}`}
        <span className="hint" style={{ display: 'block' }}>
          {label} · {scopeText}{layer.vocalsOnly ? ' · vocals only' : ''}
          {effects.length ? ` · ${effects.map((e) => e.type).join(', ')}` : ''}
        </span>
      </span>
      <span className="row wrap">
        <button type="button" className="btn btn-xs" aria-label={`Preview harmony voice ${layer.name}`} onClick={() => onPreview(layer.id)} disabled={busy}>Preview</button>
        <button
          type="button"
          className={`btn btn-xs ${layer.muted ? 'btn-active' : ''}`}
          aria-pressed={layer.muted}
          aria-label={`${layer.muted ? 'Unmute' : 'Mute'} harmony voice ${layer.name}`}
          onClick={() => onPatch(layer.id, { muted: !layer.muted })}
          disabled={busy}
        >
          {layer.muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          className={`btn btn-xs ${layer.solo ? 'btn-active' : ''}`}
          aria-pressed={layer.solo}
          aria-label={`${layer.solo ? 'Unsolo' : 'Solo'} harmony voice ${layer.name}`}
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
            step={0.05}
            value={layer.gain}
            aria-label={`Harmony voice ${layer.name} volume, ${Math.round(layer.gain * 100)} percent`}
            onChange={(e) => onPatch(layer.id, { gain: Number(e.target.value) })}
            style={{ width: 80 }}
          />
        </label>
        <label className="clip-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span>Offset</span>
          <input
            type="number"
            step={0.05}
            value={offset}
            aria-label={`Harmony voice ${layer.name} timing offset in seconds`}
            onChange={(e) => {
              const value = Number(e.target.value) || 0;
              setOffset(value);
              onOffset(layer.id, value);
            }}
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
                aria-label={`Harmony voice ${layer.name} semitones`}
                onChange={(e) => setSemis(Math.max(-24, Math.min(24, Math.round(Number(e.target.value) || 0))))}
                style={{ width: 72 }}
                disabled={busy}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={reverb}
                aria-label={`Reverb on harmony voice ${layer.name}`}
                onChange={(e) => setReverb(e.target.checked)}
                disabled={busy}
              />
              <span>Reverb</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={echo}
                aria-label={`Echo on harmony voice ${layer.name}`}
                onChange={(e) => setEcho(e.target.checked)}
                disabled={busy}
              />
              <span>Echo</span>
            </label>
            <button
              type="button"
              className="btn btn-xs"
              aria-label={`Update harmony voice ${layer.name}`}
              onClick={() => onRerender(layer.id, semis, buildEffects())}
              disabled={busy}
            >
              Update voice
            </button>
          </>
        )}
        <button type="button" className="btn btn-xs" aria-label={`Duplicate harmony voice ${layer.name}`} onClick={() => onDuplicate(layer.id)} disabled={busy}>Duplicate</button>
        <button type="button" className="btn btn-xs btn-danger" aria-label={`Remove harmony voice ${layer.name}`} onClick={() => onRemove(layer.id)} disabled={busy}>Remove</button>
      </span>
    </li>
  );
}

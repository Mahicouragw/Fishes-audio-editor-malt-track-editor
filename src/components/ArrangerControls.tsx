import { useState, useEffect, useRef } from 'react';
import { STYLES, SECTIONS } from '../audio/arranger';
import type { StyleName, Section, PartVolumes } from '../audio/arranger';

interface Props {
  style: StyleName;
  section: Section;
  tempo: number;
  timeSig: string;
  transpose: number;
  masterVolume: number;
  accompVolume: number;
  splitPoint: number;
  singleFingerMode: boolean;
  metronome: boolean;
  partVolumes: PartVolumes;
  currentChordName?: string;
  onStyleChange: (s: StyleName) => void;
  onSection: (sec: Section) => void;
  onTempo: (bpm: number) => void;
  onTimeSig: (sig: string) => void;
  onTranspose: (semi: number) => void;
  onMasterVolume: (v: number) => void;
  onAccompVolume: (v: number) => void;
  onSplitPoint: (midi: number) => void;
  onChordMode: (single: boolean) => void;
  onMetronome: (on: boolean) => void;
  onPartVolume: (part: keyof PartVolumes, v: number) => void;
  onTapTempo?: () => void;
}

export function ArrangerControls({ style, section, tempo, timeSig, transpose, masterVolume, accompVolume, splitPoint, singleFingerMode, metronome, partVolumes, currentChordName, onStyleChange, onSection, onTempo, onTimeSig, onTranspose, onMasterVolume, onAccompVolume, onSplitPoint, onChordMode, onMetronome, onPartVolume, onTapTempo }: Props) {
  const [tapTimes, setTapTimes] = useState<number[]>([]);
  const metronomeRef = useRef<number | null>(null);

  const handleTap = () => {
    const now = performance.now();
    const times = [...tapTimes, now].slice(-4);
    setTapTimes(times);
    if (times.length >= 2) {
      const intervals = times.slice(1).map((t, i) => t - times[i]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avg);
      if (bpm >= 40 && bpm <= 200) onTempo(bpm);
    }
    onTapTempo?.();
    setTimeout(() => setTapTimes([]), 2000);
  };

  return (
    <div className="arranger-controls" role="group" aria-label="Professional arranger controls">
      <div className="control-row">
        <label className="field">
          <span>Style</span>
          <select aria-label="Accompaniment style" value={style} onChange={e => onStyleChange(e.target.value as StyleName)}>
            {STYLES.map(s => <option key={s.id} value={s.id}>{s.name} — {s.description} ({s.tempo}bpm {s.timeSig})</option>)}
          </select>
        </label>
        <label className="field">
          <span>Time Signature</span>
          <select aria-label="Time signature" value={timeSig} onChange={e => onTimeSig(e.target.value)}>
            <option value="4/4">4/4</option>
            <option value="3/4">3/4</option>
            <option value="6/8">6/8</option>
          </select>
        </label>
      </div>

      <div className="style-sections" role="group" aria-label="Intro, Main, Fill, Break, Ending">
        <div className="section-group" role="group" aria-label="Intro">
          <span className="section-label">Intro</span>
          {SECTIONS.filter(s => s.type === 'intro').map(s => (
            <button key={s.id} type="button" aria-label={s.name} aria-pressed={section === s.id} className={`btn btn-xs ${section === s.id ? 'btn-active' : ''}`} onClick={() => onSection(s.id)}>{s.name}</button>
          ))}
        </div>
        <div className="section-group" role="group" aria-label="Main variations">
          <span className="section-label">Main</span>
          {SECTIONS.filter(s => s.type === 'main').map(s => (
            <button key={s.id} type="button" aria-label={s.name} aria-pressed={section === s.id} className={`btn btn-xs ${section === s.id ? 'btn-active' : ''}`} onClick={() => onSection(s.id)}>{s.name.toUpperCase()}</button>
          ))}
        </div>
        <div className="section-group" role="group" aria-label="Fill In">
          <span className="section-label">Fill In</span>
          {SECTIONS.filter(s => s.type === 'fill').map(s => (
            <button key={s.id} type="button" aria-label={s.name} aria-pressed={section === s.id} className={`btn btn-xs ${section === s.id ? 'btn-active' : ''}`} onClick={() => onSection(s.id)}>{s.name}</button>
          ))}
        </div>
        <div className="section-group" role="group" aria-label="Break and Ending">
          <button type="button" aria-label="Break" aria-pressed={section === 'break'} className={`btn btn-xs ${section === 'break' ? 'btn-active' : ''}`} onClick={() => onSection('break')}>Break</button>
          {SECTIONS.filter(s => s.type === 'ending').map(s => (
            <button key={s.id} type="button" aria-label={s.name} aria-pressed={section === s.id} className={`btn btn-xs ${section === s.id ? 'btn-active' : ''}`} onClick={() => onSection(s.id)}>{s.name}</button>
          ))}
        </div>
      </div>

      <div className="control-grid">
        <label className="field">
          <span>Tempo: {tempo} BPM {metronome && '♪'}</span>
          <input type="range" min={40} max={200} value={tempo} aria-label={`Tempo ${tempo} beats per minute`} onChange={e => onTempo(parseInt(e.target.value))} />
          <div className="row">
            <button type="button" aria-label="Tap tempo, tap 4 times" className="btn btn-xs" onClick={handleTap}>Tap Tempo</button>
            <button type="button" role="switch" aria-checked={metronome} aria-label="Metronome" className={`btn btn-xs ${metronome ? 'btn-active' : ''}`} onClick={() => onMetronome(!metronome)}>{metronome ? '♪ On' : '♪ Off'}</button>
          </div>
        </label>

        <label className="field">
          <span>Transpose: {transpose > 0 ? `+${transpose}` : transpose} semitones</span>
          <input type="range" min={-12} max={12} value={transpose} aria-label={`Transpose ${transpose} semitones`} onChange={e => onTranspose(parseInt(e.target.value))} />
        </label>

        <label className="field">
          <span>Master Volume: {Math.round(masterVolume * 100)}%</span>
          <input type="range" min={0} max={1} step={0.05} value={masterVolume} aria-label={`Master volume ${Math.round(masterVolume * 100)} percent`} onChange={e => onMasterVolume(parseFloat(e.target.value))} />
        </label>

        <label className="field">
          <span>Accomp Volume: {Math.round(accompVolume * 100)}%</span>
          <input type="range" min={0} max={1} step={0.05} value={accompVolume} aria-label={`Accompaniment volume ${Math.round(accompVolume * 100)} percent`} onChange={e => onAccompVolume(parseFloat(e.target.value))} />
        </label>

        <label className="field">
          <span>Split Point: {splitPoint} ({['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][splitPoint % 12]}{Math.floor(splitPoint / 12) - 1})</span>
          <input type="range" min={48} max={72} value={splitPoint} aria-label={`Split point MIDI ${splitPoint}`} onChange={e => onSplitPoint(parseInt(e.target.value))} />
        </label>

        <label className="field checkbox">
          <input type="checkbox" checked={singleFingerMode} aria-label="Single-finger chord mode, when on press one key for major chord" onChange={e => onChordMode(e.target.checked)} />
          <span>Single-finger chord mode (C→C Major, D→D Major)</span>
        </label>
      </div>

      <div className="part-volumes" role="group" aria-label="Accompaniment part volumes">
        <h4>Part Volumes</h4>
        <div className="volume-grid">
          {(Object.keys(partVolumes) as Array<keyof PartVolumes>).map(part => (
            <label key={part} className="field">
              <span>{part}: {Math.round(partVolumes[part] * 100)}%</span>
              <input type="range" min={0} max={1} step={0.05} value={partVolumes[part]} aria-label={`${part} volume ${Math.round(partVolumes[part] * 100)} percent`} onChange={e => onPartVolume(part, parseFloat(e.target.value))} />
            </label>
          ))}
        </div>
      </div>

      {currentChordName && <div className="current-chord" role="status" aria-live="polite">Current chord: <strong>{currentChordName}</strong></div>}
    </div>
  );
}

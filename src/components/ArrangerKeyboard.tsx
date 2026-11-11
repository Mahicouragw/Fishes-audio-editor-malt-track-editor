import { useCallback, useEffect, useRef, useState } from 'react';
import { getKeyboardNotes } from '../audio/instruments';
import { detectChord } from '../audio/arranger';
import type { DetectedChord } from '../audio/arranger';

interface Props {
  startOctave: number;
  octaves: number;
  splitPoint: number; // MIDI note where split occurs (left < split <= right)
  singleFingerMode: boolean;
  onLeftChord: (chord: DetectedChord | null, heldNotes: number[]) => void;
  onRightNoteOn: (midi: number, velocity: number) => void;
  onRightNoteOff: (midi: number) => void;
  currentChord?: DetectedChord | null;
  activeNotes?: Set<number>;
}

export function ArrangerKeyboard({ startOctave, octaves, splitPoint, singleFingerMode, onLeftChord, onRightNoteOn, onRightNoteOff, currentChord, activeNotes = new Set() }: Props) {
  const notes = getKeyboardNotes(startOctave, octaves);
  const whiteNotes = notes.filter(n => !n.isBlack);
  const leftHeldRef = useRef<Map<number, number>>(new Map()); // midi -> velocity
  const rightHeldRef = useRef<Set<number>>(new Set());

  const updateLeftChord = useCallback(() => {
    const held = [...leftHeldRef.current.keys()];
    const chord = held.length ? detectChord(held, singleFingerMode) : null;
    onLeftChord(chord, held);
  }, [onLeftChord, singleFingerMode]);

  const handleLeftDown = useCallback((midi: number, vel = 0.8) => {
    leftHeldRef.current.set(midi, vel);
    updateLeftChord();
  }, [updateLeftChord]);

  const handleLeftUp = useCallback((midi: number) => {
    leftHeldRef.current.delete(midi);
    updateLeftChord();
  }, [updateLeftChord]);

  const handleRightDown = useCallback((midi: number, vel = 0.8) => {
    if (rightHeldRef.current.has(midi)) return;
    rightHeldRef.current.add(midi);
    onRightNoteOn(midi, vel);
  }, [onRightNoteOn]);

  const handleRightUp = useCallback((midi: number) => {
    if (!rightHeldRef.current.has(midi)) return;
    rightHeldRef.current.delete(midi);
    onRightNoteOff(midi);
  }, [onRightNoteOff]);

  // Determine if note is left or right
  const isLeft = (midi: number) => midi < splitPoint;
  const isRight = (midi: number) => midi >= splitPoint;

  const [leftChordDisplay, setLeftChordDisplay] = useState<DetectedChord | null>(null);
  useEffect(() => { setLeftChordDisplay(currentChord || null); }, [currentChord]);

  return (
    <div className="arranger-keyboard" role="group" aria-label={`Professional arranger keyboard split at ${splitPoint} (left chord, right melody)`}>
      <div className="arranger-split-label" aria-live="polite">
        <span className="split-left" aria-label="Left-hand chord and accompaniment control">
          🎹 LEFT: Chord ({singleFingerMode ? 'Single-finger' : 'Multi-finger'} {leftChordDisplay ? `— ${leftChordDisplay.name}` : '— play C for C Major'}) — Split at {splitPoint} ({['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][splitPoint%12]}{Math.floor(splitPoint/12)-1})
        </span>
        <span className="split-right" aria-label="Right-hand melody">
          🎼 RIGHT: Melody — play over accompaniment
        </span>
      </div>

      <div className="piano-keyboard arranger" role="list" aria-label="Arranger keyboard with left chord and right melody">
        <div className="white-keys" role="list">
          {whiteNotes.map(note => {
            const left = isLeft(note.midi);
            const isActive = activeNotes.has(note.midi) || leftHeldRef.current.has(note.midi) || rightHeldRef.current.has(note.midi);
            const sectionLabel = left ? 'left chord' : 'right melody';
            return (
              <button
                key={note.midi}
                role="listitem"
                aria-label={`${note.name} ${left ? 'left-hand chord control' : 'right-hand melody'} white key, MIDI ${note.midi}, ${sectionLabel}`}
                aria-pressed={isActive}
                className={`piano-key white-key ${isActive ? 'active' : ''} ${left ? 'left-side' : 'right-side'}`}
                style={{ borderLeft: note.midi === splitPoint ? '3px solid var(--accent)' : undefined }}
                onPointerDown={() => left ? handleLeftDown(note.midi) : handleRightDown(note.midi)}
                onPointerUp={() => left ? handleLeftUp(note.midi) : handleRightUp(note.midi)}
                onPointerLeave={() => left ? handleLeftUp(note.midi) : handleRightUp(note.midi)}
                onTouchStart={(e) => { e.preventDefault(); left ? handleLeftDown(note.midi) : handleRightDown(note.midi); }}
                onTouchEnd={(e) => { e.preventDefault(); left ? handleLeftUp(note.midi) : handleRightUp(note.midi); }}
              >
                <span className="key-label" aria-hidden="true">{note.name}</span>
                {left && leftHeldRef.current.has(note.midi) && <span className="chord-dot" aria-hidden="true">●</span>}
              </button>
            );
          })}
        </div>
        <div className="black-keys">
          {notes.filter(n => n.isBlack).map(note => {
            const left = isLeft(note.midi);
            const isActive = activeNotes.has(note.midi) || leftHeldRef.current.has(note.midi) || rightHeldRef.current.has(note.midi);
            const whiteIndexBefore = whiteNotes.findIndex(w => w.midi > note.midi) - 1;
            return (
              <button
                key={note.midi}
                aria-label={`${note.name} ${left ? 'left chord' : 'right melody'} black key, MIDI ${note.midi}`}
                aria-pressed={isActive}
                className={`piano-key black-key ${isActive ? 'active' : ''} ${left ? 'left-side' : 'right-side'}`}
                style={{ left: `calc(${(whiteIndexBefore + 1) * (100 / whiteNotes.length)}% - 12px)` }}
                onPointerDown={() => left ? handleLeftDown(note.midi) : handleRightDown(note.midi)}
                onPointerUp={() => left ? handleLeftUp(note.midi) : handleRightUp(note.midi)}
                onPointerLeave={() => left ? handleLeftUp(note.midi) : handleRightUp(note.midi)}
                onTouchStart={(e) => { e.preventDefault(); left ? handleLeftDown(note.midi) : handleRightDown(note.midi); }}
                onTouchEnd={(e) => { e.preventDefault(); left ? handleLeftUp(note.midi) : handleRightUp(note.midi); }}
              >
                <span className="key-label" aria-hidden="true">{note.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="chord-display" aria-live="polite" role="status">
        <strong>Chord: {leftChordDisplay ? leftChordDisplay.name : '— (press C on left for C Major)'}</strong>
        {leftChordDisplay && <span> Root {leftChordDisplay.rootName} • Type {leftChordDisplay.type} • Bass MIDI {leftChordDisplay.bassMidi}</span>}
      </div>

      <div className="keyboard-info">
        <span>Split: {splitPoint} | Left: {leftHeldRef.current.size} held | Right active: {rightHeldRef.current.size} | Octaves: {startOctave}-{startOctave + octaves - 1}</span>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState, useRef } from 'react';
import { getKeyboardNotes, midiToNoteName } from '../audio/instruments';

interface Props {
  startOctave: number;
  octaves: number;
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  onSustain?: (on: boolean) => void;
  activeNotes?: Set<number>;
}

export function InstrumentKeyboard({ startOctave, octaves, onNoteOn, onNoteOff, onSustain, activeNotes = new Set() }: Props) {
  const notes = getKeyboardNotes(startOctave, octaves);
  const whiteNotes = notes.filter(n => !n.isBlack);
  const [sustain, setSustain] = useState(false);
  const pressedRef = useRef<Set<number>>(new Set());

  const handlePointerDown = useCallback((midi: number, velocity = 0.8) => {
    if (pressedRef.current.has(midi)) return;
    pressedRef.current.add(midi);
    onNoteOn(midi, velocity);
  }, [onNoteOn]);

  const handlePointerUp = useCallback((midi: number) => {
    if (!pressedRef.current.has(midi)) return;
    pressedRef.current.delete(midi);
    if (!sustain) onNoteOff(midi);
  }, [onNoteOff, sustain]);

  const handleSustain = useCallback((on: boolean) => {
    setSustain(on);
    onSustain?.(on);
    if (!on) {
      // Release all sustained notes
      pressedRef.current.forEach(midi => onNoteOff(midi));
      pressedRef.current.clear();
    }
  }, [onSustain, onNoteOff]);

  // Keyboard support: map computer keys to piano
  useEffect(() => {
    const keyMap: Record<string, number> = {
      'a': 0, 'w': 1, 's': 2, 'e': 3, 'd': 4, 'f': 5, 't': 6, 'g': 7, 'y': 8, 'h': 9, 'u': 10, 'j': 11, 'k': 12
    };
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const offset = keyMap[e.key.toLowerCase()];
      if (offset !== undefined) {
        const midi = 60 + offset; // C4 centered
        handlePointerDown(midi, 0.7);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      const offset = keyMap[e.key.toLowerCase()];
      if (offset !== undefined) {
        const midi = 60 + offset;
        handlePointerUp(midi);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [handlePointerDown, handlePointerUp]);

  return (
    <div className="instrument-keyboard" role="group" aria-label={`Piano keyboard ${startOctave} to ${startOctave + octaves - 1} octaves`}>
      <div className="keyboard-controls">
        <button
          type="button"
          role="switch"
          aria-checked={sustain}
          aria-label="Sustain pedal"
          className={`btn ${sustain ? 'btn-active' : ''}`}
          onClick={() => handleSustain(!sustain)}
          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handleSustain(!sustain); }}}
        >
          Sustain {sustain ? 'ON' : 'OFF'}
        </button>
        <span className="hint" aria-live="polite">Computer keys A-K play C4-C5. Touch/click piano keys. TalkBack: swipe to each key, double-tap to play.</span>
      </div>
      
      <div className="piano-keyboard" role="list" aria-label="Piano keys">
        {/* White keys as base */}
        <div className="white-keys" role="list">
          {whiteNotes.map(note => {
            const isActive = activeNotes.has(note.midi) || pressedRef.current.has(note.midi);
            return (
              <button
                key={note.midi}
                role="listitem"
                aria-label={`${note.name} ${note.isBlack ? 'sharp' : ''} white key, MIDI ${note.midi}`}
                aria-pressed={isActive}
                className={`piano-key white-key ${isActive ? 'active' : ''}`}
                onPointerDown={() => handlePointerDown(note.midi)}
                onPointerUp={() => handlePointerUp(note.midi)}
                onPointerLeave={() => handlePointerUp(note.midi)}
                onTouchStart={(e) => { e.preventDefault(); handlePointerDown(note.midi); }}
                onTouchEnd={(e) => { e.preventDefault(); handlePointerUp(note.midi); }}
                onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handlePointerDown(note.midi); }}}
                onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handlePointerUp(note.midi); }}}
              >
                <span className="key-label" aria-hidden="true">{note.name}</span>
                <span className="sr-only">{note.name}</span>
              </button>
            );
          })}
        </div>
        {/* Black keys positioned over white */}
        <div className="black-keys" aria-hidden="false">
          {notes.filter(n => n.isBlack).map(note => {
            const isActive = activeNotes.has(note.midi) || pressedRef.current.has(note.midi);
            // Calculate left offset: black keys are between white keys
            const whiteIndexBefore = whiteNotes.findIndex(w => w.midi > note.midi) - 1;
            // Simpler: use flex positioning with absolute
            return (
              <button
                key={note.midi}
                aria-label={`${note.name} black key, MIDI ${note.midi}, ${midiToNoteName(note.midi)}`}
                aria-pressed={isActive}
                className={`piano-key black-key ${isActive ? 'active' : ''}`}
                style={{ left: `calc(${(whiteIndexBefore + 1) * (100 / whiteNotes.length)}% - 12px)` }}
                onPointerDown={() => handlePointerDown(note.midi)}
                onPointerUp={() => handlePointerUp(note.midi)}
                onPointerLeave={() => handlePointerUp(note.midi)}
                onTouchStart={(e) => { e.preventDefault(); handlePointerDown(note.midi); }}
                onTouchEnd={(e) => { e.preventDefault(); handlePointerUp(note.midi); }}
              >
                <span className="key-label" aria-hidden="true">{note.name}</span>
              </button>
            );
          })}
        </div>
      </div>
      
      <div className="keyboard-info" aria-live="polite">
        <span>Octave: {startOctave} | Keys: {notes.length} | Active: {activeNotes.size}</span>
      </div>
    </div>
  );
}

// Helper to render a simple accessible note grid for testing
export function NoteGrid({ onPlay }: { onPlay: (midi: number) => void }) {
  const notes = ['C4','D4','E4','F4','G4','A4','B4'].map(n => ({ name: n, midi: 60 + ['C','D','E','F','G','A','B'].indexOf(n[0]) + (parseInt(n[1]) - 4)*12 }));
  return (
    <div role="grid" aria-label="Note grid C4 to B4">
      {notes.map(n => (
        <button key={n.midi} role="gridcell" aria-label={n.name} onClick={() => onPlay(n.midi)} className="btn">
          {n.name}
        </button>
      ))}
    </div>
  );
}

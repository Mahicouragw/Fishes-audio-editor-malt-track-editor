/**
 * Professional Arranger Keyboard Engine — Yamaha PSR-style
 * Split keyboard, chord recognition, automatic accompaniment with real samples
 */

export type ChordType = 'major' | 'minor' | 'dim' | 'aug' | '7' | 'maj7' | 'm7' | 'sus2' | 'sus4' | 'm7b5';
export interface DetectedChord {
  root: number; // MIDI note root (0-11 pitch class)
  rootName: string; // C, C#, D...
  type: ChordType;
  name: string; // C Major, D Minor, etc.
  midiNotes: number[]; // Original MIDI notes that formed it
  bassMidi: number; // Bass note (root, or inversion)
}

// Single-finger mapping: one key → chord (configurable, default major)
const SINGLE_FINGER_MAP: Record<number, { rootOffset: number; type: ChordType }> = {
  // C => C major, D => D major, etc. — user can configure to minor etc via UI
  0: { rootOffset: 0, type: 'major' }, // C
  1: { rootOffset: 1, type: 'major' },
  2: { rootOffset: 2, type: 'major' },
  3: { rootOffset: 3, type: 'major' },
  4: { rootOffset: 4, type: 'major' },
  5: { rootOffset: 5, type: 'major' },
  6: { rootOffset: 6, type: 'major' },
  7: { rootOffset: 7, type: 'major' },
  8: { rootOffset: 8, type: 'major' },
  9: { rootOffset: 9, type: 'major' },
  10: { rootOffset: 10, type: 'major' },
  11: { rootOffset: 11, type: 'major' },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

export function noteName(pc: number): string {
  return NOTE_NAMES[pc];
}

/** Detect chord from held MIDI notes in left hand */
export function detectChord(midiNotes: number[], singleFingerMode = true): DetectedChord | null {
  if (!midiNotes.length) return null;
  const uniquePcs = [...new Set(midiNotes.map(pitchClass))].sort((a, b) => a - b);
  const rootMidi = Math.min(...midiNotes);

  // Single-finger: one note → mapped chord
  if (singleFingerMode && midiNotes.length === 1) {
    const pc = pitchClass(midiNotes[0]);
    const mapping = SINGLE_FINGER_MAP[pc] || { rootOffset: 0, type: 'major' as ChordType };
    const rootPc = (pc + mapping.rootOffset) % 12;
    const type = mapping.type;
    return {
      root: rootPc,
      rootName: noteName(rootPc),
      type,
      name: `${noteName(rootPc)} ${typeLabel(type)}`,
      midiNotes: [...midiNotes],
      bassMidi: midiToBassMidi(rootPc, rootMidi),
    };
  }

  // Multi-finger: interval analysis
  // Try each PC as potential root, score by how well intervals match chord templates
  const templates: Record<ChordType, number[]> = {
    major: [0, 4, 7],
    minor: [0, 3, 7],
    dim: [0, 3, 6],
    aug: [0, 4, 8],
    '7': [0, 4, 7, 10],
    maj7: [0, 4, 7, 11],
    m7: [0, 3, 7, 10],
    m7b5: [0, 3, 6, 10],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
  };

  let best: { root: number; type: ChordType; score: number } | null = null;
  for (const pc of uniquePcs) {
    const intervals = uniquePcs.map(p => (p - pc + 12) % 12).sort((a, b) => a - b);
    for (const [type, template] of Object.entries(templates) as Array<[ChordType, number[]]>) {
      let score = 0;
      for (const iv of template) if (intervals.includes(iv)) score += 2;
      for (const iv of intervals) if (!template.includes(iv)) score -= 0.5;
      // Prefer triads for 3-note chords
      if (intervals.length === 3 && template.length === 3) score += 0.5;
      if (!best || score > best.score) best = { root: pc, type, score };
    }
  }

  if (!best || best.score < 1) {
    // Fallback: treat as major on lowest note
    const pc = pitchClass(rootMidi);
    return {
      root: pc,
      rootName: noteName(pc),
      type: 'major',
      name: `${noteName(pc)} Major (approx)`,
      midiNotes: [...midiNotes],
      bassMidi: midiToBassMidi(pc, rootMidi),
    };
  }

  return {
    root: best.root,
    rootName: noteName(best.root),
    type: best.type,
    name: `${noteName(best.root)} ${typeLabel(best.type)}`,
    midiNotes: [...midiNotes],
    bassMidi: midiToBassMidi(best.root, rootMidi),
  };
}

function typeLabel(t: ChordType): string {
  const map: Record<ChordType, string> = {
    major: 'Major', minor: 'Minor', dim: 'Diminished', aug: 'Augmented',
    '7': '7', maj7: 'Maj7', m7: 'Minor 7', m7b5: 'M7b5', sus2: 'Sus2', sus4: 'Sus4'
  };
  return map[t];
}

function midiToBassMidi(rootPc: number, referenceMidi: number): number {
  // Bass plays root one octave below left hand reference
  const octave = Math.floor(referenceMidi / 12) - 1;
  return Math.max(24, Math.min(48, octave * 12 + rootPc));
}

/** Transpose chord tones to current root */
export function chordTones(chord: DetectedChord): { bass: number; guitar: number[]; piano: number[]; strings: number[] } {
  const root = chord.root;
  const type = chord.type;
  // Define chord tones relative to root
  const intervals: Record<ChordType, number[]> = {
    major: [0, 4, 7, 12],
    minor: [0, 3, 7, 12],
    dim: [0, 3, 6, 12],
    aug: [0, 4, 8, 12],
    '7': [0, 4, 7, 10],
    maj7: [0, 4, 7, 11],
    m7: [0, 3, 7, 10],
    m7b5: [0, 3, 6, 10],
    sus2: [0, 2, 7, 12],
    sus4: [0, 5, 7, 12],
  };
  const base = intervals[type] || intervals.major;
  // Build MIDI notes around appropriate octaves
  const bass = chord.bassMidi;
  const guitar = base.slice(0, 3).map(iv => 48 + ((root + iv) % 12) + Math.floor(48/12)*12); // Actually compute correctly
  // Simpler: generate around C3-C5
  const pcToMidi = (pcOffset: number, octave: number) => octave * 12 + ((root + pcOffset) % 12);
  return {
    bass,
    guitar: base.slice(0, 3).map(iv => pcToMidi(iv, 4)), // Guitar around G2-C4
    piano: base.map(iv => pcToMidi(iv, 5)), // Piano comp around C4
    strings: base.slice(0, 3).map(iv => pcToMidi(iv, 5)), // Strings slightly higher
  };
}

// Styles
export type StyleName = 'worship' | 'gospel' | 'pop' | 'rock' | 'ballad' | 'country' | 'jazz' | 'classical' | 'slow-worship' | 'contemporary-worship' | 'cinematic' | 'acoustic' | 'piano-ballad' | 'soft-rock';
export const STYLES: Array<{ id: StyleName; name: string; description: string; tempo: number; timeSig: string }> = [
  { id: 'worship', name: 'Worship', description: 'Warm pad, gentle drums, piano-led', tempo: 78, timeSig: '4/4' },
  { id: 'gospel', name: 'Gospel', description: 'Swing, organ, powerful bass', tempo: 92, timeSig: '4/4' },
  { id: 'pop', name: 'Pop', description: 'Bright drums, electric bass, guitars', tempo: 100, timeSig: '4/4' },
  { id: 'rock', name: 'Rock', description: 'Driving kit, distorted guitar, synth', tempo: 120, timeSig: '4/4' },
  { id: 'ballad', name: 'Ballad', description: 'Soft drums, strings, piano', tempo: 68, timeSig: '4/4' },
  { id: 'country', name: 'Country', description: 'Acoustic guitar, brushed drums', tempo: 88, timeSig: '4/4' },
  { id: 'jazz', name: 'Jazz', description: 'Brush kit, upright bass, piano', tempo: 110, timeSig: '4/4' },
  { id: 'classical', name: 'Classical', description: 'Orchestral strings, organ, timpani', tempo: 72, timeSig: '4/4' },
  { id: 'slow-worship', name: 'Slow Worship', description: 'Intimate pad, soft piano, swell', tempo: 62, timeSig: '4/4' },
  { id: 'contemporary-worship', name: 'Contemporary Worship', description: 'Modern pad, electric guitar, dance kit', tempo: 84, timeSig: '4/4' },
  { id: 'cinematic', name: 'Cinematic', description: 'Epic strings, brass, thunderous drums', tempo: 76, timeSig: '4/4' },
  { id: 'acoustic', name: 'Acoustic', description: 'Fingerpicked guitar, light percussion', tempo: 90, timeSig: '4/4' },
  { id: 'piano-ballad', name: 'Piano Ballad', description: 'Solo piano with string pad', tempo: 64, timeSig: '4/4' },
  { id: 'soft-rock', name: 'Soft Rock', description: 'Clean guitar, steady drums, pad', tempo: 96, timeSig: '4/4' },
];

export type Section = 'intro1' | 'intro2' | 'intro3' | 'mainA' | 'mainB' | 'mainC' | 'mainD' | 'fillA' | 'fillB' | 'fillC' | 'fillD' | 'break' | 'ending1' | 'ending2' | 'ending3';

export const SECTIONS: Array<{ id: Section; name: string; type: 'intro' | 'main' | 'fill' | 'break' | 'ending' }> = [
  { id: 'intro1', name: 'Intro 1', type: 'intro' },
  { id: 'intro2', name: 'Intro 2', type: 'intro' },
  { id: 'intro3', name: 'Intro 3', type: 'intro' },
  { id: 'mainA', name: 'Main A', type: 'main' },
  { id: 'mainB', name: 'Main B', type: 'main' },
  { id: 'mainC', name: 'Main C', type: 'main' },
  { id: 'mainD', name: 'Main D', type: 'main' },
  { id: 'fillA', name: 'Fill In A', type: 'fill' },
  { id: 'fillB', name: 'Fill In B', type: 'fill' },
  { id: 'fillC', name: 'Fill In C', type: 'fill' },
  { id: 'fillD', name: 'Fill In D', type: 'fill' },
  { id: 'break', name: 'Break', type: 'break' },
  { id: 'ending1', name: 'Ending 1', type: 'ending' },
  { id: 'ending2', name: 'Ending 2', type: 'ending' },
  { id: 'ending3', name: 'Ending 3', type: 'ending' },
];

// Accompaniment pattern: per-step (16 steps per 4/4 bar) define which parts play
export interface PatternStep {
  drums?: Array<'kick' | 'snare' | 'hihat' | 'crash' | 'ride'>;
  bass?: number; // Index into chordTones.bass offset (0=root, 1=third, etc.)
  guitar?: number[]; // Indexes for strum
  piano?: number[];
  strings?: number[];
  brass?: number[];
}

export type Pattern = PatternStep[]; // 16 steps

// Define style patterns — properly arranged instrument patterns
const STYLE_PATTERNS: Record<StyleName, Record<Section, Pattern>> = {} as any;

// Helper to create patterns
function emptyPattern(): Pattern { return Array.from({ length: 16 }, () => ({})); }

// Worship: gentle, piano-led, worship pad
function worshipPatterns(): Record<Section, Pattern> {
  const mainA = emptyPattern();
  mainA[0] = { drums: ['kick'], bass: 0, piano: [0, 1], strings: [0] };
  mainA[4] = { drums: ['hihat'], bass: 0, guitar: [0] };
  mainA[8] = { drums: ['kick', 'hihat'], bass: 1, piano: [1, 2] };
  mainA[12] = { drums: ['hihat'], strings: [1] };
  const mainB = [...mainA]; mainB[2] = { drums: ['snare'], bass: 0 }; mainB[6] = { drums: ['kick'] };
  const fillA = emptyPattern(); fillA[0] = { drums: ['snare'] }; fillA[4] = { drums: ['kick', 'crash'] }; fillA[8] = { drums: ['snare'] }; fillA[12] = { drums: ['kick'] };
  const intro1 = [...mainA]; intro1[0].strings = [0, 1, 2];
  const ending1 = emptyPattern(); ending1[0] = { drums: ['crash'], bass: 0, piano: [0], strings: [0] }; ending1[8] = { drums: ['crash'] };
  const result: any = {};
  for (const s of SECTIONS) {
    if (s.id === 'mainA') result[s.id] = mainA;
    else if (s.id === 'mainB') result[s.id] = mainB;
    else if (s.id.startsWith('fill')) result[s.id] = fillA;
    else if (s.id.startsWith('intro')) result[s.id] = intro1;
    else if (s.id.startsWith('ending')) result[s.id] = ending1;
    else if (s.id === 'break') result[s.id] = emptyPattern();
    else result[s.id] = mainA;
  }
  return result;
}

// Pop: bright
function popPatterns(): Record<Section, Pattern> {
  const mainA = emptyPattern();
  mainA[0] = { drums: ['kick'], bass: 0, guitar: [0, 1], piano: [0] };
  mainA[4] = { drums: ['snare', 'hihat'], bass: 0 };
  mainA[8] = { drums: ['kick', 'hihat'], bass: 1, guitar: [1, 2] };
  mainA[10] = { drums: ['hihat'] };
  mainA[12] = { drums: ['snare', 'hihat'], piano: [1] };
  const mainB = emptyPattern(); Object.assign(mainB, [...mainA]); mainB[2] = { drums: ['kick'] }; mainB[6] = { drums: ['snare'] };
  const fill = emptyPattern(); fill[0] = { drums: ['snare', 'crash'] }; fill[4] = { drums: ['kick'] }; fill[8] = { drums: ['snare'] }; fill[12] = { drums: ['kick', 'crash'] };
  const intro = [...mainA]; intro[0].brass = [0];
  const ending = emptyPattern(); ending[0] = { drums: ['crash'], bass: 0, guitar: [0], strings: [0] };
  const result: any = {};
  for (const s of SECTIONS) {
    if (s.id === 'mainA') result[s.id] = mainA;
    else if (s.id === 'mainB') result[s.id] = mainB;
    else if (s.id.startsWith('fill')) result[s.id] = fill;
    else if (s.id.startsWith('intro')) result[s.id] = intro;
    else if (s.id.startsWith('ending')) result[s.id] = ending;
    else if (s.id === 'break') result[s.id] = emptyPattern();
    else result[s.id] = mainA;
  }
  return result;
}

// Generic fallback for other styles
function genericPattern(): Record<Section, Pattern> {
  const base = emptyPattern();
  base[0] = { drums: ['kick'], bass: 0, piano: [0] };
  base[4] = { drums: ['snare'] };
  base[8] = { drums: ['kick'], bass: 1 };
  base[12] = { drums: ['snare', 'hihat'] };
  const fill = emptyPattern(); fill[0] = { drums: ['snare'] }; fill[8] = { drums: ['kick'] };
  const intro = [...base]; intro[0].strings = [0];
  const ending = emptyPattern(); ending[0] = { drums: ['crash'], bass: 0 };
  const result: any = {};
  for (const s of SECTIONS) {
    if (s.id.startsWith('fill')) result[s.id] = fill;
    else if (s.id.startsWith('intro')) result[s.id] = intro;
    else if (s.id.startsWith('ending')) result[s.id] = ending;
    else if (s.id === 'break') result[s.id] = emptyPattern();
    else result[s.id] = base;
  }
  return result;
}

// Initialize all styles
for (const style of STYLES) {
  if (style.id === 'worship' || style.id === 'slow-worship') STYLE_PATTERNS[style.id] = worshipPatterns();
  else if (style.id === 'pop' || style.id === 'contemporary-worship') STYLE_PATTERNS[style.id] = popPatterns();
  else STYLE_PATTERNS[style.id] = genericPattern();
}

export function getPattern(style: StyleName, section: Section): Pattern {
  return STYLE_PATTERNS[style]?.[section] || genericPattern()['mainA'];
}

export function nextMainAfterFill(currentMain: Section): Section {
  // After fill, return to the main that fill belonged to
  if (currentMain.startsWith('fill')) {
    const letter = currentMain.slice(-1);
    return `main${letter.toUpperCase()}` as Section;
  }
  return currentMain;
}

// Part volumes
export interface PartVolumes {
  drums: number;
  bass: number;
  guitar: number;
  strings: number;
  piano: number;
  brass: number;
  organ: number;
  percussion: number;
}

export const DEFAULT_VOLUMES: PartVolumes = {
  drums: 0.85, bass: 0.9, guitar: 0.75, strings: 0.7, piano: 0.8, brass: 0.7, organ: 0.6, percussion: 0.6,
};

// Transpose helper
export function transposeChord(chord: DetectedChord, semitones: number): DetectedChord {
  const newRoot = (chord.root + semitones + 12) % 12;
  return {
    ...chord,
    root: newRoot,
    rootName: noteName(newRoot),
    name: `${noteName(newRoot)} ${chord.type}`,
    bassMidi: chord.bassMidi + semitones,
  };
}

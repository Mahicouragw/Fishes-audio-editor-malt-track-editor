import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioData } from '../types';
import {
  defaultAppSettings, defaultExportSettings, defaultVocalState, makeId,
  type AppSettings, type Clip, type HarmonyKey, type HarmonyLayer, type HarmonyRange, type HarmonyScale, type HarmonyScope, type Project, type RangeEffect, type RecordingTake, type Track, type VocalState,
} from '../types';
import * as db from '../storage/db';
import { cacheAudioData, evictAudioData, loadAudioData, storeAudioData, storeBlob } from '../storage/assets';
import { audioData } from '../audio/dsp';
import { audioDataToWavBlob } from '../audio/decode';

export function createEmptyProject(title = 'Untitled Project'): Project {
  return {
    id: makeId('project'),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tracks: [
      { id: makeId('track'), name: 'Voice 1', volume: 1, pan: 0, muted: false, solo: false, pitchSemis: 0, pitchFineCents: 0, clips: [], vocal: defaultVocalState() },
      { id: makeId('track'), name: 'Voice 2', volume: 1, pan: 0, muted: false, solo: false, pitchSemis: 0, pitchFineCents: 0, clips: [], vocal: defaultVocalState() },
    ],
    harmonies: [],
    harmonyRanges: [],
    harmonyKey: 'C',
    harmonyScale: 'major',
    selection: null,
    selectedTrackId: null,
    selectedClipId: null,
    zoom: 1,
    recordings: [],
    media: [],
    exportSettings: defaultExportSettings(),
  };
}

function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}

/**
 * Fill in fields added after a project was saved, so reopening an older
 * project never crashes on a missing harmony property.
 */
export function normalizeProject(project: Project): Project {
  const harmonies = (project.harmonies ?? []).map((layer) => ({
    ...layer,
    solo: layer.solo ?? false,
    offsetSeconds: layer.offsetSeconds ?? 0,
    effects: layer.effects ?? [],
    scope: layer.scope ?? 'entire-song',
    ranges: layer.ranges ?? undefined,
    vocalsOnly: layer.vocalsOnly ?? false,
    gain: typeof layer.gain === 'number' ? layer.gain : 1,
    pan: typeof layer.pan === 'number' ? layer.pan : 0,
    detuneCents: layer.detuneCents ?? 0,
    clipDuration: layer.clipDuration ?? undefined,
    muted: layer.muted ?? false,
    // A legacy layer with rendered audio is not the +0 reference voice.
    originalVoice: layer.originalVoice ?? (layer.semitones === 0 && !layer.clipId),
  }));
  const tracks = (project.tracks ?? []).map((track) => ({
    ...track,
    clips: (track.clips ?? []).map((clip) => ({
      ...clip,
      effects: clip.effects ?? [],
      gain: typeof clip.gain === 'number' ? clip.gain : 1,
      fadeIn: clip.fadeIn ?? 0,
      fadeOut: clip.fadeOut ?? 0,
      sourceStart: clip.sourceStart ?? 0,
      pan: typeof clip.pan === 'number' ? clip.pan : undefined,
    })),
    vocal: { ...defaultVocalState(), ...(track.vocal ?? {}) },
    pitchSemis: track.pitchSemis ?? 0,
    pitchFineCents: track.pitchFineCents ?? 0,
    volume: typeof track.volume === 'number' ? track.volume : 1,
    pan: typeof track.pan === 'number' ? track.pan : 0,
  }));
  return {
    ...project,
    harmonies,
    tracks,
    harmonyRanges: (project.harmonyRanges ?? []).map((range, index) => ({
      id: range.id ?? makeId('range'),
      start: Number.isFinite(range.start) ? range.start : 0,
      end: Number.isFinite(range.end) ? range.end : 0,
      enabled: range.enabled ?? true,
      label: range.label ?? `Range ${index + 1}`,
    })),
    harmonyKey: project.harmonyKey ?? 'C',
    harmonyScale: project.harmonyScale ?? 'major',
    media: project.media ?? [],
    recordings: project.recordings ?? [],
    selection: project.selection ?? null,
  };
}

export function makeTrack(name: string): Track {
  return {
    id: makeId('track'),
    name,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    pitchSemis: 0,
    pitchFineCents: 0,
    clips: [],
    vocal: defaultVocalState(),
  };
}

export function makeClip(assetId: string, name: string, start: number, duration: number): Clip {
  return {
    id: makeId('clip'),
    assetId,
    name,
    start,
    sourceStart: 0,
    duration,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    effects: [],
  };
}

/**
 * One harmonization voice handed to the store. The audio is already rendered
 * by the DSP layer; the store only wires it onto a track.
 */
export interface HarmonyGroupVoice {
  name: string;
  semitones: number;
  gain: number;
  muted: boolean;
  solo: boolean;
  vocalsOnly: boolean;
  offsetSeconds: number;
  /** Stereo position, -1…+1 (defaults to centre). */
  pan?: number;
  effects: RangeEffect[];
  scope: HarmonyScope;
  rangeStart?: number;
  rangeEnd?: number;
  ranges?: Array<{ start: number; end: number }>;
  targetTrackId: string;
  /** Omitted for the +0 original voice, which reuses the source audio. */
  clip?: { assetId: string; start: number; duration: number; size: number; fullDuration?: number };
}

export interface UseProjectOptions {
  autosave?: boolean;
}

export function useProjectStore(options: UseProjectOptions = {}) {
  const [project, setProjectState] = useState<Project>(() => createEmptyProject());
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings());
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const history = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  // Slider drags (volume, pan, delay) must not create dozens of undo steps:
  // consecutive edits of the same control within a short window coalesce into
  // one history entry.
  const lastHistory = useRef<{ key: string; time: number } | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectRef = useRef(project);

  // Keep the ref in sync so event handlers always see the latest project
  // without stale closures — and history is pushed OUTSIDE of setState
  // updaters (StrictMode calls updaters twice; side effects there corrupt
  // undo history).
  const commit = useCallback((next: Project) => {
    projectRef.current = next;
    setProjectState(next);
  }, []);

  const refreshProjects = useCallback(async () => {
    const all = await db.listProjects().catch(() => [] as Project[]);
    setProjects(all);
  }, []);

  const refreshSettings = useCallback(async () => {
    const loaded = await db.loadSettings().catch(() => null);
    if (loaded) setSettings(loaded);
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([refreshProjects(), refreshSettings()]);
      setLoading(false);
    })();
  }, [refreshProjects, refreshSettings]);

  const announce = useCallback((message: string) => {
    setAnnouncement(message);
    // Clear after a tick so repeated identical messages re-announce
    setTimeout(() => setAnnouncement(''), 800);
  }, []);

  const pushHistory = useCallback((previous: Project, coalesceKey?: string) => {
    const now = Date.now();
    const previousEntry = lastHistory.current;
    if (coalesceKey && previousEntry && previousEntry.key === coalesceKey && now - previousEntry.time < 900) {
      lastHistory.current = { key: coalesceKey, time: now };
      future.current = [];
      return;
    }
    history.current.push(cloneProject(previous));
    if (history.current.length > 60) history.current.shift();
    lastHistory.current = coalesceKey ? { key: coalesceKey, time: now } : null;
    future.current = [];
  }, []);

  const scheduleAutosave = useCallback((next: Project) => {
    if (options.autosave === false) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      db.saveProject(next)
        .then(() => db.saveHistory(next.id, history.current, future.current))
        .then(() => refreshProjects())
        .catch(() => announce('Autosave failed — storage may be full. Export or delete projects to free space.'));
    }, 900);
  }, [announce, options.autosave, refreshProjects]);

  const updateProject = useCallback((updater: (p: Project) => Project, saveHistory = true, coalesceKey?: string) => {
    const prev = projectRef.current;
    const next = updater(cloneProject(prev));
    next.updatedAt = Date.now();
    if (saveHistory && next !== prev) pushHistory(prev, coalesceKey);
    commit(next);
    scheduleAutosave(next);
    return next;
  }, [commit, pushHistory, scheduleAutosave]);

  // View-only changes (selection, zoom, track selection) don't create history
  // entries and don't autosave on their own.
  const updateView = useCallback((patch: Partial<Project>) => {
    const prev = projectRef.current;
    commit({ ...prev, ...patch });
  }, [commit]);

  const save = useCallback(async () => {
    const current = projectRef.current;
    try {
      await db.saveProject(current);
      await db.saveHistory(current.id, history.current, future.current);
    } catch (error) {
      announce(isQuotaError(error) ? 'Save failed: browser storage is full.' : `Save failed: ${(error as Error).message}`);
      throw error;
    }
    await refreshProjects();
    announce(`Project ${current.title} saved`);
  }, [announce, refreshProjects]);

  const saveAs = useCallback(async (title: string) => {
    const next: Project = { ...cloneProject(projectRef.current), id: makeId('project'), title, createdAt: Date.now(), updatedAt: Date.now() };
    await db.saveProject(next);
    await db.saveHistory(next.id, history.current, future.current);
    commit(next);
    await refreshProjects();
    announce(`Saved as ${title}`);
  }, [announce, commit, refreshProjects]);

  const openProject = useCallback(async (id: string) => {
    const found = await db.getProject(id);
    if (!found) throw new Error('Project not found');
    // Undo history belongs to the project: restore it so a reopened project
    // can still be undone (and redone) in order.
    const stored = await db.getHistory(id).catch(() => null);
    history.current = (stored?.past ?? []).map((entry) => normalizeProject(entry));
    future.current = (stored?.future ?? []).map((entry) => normalizeProject(entry));
    lastHistory.current = null;
    commit(normalizeProject(found));
    announce(`Opened ${found.title}`);
  }, [announce, commit]);

  const newProject = useCallback(async (title?: string) => {
    const next = createEmptyProject(title);
    history.current = [];
    future.current = [];
    lastHistory.current = null;
    commit(next);
    await db.saveProject(next);
    await refreshProjects();
    announce(`Created ${next.title}`);
    return next.id;
  }, [announce, commit, refreshProjects]);

  const deleteProject = useCallback(async (id: string) => {
    await db.deleteProject(id);
    await db.deleteHistory(id).catch(() => undefined);
    await refreshProjects();
    announce('Project deleted');
  }, [announce, refreshProjects]);

  const renameProject = useCallback(async (id: string, title: string) => {
    const found = await db.getProject(id);
    if (!found) throw new Error('Project not found');
    const next: Project = { ...cloneProject(found), title: title.trim() || found.title, updatedAt: Date.now() };
    await db.saveProject(next);
    if (projectRef.current.id === id) commit(next);
    await refreshProjects();
    announce(`Renamed to ${next.title}`);
  }, [announce, commit, refreshProjects]);

  const duplicateProject = useCallback(async (id: string) => {
    const copy = await db.duplicateProject(id, `${(await db.getProject(id))?.title ?? 'Project'} copy`);
    await refreshProjects();
    announce(`Duplicated as ${copy.title}`);
    return copy.id;
  }, [announce, refreshProjects]);

  // Undo reverts editing state but preserves the current view (selection,
  // selected track/clip, zoom) — like a DAW, undo does not jump your cursor.
  const restoreKeepingView = (restored: Project) => {
    const current = projectRef.current;
    return {
      ...restored,
      selection: current.selection,
      selectedTrackId: current.selectedTrackId,
      selectedClipId: current.selectedClipId,
      zoom: current.zoom,
    };
  };

  const undo = useCallback(() => {
    lastHistory.current = null;
    const previous = history.current.pop();
    if (!previous) return;
    const current = projectRef.current;
    future.current.push(cloneProject(current));
    commit(restoreKeepingView(previous));
    announce('Undone');
  }, [announce, commit]);

  const redo = useCallback(() => {
    lastHistory.current = null;
    const next = future.current.pop();
    if (!next) return;
    const current = projectRef.current;
    history.current.push(cloneProject(current));
    commit(restoreKeepingView(next));
    announce('Redone');
  }, [announce, commit]);

  const canUndo = history.current.length > 0;
  const canRedo = future.current.length > 0;

  // Track helpers
  const addTrack = useCallback((name?: string) => {
    updateProject((p) => {
      const count = p.tracks.length + 1;
      p.tracks.push(makeTrack(name ?? `Voice ${count}`));
      return p;
    });
    announce('Track added');
  }, [announce, updateProject]);

  const renameTrack = useCallback((trackId: string, name: string) => {
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.name = name.trim() || track.name;
      return p;
    });
  }, [updateProject]);

  const duplicateTrack = useCallback((trackId: string) => {
    updateProject((p) => {
      const index = p.tracks.findIndex((t) => t.id === trackId);
      if (index < 0) return p;
      const source = p.tracks[index];
      const copy = cloneProject(source as unknown as Project) as unknown as Track;
      copy.id = makeId('track');
      copy.name = `${source.name} copy`;
      copy.clips = source.clips.map((c) => ({ ...c, id: makeId('clip') }));
      p.tracks.splice(index + 1, 0, copy);
      return p;
    });
    announce('Track duplicated');
  }, [announce, updateProject]);

  /**
   * Duplicate a track without any processing: same audio, original pitch, no
   * effects. This is the "double the lead vocal" action — the copy can then be
   * panned, delayed and levelled independently.
   */
  const duplicateOriginalTrack = useCallback((trackId: string) => {
    updateProject((p) => {
      const index = p.tracks.findIndex((t) => t.id === trackId);
      if (index < 0) return p;
      const source = p.tracks[index];
      const copy: Track = {
        ...cloneProject(source as unknown as Project) as unknown as Track,
        id: makeId('track'),
        name: `${source.name} double`,
        pan: source.pan ?? 0,
        muted: false,
        solo: false,
        pitchSemis: 0,
        pitchFineCents: 0,
        vocal: defaultVocalState(),
        clips: source.clips.map((clip) => ({
          ...clip,
          id: makeId('clip'),
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          effects: [],
          pan: undefined,
        })) as Clip[],
      };
      p.tracks.splice(index + 1, 0, copy);
      return p;
    });
    announce('Original track duplicated at original pitch');
  }, [announce, updateProject]);

  const deleteTrack = useCallback((trackId: string) => {
    updateProject((p) => {
      p.tracks = p.tracks.filter((t) => t.id !== trackId);
      if (p.selectedTrackId === trackId) p.selectedTrackId = p.tracks[0]?.id ?? null;
      const removedClipIds = new Set(p.harmonies.filter((h) => h.sourceTrackId === trackId || h.targetTrackId === trackId).map((h) => h.clipId).filter(Boolean));
      p.harmonies = p.harmonies.filter((h) => h.sourceTrackId !== trackId && h.targetTrackId !== trackId);
      for (const track of p.tracks) {
        track.clips = track.clips.filter((c) => !removedClipIds.has(c.id));
      }
      return p;
    });
    announce('Track deleted');
  }, [announce, updateProject]);

  const setTrackVolume = useCallback((trackId: string, volume: number) => {
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.volume = Math.max(0, Math.min(2, volume));
      return p;
    }, true, `volume:${trackId}`);
  }, [updateProject]);

  /**
   * Set a track's pan. Clips that had their own pan override follow the track
   * again, so the slider really moves everything on that track.
   */
  const setTrackPan = useCallback((trackId: string, pan: number) => {
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track) return p;
      track.pan = Math.max(-1, Math.min(1, pan));
      for (const clip of track.clips) delete clip.pan;
      return p;
    }, true, `pan:${trackId}`);
  }, [updateProject]);

  /** Independent pan for one clip (used by each harmony voice row). */
  const setClipPan = useCallback((clipId: string, pan: number) => {
    updateProject((p) => {
      for (const track of p.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) clip.pan = Math.max(-1, Math.min(1, pan));
      }
      return p;
    }, true, `clipPan:${clipId}`);
  }, [updateProject]);

  const toggleMute = useCallback((trackId: string) => {
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.muted = !track.muted;
      return p;
    });
  }, [updateProject]);

  const toggleSolo = useCallback((trackId: string) => {
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.solo = !track.solo;
      return p;
    });
  }, [updateProject]);

  const selectTrack = useCallback((trackId: string) => {
    updateView({ selectedTrackId: trackId });
    const track = projectRef.current.tracks.find((t) => t.id === trackId);
    if (track) announce(`Selected ${track.name}`);
  }, [announce, updateView]);

  const selectClip = useCallback((clipId: string | null) => {
    updateView({ selectedClipId: clipId });
  }, [updateView]);

  const setTrackPitch = useCallback((trackId: string, semitones: number, cents = 0) => {
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) { track.pitchSemis = semitones; track.pitchFineCents = cents; }
      return p;
    });
  }, [updateProject]);

  const setVocalState = useCallback((trackId: string, patch: Partial<VocalState>) => {
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.vocal = { ...track.vocal, ...patch };
      return p;
    }, patch.enabled === undefined); // toggling the switch alone is not an undo step
  }, [updateProject]);

  // Clip helpers
  const addClip = useCallback(async (
    trackId: string,
    data: AudioData,
    name: string,
    start?: number,
    opts: { recording?: boolean } = {},
  ): Promise<string> => {
    const asset = await storeAudioData(data, name, opts.recording ? 'recording' : 'audio');
    cacheAudioData(asset.id, data);
    let clipId = '';
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track) return p;
      const duration = data.length / data.sampleRate;
      const at = start ?? p.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)).reduce((m, v) => Math.max(m, v), 0);
      const clip = makeClip(asset.id, name, at, duration);
      clipId = clip.id;
      track.clips.push(clip);
      p.media.push({ assetId: asset.id, name, mime: asset.mime, size: asset.size, kind: opts.recording ? 'recording' : 'audio', createdAt: Date.now() });
      if (opts.recording) {
        // The take id doubles as the clip id so takes can be deleted cleanly.
        const take: RecordingTake = {
          id: clip.id,
          assetId: asset.id,
          name,
          trackId,
          start: at,
          duration,
          createdAt: Date.now(),
        };
        p.recordings.push(take);
      }
      return p;
    });
    announce(`Added ${name}`);
    return asset.id;
  }, [announce, updateProject]);

  const updateClip = useCallback((clipId: string, patch: Partial<Clip>) => {
    updateProject((p) => {
      for (const track of p.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { Object.assign(clip, patch); break; }
      }
      return p;
    });
  }, [updateProject]);

  const deleteClip = useCallback((clipId: string) => {
    updateProject((p) => {
      for (const track of p.tracks) track.clips = track.clips.filter((c) => c.id !== clipId);
      p.harmonies = p.harmonies.filter((h) => h.clipId !== clipId);
      p.recordings = p.recordings.filter((r) => r.id !== clipId);
      if (p.selectedClipId === clipId) p.selectedClipId = null;
      return p;
    });
    announce('Clip deleted');
  }, [announce, updateProject]);

  const splitClip = useCallback((clipId: string, atSeconds: number) => {
    updateProject((p) => {
      for (const track of p.tracks) {
        const index = track.clips.findIndex((c) => c.id === clipId);
        if (index < 0) continue;
        const clip = track.clips[index];
        const offset = atSeconds - clip.start;
        if (offset <= 0.01 || offset >= clip.duration - 0.01) return p;
        const left: Clip = { ...clip, duration: offset };
        const right: Clip = { ...clip, id: makeId('clip'), start: clip.start + offset, sourceStart: clip.sourceStart + offset, duration: clip.duration - offset };
        track.clips.splice(index, 1, left, right);
        break;
      }
      return p;
    });
    announce('Clip split');
  }, [announce, updateProject]);

  const trimClip = useCallback((clipId: string, start: number, duration: number) => {
    updateProject((p) => {
      for (const track of p.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          const delta = start - clip.start;
          clip.start = Math.max(0, start);
          clip.sourceStart = Math.max(0, clip.sourceStart + delta);
          clip.duration = Math.max(0.01, duration);
          break;
        }
      }
      return p;
    });
  }, [updateProject]);

  // Harmony — real shifted-signal layers managed independently
  const addHarmony = useCallback(async (sourceTrackId: string, targetTrackId: string, semitones: number, data: AudioData) => {
    const asset = await storeAudioData(data, `Harmony ${semitones >= 0 ? '+' : ''}${semitones}`, 'processed');
    cacheAudioData(asset.id, data);
    let harmonyId = '';
    updateProject((p) => {
      const target = p.tracks.find((t) => t.id === targetTrackId);
      if (!target) return p;
      const source = p.tracks.find((t) => t.id === sourceTrackId);
      const sourceClip = source?.clips[0];
      const clip = makeClip(asset.id, `Harmony ${semitones >= 0 ? '+' : ''}${semitones}`, sourceClip?.start ?? 0, data.length / data.sampleRate);
      target.clips.push(clip);
      p.media.push({ assetId: asset.id, name: clip.name, mime: asset.mime, size: asset.size, kind: 'processed', createdAt: Date.now() });
      const harmony: HarmonyLayer = {
        id: makeId('harmony'),
        name: clip.name,
        sourceTrackId,
        targetTrackId,
        clipId: clip.id,
        semitones,
        gain: 0.9,
        muted: false,
        solo: false,
        vocalsOnly: false,
        offsetSeconds: 0,
        effects: [],
        scope: 'entire-song',
        originalVoice: false,
      };
      harmonyId = harmony.id;
      p.harmonies.push(harmony);
      return p;
    });
    announce(`Harmony ${semitones >= 0 ? '+' : ''}${semitones} created`);
    return harmonyId;
  }, [announce, updateProject]);

  /**
   * Make sure the named tracks exist, creating the missing ones in a single
   * undoable step. Used to give harmony voices real Voice 2/3/4 targets.
   */
  const ensureTracks = useCallback((names: string[]): string[] => {
    const ids: string[] = [];
    updateProject((p) => {
      for (const name of names) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        const existing = p.tracks.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
        if (existing) {
          ids.push(existing.id);
          continue;
        }
        const track = makeTrack(trimmed);
        p.tracks.push(track);
        ids.push(track.id);
      }
      return p;
    });
    return ids;
  }, [updateProject]);

  /**
   * Replace one harmonization group with a new set of voices as a single
   * undoable change. Every voice already carries its rendered audio.
   */
  const applyHarmonyGroup = useCallback((
    groupId: string,
    sourceTrackId: string,
    voices: HarmonyGroupVoice[],
  ) => {
    updateProject((p) => {
      const previous = p.harmonies.filter((h) => h.groupId === groupId);
      for (const layer of previous) {
        for (const track of p.tracks) track.clips = track.clips.filter((c) => c.id !== layer.clipId);
      }
      p.harmonies = p.harmonies.filter((h) => h.groupId !== groupId);
      for (const voice of voices) {
        if (!voice.clip) {
          // The +0 original voice: it reuses the source track's own audio, so
          // no duplicated audio is stored.
          p.harmonies.push({
            id: makeId('harmony'),
            name: voice.name,
            sourceTrackId,
            targetTrackId: voice.targetTrackId,
            semitones: voice.semitones,
            gain: voice.gain,
            muted: voice.muted,
            solo: voice.solo,
            vocalsOnly: voice.vocalsOnly,
            offsetSeconds: voice.offsetSeconds,
            pan: voice.pan ?? 0,
            effects: voice.effects,
            scope: voice.scope,
            rangeStart: voice.rangeStart,
            rangeEnd: voice.rangeEnd,
            ranges: voice.ranges,
            originalVoice: true,
            groupId,
          });
          continue;
        }
        const target = p.tracks.find((t) => t.id === voice.targetTrackId);
        if (!target) continue;
        const clip = makeClip(voice.clip.assetId, voice.name, voice.clip.start, voice.clip.duration);
        clip.pan = voice.pan ?? 0;
        target.clips.push(clip);
        p.media.push({
          assetId: voice.clip.assetId,
          name: voice.name,
          mime: 'audio/wav',
          size: voice.clip.size,
          kind: 'processed',
          createdAt: Date.now(),
        });
        p.harmonies.push({
          id: makeId('harmony'),
          name: voice.name,
          sourceTrackId,
          targetTrackId: voice.targetTrackId,
          clipId: clip.id,
          semitones: voice.semitones,
          gain: voice.gain,
          muted: voice.muted,
          solo: voice.solo,
          vocalsOnly: voice.vocalsOnly,
          offsetSeconds: voice.offsetSeconds,
          pan: voice.pan ?? 0,
          clipDuration: voice.clip?.fullDuration ?? voice.clip?.duration,
          effects: voice.effects,
          scope: voice.scope,
          rangeStart: voice.rangeStart,
          rangeEnd: voice.rangeEnd,
          ranges: voice.ranges,
          originalVoice: false,
          groupId,
        });
      }
      return p;
    });
  }, [updateProject]);

  /** Drop every layer of a harmonization group (the "cancel" path). */
  const removeHarmonyGroup = useCallback((groupId: string) => {
    updateProject((p) => {
      const removed = p.harmonies.filter((h) => h.groupId === groupId);
      for (const layer of removed) {
        for (const track of p.tracks) track.clips = track.clips.filter((c) => c.id !== layer.clipId);
      }
      p.harmonies = p.harmonies.filter((h) => h.groupId !== groupId);
      return p;
    });
    announce('Harmony voices removed');
  }, [announce, updateProject]);

  const updateHarmony = useCallback((harmonyId: string, patch: Partial<HarmonyLayer>) => {
    const slider = typeof patch.gain === 'number' || typeof patch.pan === 'number' || typeof patch.offsetSeconds === 'number';
    const field = typeof patch.gain === 'number' ? 'gain' : typeof patch.pan === 'number' ? 'pan' : 'offset';
    updateProject((p) => {
      const layer = p.harmonies.find((h) => h.id === harmonyId);
      if (layer) Object.assign(layer, patch);
      return p;
    }, true, slider ? `harmony:${harmonyId}:${field}` : undefined);
  }, [updateProject]);

  /**
   * Change a harmony voice's delay. The delay moves the clip inside the song
   * and trims its tail, so a 3:32 song stays 3:32 instead of growing by the
   * delay. Edits of the same voice coalesce into one undo step.
   */
  const setHarmonyOffset = useCallback((harmonyId: string, offsetSeconds: number) => {
    updateProject((p) => {
      const layer = p.harmonies.find((h) => h.id === harmonyId);
      if (!layer) return p;
      const next = Math.max(0, Math.min(10, offsetSeconds));
      const previous = layer.offsetSeconds ?? 0;
      layer.offsetSeconds = next;
      for (const track of p.tracks) {
        const clip = track.clips.find((c) => c.id === layer.clipId);
        if (!clip) continue;
        // Remember the *rendered* length once, then trim the tail so a delay
        // never pushes the song longer than it was.
        const full = layer.clipDuration ?? clip.duration + previous;
        layer.clipDuration = full;
        clip.start = next;
        clip.duration = Math.max(0.001, full - next);
      }
      return p;
    }, true, `offset:${harmonyId}`);
  }, [updateProject]);

  /** Swap a harmony layer's rendered audio (used when a voice is re-rendered). */
  const replaceHarmonyClip = useCallback((
    harmonyId: string,
    assetId: string,
    duration: number,
    size: number,
    name?: string,
  ) => {
    updateProject((p) => {
      const layer = p.harmonies.find((h) => h.id === harmonyId);
      if (!layer) return p;
      let replaced = false;
      for (const track of p.tracks) {
        const clip = track.clips.find((c) => c.id === layer.clipId);
        if (!clip) continue;
        evictAudioData(clip.assetId);
        clip.assetId = assetId;
        clip.duration = duration;
        if (name) clip.name = name;
        replaced = true;
      }
      if (!replaced) return p;
      const label = name ?? layer.name;
      const existing = p.media.find((m) => m.assetId === assetId);
      if (existing) {
        existing.size = size;
        existing.name = label;
      } else {
        p.media.push({
          assetId,
          name: label,
          mime: 'audio/wav',
          size,
          kind: 'processed',
          createdAt: Date.now(),
        });
      }
      return p;
    });
  }, [updateProject]);

  const removeHarmony = useCallback((harmonyId: string) => {
    updateProject((p) => {
      const layer = p.harmonies.find((h) => h.id === harmonyId);
      if (!layer) return p;
      for (const track of p.tracks) {
        for (const clip of track.clips) {
          if (clip.id === layer.clipId) evictAudioData(clip.assetId);
        }
        track.clips = track.clips.filter((c) => c.id !== layer.clipId);
      }
      p.harmonies = p.harmonies.filter((h) => h.id !== harmonyId);
      return p;
    });
    announce('Harmony layer removed');
  }, [announce, updateProject]);

  const duplicateHarmony = useCallback(async (harmonyId: string) => {
    const project = projectRef.current;
    const layer = project.harmonies.find((h) => h.id === harmonyId);
    if (!layer || !layer.clipId) throw new Error('Harmony layer not found');
    const sourceClip = project.tracks.find((t) => t.clips.some((c) => c.id === layer.clipId))?.clips.find((c) => c.id === layer.clipId);
    if (!sourceClip) throw new Error('Harmony clip not found');
    const data = await loadAudioData(sourceClip.assetId);
    const asset = await storeAudioData(data, `${layer.name} (copy)`, 'processed');
    cacheAudioData(asset.id, data);
    updateProject((p) => {
      const target = p.tracks.find((t) => t.id === layer.targetTrackId);
      if (!target) return p;
      const clip = makeClip(asset.id, `${layer.name} (copy)`, sourceClip.start, sourceClip.duration);
      target.clips.push(clip);
      p.media.push({ assetId: asset.id, name: clip.name, mime: asset.mime, size: asset.size, kind: 'processed', createdAt: Date.now() });
      p.harmonies.push({
        ...layer,
        id: makeId('harmony'),
        name: `${layer.name} (copy)`,
        clipId: clip.id,
        // A copy is its own group so replacing the preset does not delete it.
        groupId: `${layer.groupId ?? 'harmony'}:copy:${makeId('copy')}`,
      });
      return p;
    });
    announce('Harmony layer duplicated');
  }, [announce, updateProject, projectRef]);

  /** Mute every voice of one harmonization group in a single undo step. */
  const setHarmonyGroupMuted = useCallback((groupId: string, muted: boolean) => {
    updateProject((p) => {
      for (const layer of p.harmonies) if (layer.groupId === groupId) layer.muted = muted;
      return p;
    });
    announce(muted ? 'Harmony voices muted — hearing the original' : 'Harmony voices restored');
  }, [announce, updateProject]);

  /** Solo every voice of a group (A/B against the original). */
  const setHarmonyGroupSolo = useCallback((groupId: string, solo: boolean) => {
    updateProject((p) => {
      for (const layer of p.harmonies) if (layer.groupId === groupId) layer.solo = solo;
      return p;
    });
    announce(solo ? 'Soloing harmony voices' : 'Harmony solo released');
  }, [announce, updateProject]);

  const addHarmonyRange = useCallback((range?: Partial<HarmonyRange>) => {
    updateProject((p) => {
      const start = range?.start ?? Math.max(0, Math.min(p.selection?.start ?? 5, 5));
      const end = range?.end ?? Math.max(start + 0.5, Math.min(p.selection?.end ?? 25, 25));
      p.harmonyRanges.push({
        id: makeId('range'),
        start,
        end,
        enabled: range?.enabled ?? true,
        label: range?.label ?? `Range ${p.harmonyRanges.length + 1}`,
      });
      return p;
    });
    announce('Time range added');
  }, [announce, updateProject]);

  const updateHarmonyRange = useCallback((id: string, patch: Partial<HarmonyRange>) => {
    updateProject((p) => {
      const range = p.harmonyRanges.find((r) => r.id === id);
      if (range) Object.assign(range, patch);
      return p;
    }, true, `range:${id}`);
  }, [updateProject]);

  const removeHarmonyRange = useCallback((id: string) => {
    updateProject((p) => {
      p.harmonyRanges = p.harmonyRanges.filter((r) => r.id !== id);
      return p;
    });
    announce('Time range removed');
  }, [announce, updateProject]);

  const setHarmonyKey = useCallback((key: HarmonyKey) => {
    updateProject((p) => { p.harmonyKey = key; return p; });
  }, [updateProject]);

  const setHarmonyScale = useCallback((scale: HarmonyScale) => {
    updateProject((p) => { p.harmonyScale = scale; return p; });
  }, [updateProject]);

  // Import helpers
  const importAudioData = useCallback(async (data: AudioData, name: string, trackId?: string, start?: number, opts: { recording?: boolean } = {}): Promise<string> => {
    const targetId = trackId ?? projectRef.current.tracks[0]?.id;
    if (!targetId) throw new Error('No track available to import into');
    return addClip(targetId, data, name, start, opts);
  }, [addClip]);

  const setSelection = useCallback((selection: { start: number; end: number } | null) => {
    updateView({ selection });
  }, [updateView]);

  const setZoom = useCallback((zoom: number) => {
    updateView({ zoom: Math.max(0.25, Math.min(4, zoom)) });
  }, [updateView]);

  const loadAssetLengths = useCallback(async () => {
    const current = projectRef.current;
    const seen = new Set<string>();
    for (const track of current.tracks) {
      for (const clip of track.clips) {
        if (seen.has(clip.assetId)) continue;
        seen.add(clip.assetId);
        try {
          const data = await loadAudioData(clip.assetId);
          const length = data.length / data.sampleRate;
          // Correct placeholder durations left by imports that could not be
          // measured immediately. A clip that is deliberately *shorter* than
          // its asset (a trimmed tail, a delayed harmony voice) is left alone —
          // otherwise every pass would rewrite the project and re-trigger this
          // effect forever.
          if (clip.duration > length + 0.02) {
            updateProject((p) => {
              for (const t of p.tracks) {
                const c = t.clips.find((x) => x.id === clip.id);
                if (c) c.duration = length;
              }
              return p;
            }, false);
          }
        } catch { /* asset missing — surfaces at render time with a clear error */ }
      }
    }
  }, [updateProject]);

  useEffect(() => {
    void loadAssetLengths();
  }, [loadAssetLengths, project.tracks]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await db.saveSettings(next);
  }, [settings]);

  const storeVideoOriginal = useCallback(async (file: File) => {
    const asset = await storeBlob(file, file.name, 'video-original');
    updateProject((p) => {
      p.media.push({ assetId: asset.id, name: file.name, mime: file.type || 'video/*', size: file.size, kind: 'video-original', createdAt: Date.now() });
      return p;
    }, false);
    return asset;
  }, [updateProject]);

  return {
    project,
    setProject: commit,
    updateProject,
    updateView,
    projects,
    settings,
    loading,
    announcement,
    announce,
    refreshProjects,
    save,
    saveAs,
    openProject,
    newProject,
    deleteProject,
    renameProject,
    duplicateProject,
    undo,
    redo,
    canUndo,
    canRedo,
    addTrack,
    renameTrack,
    duplicateTrack,
    deleteTrack,
    setTrackVolume,
    setTrackPan,
    setClipPan,
    duplicateOriginalTrack,
    toggleMute,
    toggleSolo,
    selectTrack,
    selectClip,
    setTrackPitch,
    setVocalState,
    addClip,
    updateClip,
    deleteClip,
    splitClip,
    trimClip,
    addHarmony,
    updateHarmony,
    removeHarmony,
    duplicateHarmony,
    ensureTracks,
    applyHarmonyGroup,
    removeHarmonyGroup,
    setHarmonyOffset,
    replaceHarmonyClip,
    setHarmonyGroupMuted,
    setHarmonyGroupSolo,
    addHarmonyRange,
    updateHarmonyRange,
    removeHarmonyRange,
    setHarmonyKey,
    setHarmonyScale,
    importAudioData,
    storeVideoOriginal,
    setSelection,
    setZoom,
    updateSettings,
    createWavAsset: async (data: AudioData, name: string) => {
      const blob = audioDataToWavBlob(data);
      const asset = await storeBlob(blob, name, 'processed');
      cacheAudioData(asset.id, data);
      return asset;
    },
  };
}

export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? '';
  const message = (error as { message?: string })?.message ?? '';
  return name === 'QuotaExceededError' || /quota|storage.*full|NoSpace/i.test(message);
}

export type ProjectStore = ReturnType<typeof useProjectStore>;

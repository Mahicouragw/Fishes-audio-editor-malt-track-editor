import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioData } from '../types';
import {
  defaultAppSettings, defaultExportSettings, defaultVocalState, makeId,
  type AppSettings, type Clip, type HarmonyLayer, type Project, type RecordingTake, type Track, type VocalState,
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
      { id: makeId('track'), name: 'Voice 1', volume: 1, muted: false, solo: false, pitchSemis: 0, pitchFineCents: 0, clips: [], vocal: defaultVocalState() },
      { id: makeId('track'), name: 'Voice 2', volume: 1, muted: false, solo: false, pitchSemis: 0, pitchFineCents: 0, clips: [], vocal: defaultVocalState() },
    ],
    harmonies: [],
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

export function makeTrack(name: string): Track {
  return {
    id: makeId('track'),
    name,
    volume: 1,
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

  const pushHistory = useCallback((previous: Project) => {
    history.current.push(cloneProject(previous));
    if (history.current.length > 60) history.current.shift();
    future.current = [];
  }, []);

  const scheduleAutosave = useCallback((next: Project) => {
    if (options.autosave === false) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      db.saveProject(next)
        .then(() => refreshProjects())
        .catch(() => announce('Autosave failed — storage may be full. Export or delete projects to free space.'));
    }, 900);
  }, [announce, options.autosave, refreshProjects]);

  const updateProject = useCallback((updater: (p: Project) => Project, saveHistory = true) => {
    const prev = projectRef.current;
    const next = updater(cloneProject(prev));
    next.updatedAt = Date.now();
    if (saveHistory && next !== prev) pushHistory(prev);
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
    commit(next);
    await refreshProjects();
    announce(`Saved as ${title}`);
  }, [announce, commit, refreshProjects]);

  const openProject = useCallback(async (id: string) => {
    const found = await db.getProject(id);
    if (!found) throw new Error('Project not found');
    history.current = [];
    future.current = [];
    commit(found);
    announce(`Opened ${found.title}`);
  }, [announce, commit]);

  const newProject = useCallback(async (title?: string) => {
    const next = createEmptyProject(title);
    history.current = [];
    future.current = [];
    commit(next);
    await db.saveProject(next);
    await refreshProjects();
    announce(`Created ${next.title}`);
    return next.id;
  }, [announce, commit, refreshProjects]);

  const deleteProject = useCallback(async (id: string) => {
    await db.deleteProject(id);
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
    const previous = history.current.pop();
    if (!previous) return;
    const current = projectRef.current;
    future.current.push(cloneProject(current));
    commit(restoreKeepingView(previous));
    announce('Undone');
  }, [announce, commit]);

  const redo = useCallback(() => {
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
      if (track) track.volume = volume;
      return p;
    }, false);
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
        vocalsOnly: false,
      };
      harmonyId = harmony.id;
      p.harmonies.push(harmony);
      return p;
    });
    announce(`Harmony ${semitones >= 0 ? '+' : ''}${semitones} created`);
    return harmonyId;
  }, [announce, updateProject]);

  const updateHarmony = useCallback((harmonyId: string, patch: Partial<Pick<HarmonyLayer, 'muted' | 'gain' | 'name'>>) => {
    updateProject((p) => {
      const layer = p.harmonies.find((h) => h.id === harmonyId);
      if (layer) Object.assign(layer, patch);
      return p;
    }, patch.muted === undefined && patch.gain === undefined);
  }, [updateProject]);

  const removeHarmony = useCallback((harmonyId: string) => {
    updateProject((p) => {
      const layer = p.harmonies.find((h) => h.id === harmonyId);
      if (!layer) return p;
      for (const track of p.tracks) track.clips = track.clips.filter((c) => c.id !== layer.clipId);
      p.harmonies = p.harmonies.filter((h) => h.id !== harmonyId);
      if (layer.clipId) evictAudioData(layer.clipId);
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
      p.harmonies.push({ ...layer, id: makeId('harmony'), name: `${layer.name} (copy)`, clipId: clip.id });
      return p;
    });
    announce('Harmony layer duplicated');
  }, [announce, updateProject, projectRef]);

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
          // measured immediately.
          if (Math.abs(clip.duration - length) > 0.02) {
            updateProject((p) => {
              for (const t of p.tracks) {
                const c = t.clips.find((x) => x.id === clip.id);
                if (c) c.duration = Math.min(c.duration || length, length);
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioData } from '../types';
import {
  defaultAppSettings, defaultExportSettings, defaultVocalState, makeId,
  type AppSettings, type Clip, type HarmonyLayer, type Project, type Track, type VocalState,
} from '../types';
import * as db from '../storage/db';
import { cacheAudioData, loadAudioData, storeAudioData, storeBlob } from '../storage/assets';
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

export interface UseProjectOptions {
  autosave?: boolean;
}

export function useProjectStore(options: UseProjectOptions = {}) {
  const [project, setProject] = useState<Project>(() => createEmptyProject());
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings());
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const history = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const updateProject = useCallback((updater: (p: Project) => Project, saveHistory = true) => {
    setProject((prev) => {
      const next = updater(cloneProject(prev));
      next.updatedAt = Date.now();
      if (saveHistory) pushHistory(prev);
      if (options.autosave !== false) {
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
        autosaveTimer.current = setTimeout(() => {
          db.saveProject(next).then(() => refreshProjects()).catch(() => announce('Autosave failed — storage may be full'));
        }, 900);
      }
      return next;
    });
  }, [announce, options.autosave, pushHistory, refreshProjects]);

  const save = useCallback(async () => {
    await db.saveProject(project);
    await refreshProjects();
    announce(`Project ${project.title} saved`);
  }, [announce, project, refreshProjects]);

  const saveAs = useCallback(async (title: string) => {
    const next: Project = { ...cloneProject(project), id: makeId('project'), title, createdAt: Date.now(), updatedAt: Date.now() };
    await db.saveProject(next);
    setProject(next);
    await refreshProjects();
    announce(`Saved as ${title}`);
  }, [announce, project, refreshProjects]);

  const openProject = useCallback(async (id: string) => {
    const found = await db.getProject(id);
    if (!found) throw new Error('Project not found');
    history.current = [];
    future.current = [];
    setProject(found);
    announce(`Opened ${found.title}`);
  }, [announce]);

  const newProject = useCallback(async (title?: string) => {
    const next = createEmptyProject(title);
    history.current = [];
    future.current = [];
    setProject(next);
    await db.saveProject(next);
    await refreshProjects();
    announce(`Created ${next.title}`);
  }, [announce, refreshProjects]);

  const deleteProject = useCallback(async (id: string) => {
    await db.deleteProject(id);
    await refreshProjects();
    announce('Project deleted');
  }, [announce, refreshProjects]);

  const undo = useCallback(() => {
    const previous = history.current.pop();
    if (!previous) return;
    setProject((current) => {
      future.current.push(cloneProject(current));
      return previous;
    });
    announce('Undone');
  }, [announce]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    setProject((current) => {
      history.current.push(cloneProject(current));
      return next;
    });
    announce('Redone');
  }, [announce]);

  const canUndo = history.current.length > 0;
  const canRedo = future.current.length > 0;

  // Track helpers
  const addTrack = useCallback((name?: string) => {
    updateProject((p) => {
      const count = p.tracks.length + 1;
      p.tracks.push({
        id: makeId('track'),
        name: name ?? `Voice ${count}`,
        volume: 1, muted: false, solo: false, pitchSemis: 0, pitchFineCents: 0, clips: [], vocal: defaultVocalState(),
      });
      return p;
    });
    announce('Track added');
  }, [announce, updateProject]);

  const renameTrack = useCallback((trackId: string, name: string) => {
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.name = name || track.name;
      return p;
    });
  }, [updateProject]);

  const duplicateTrack = useCallback((trackId: string) => {
    updateProject((p) => {
      const index = p.tracks.findIndex((t) => t.id === trackId);
      if (index < 0) return p;
      const source = p.tracks[index];
      p.tracks.splice(index + 1, 0, { ...cloneProject(source as unknown as Project) as unknown as Track, id: makeId('track'), name: `${source.name} copy`, clips: source.clips.map((c) => ({ ...c, id: makeId('clip') })) });
      return p;
    });
    announce('Track duplicated');
  }, [announce, updateProject]);

  const deleteTrack = useCallback((trackId: string) => {
    updateProject((p) => {
      p.tracks = p.tracks.filter((t) => t.id !== trackId);
      if (p.selectedTrackId === trackId) p.selectedTrackId = p.tracks[0]?.id ?? null;
      p.harmonies = p.harmonies.filter((h) => h.sourceTrackId !== trackId && h.targetTrackId !== trackId);
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
    setProject((prev) => ({ ...prev, selectedTrackId: trackId }));
    const track = project.tracks.find((t) => t.id === trackId);
    if (track) announce(`Selected ${track.name}`);
  }, [announce, project.tracks]);

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
    });
  }, [updateProject]);

  // Clip helpers
  const addClip = useCallback(async (trackId: string, data: AudioData, name: string, start?: number) => {
    const asset = await storeAudioData(data, name, 'audio');
    cacheAudioData(asset.id, data);
    updateProject((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track) return p;
      const duration = data.length / data.sampleRate;
      const at = start ?? p.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)).reduce((m, v) => Math.max(m, v), 0);
      const clip: Clip = { id: makeId('clip'), assetId: asset.id, name, start: at, sourceStart: 0, duration, gain: 1, fadeIn: 0, fadeOut: 0, effects: [] };
      track.clips.push(clip);
      p.media.push({ assetId: asset.id, name, mime: asset.mime, size: asset.size, kind: 'audio', createdAt: Date.now() });
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
          clip.start = start;
          clip.sourceStart += delta;
          clip.duration = duration;
          break;
        }
      }
      return p;
    });
  }, [updateProject]);

  // Harmony
  const addHarmony = useCallback(async (sourceTrackId: string, targetTrackId: string, semitones: number, data: AudioData) => {
    const asset = await storeAudioData(data, `Harmony ${semitones >= 0 ? '+' : ''}${semitones}`, 'processed');
    cacheAudioData(asset.id, data);
    updateProject((p) => {
      const target = p.tracks.find((t) => t.id === targetTrackId);
      if (!target) return p;
      const source = p.tracks.find((t) => t.id === sourceTrackId);
      const sourceClip = source?.clips[0];
      const clip: Clip = {
        id: makeId('clip'), assetId: asset.id, name: `Harmony ${semitones >= 0 ? '+' : ''}${semitones}`, start: sourceClip?.start ?? 0,
        sourceStart: 0, duration: data.length / data.sampleRate, gain: 1, fadeIn: 0, fadeOut: 0, effects: [],
      };
      target.clips.push(clip);
      p.media.push({ assetId: asset.id, name: clip.name, mime: asset.mime, size: asset.size, kind: 'processed', createdAt: Date.now() });
      const harmony: HarmonyLayer = { id: makeId('harmony'), name: clip.name, sourceTrackId, targetTrackId, semitones, gain: 0.9, muted: false, vocalsOnly: false };
      p.harmonies.push(harmony);
      return p;
    });
    announce(`Harmony ${semitones} created`);
  }, [announce, updateProject]);

  // Import helpers
  const importAudioData = useCallback(async (data: AudioData, name: string, trackId?: string, start?: number) => {
    const targetId = trackId ?? project.tracks[0]?.id ?? createEmptyProject().tracks[0].id;
    // Ensure target track exists
    if (!project.tracks.find((t) => t.id === targetId)) {
      updateProject((p) => {
        p.tracks.push({ id: targetId, name: 'Voice 1', volume: 1, muted: false, solo: false, pitchSemis: 0, pitchFineCents: 0, clips: [], vocal: defaultVocalState() });
        return p;
      });
    }
    return addClip(targetId, data, name, start);
  }, [addClip, project.tracks, updateProject]);

  const importBlob = useCallback(async (blob: Blob, name: string, trackId?: string) => {
    const asset = await storeBlob(blob, name, 'audio');
    // Also decode for immediate use
    const buffer = await blob.arrayBuffer();
    try {
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(buffer.slice(0));
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => new Float32Array(decoded.getChannelData(c)));
      cacheAudioData(asset.id, audioData(channels, decoded.sampleRate));
      await context.close();
    } catch { /* stored as blob, will decode on demand */ }
    updateProject((p) => {
      const target = p.tracks.find((t) => t.id === trackId) ?? p.tracks[0];
      if (!target) return p;
      const duration = 1; // unknown until decoded; will be corrected when clip is rendered
      target.clips.push({ id: makeId('clip'), assetId: asset.id, name, start: 0, sourceStart: 0, duration, gain: 1, fadeIn: 0, fadeOut: 0, effects: [] });
      p.media.push({ assetId: asset.id, name, mime: asset.mime, size: asset.size, kind: 'audio', createdAt: Date.now() });
      return p;
    });
    return asset.id;
  }, [updateProject]);

  const setSelection = useCallback((selection: { start: number; end: number } | null) => {
    setProject((prev) => ({ ...prev, selection }));
  }, []);

  const setZoom = useCallback((zoom: number) => {
    setProject((prev) => ({ ...prev, zoom: Math.max(0.25, Math.min(4, zoom)) }));
  }, []);

  const assetLengths = useMemo(() => new Map<string, number>(), []);

  const loadAssetLengths = useCallback(async () => {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (assetLengths.has(clip.assetId)) continue;
        try {
          const data = await loadAudioData(clip.assetId);
          assetLengths.set(clip.assetId, data.length / data.sampleRate);
          // Correct placeholder durations
          if (clip.duration === 1) {
            updateProject((p) => {
              for (const t of p.tracks) {
                const c = t.clips.find((x) => x.id === clip.id);
                if (c) c.duration = data.length / data.sampleRate;
              }
              return p;
            }, false);
          }
        } catch { /* ignore */ }
      }
    }
  }, [assetLengths, project.tracks, updateProject]);

  useEffect(() => { loadAssetLengths(); }, [loadAssetLengths]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await db.saveSettings(next);
  }, [settings]);

  return {
    project, setProject, projects, settings, loading, announcement, announce,
    refreshProjects, save, saveAs, openProject, newProject, deleteProject,
    undo, redo, canUndo, canRedo,
    addTrack, renameTrack, duplicateTrack, deleteTrack, setTrackVolume, toggleMute, toggleSolo, selectTrack, setTrackPitch, setVocalState,
    addClip, updateClip, deleteClip, splitClip, trimClip,
    addHarmony, importAudioData, importBlob, setSelection, setZoom, updateSettings, updateProject,
    createWavAsset: async (data: AudioData, name: string) => {
      const blob = audioDataToWavBlob(data);
      const asset = await storeBlob(blob, name, 'processed');
      cacheAudioData(asset.id, data);
      return asset;
    },
  };
}

export type ProjectStore = ReturnType<typeof useProjectStore>;

import { useEffect, useRef, useState } from 'react';
import type { ExportFormat, ExportScope, Track } from '../types';
import type { ProjectStore } from '../store/projectStore';
import { prepareClipData, harmonyClipFactor, originalVoiceFactor, effectivePan } from '../audio/mixdown';
import { mixEntries, type MixEntry } from '../audio/mixdown';
import { resampleAudio, softLimit, normalize, peak, applyGain } from '../audio/dsp';
import { audioData } from '../audio/dsp';
import { encodeWavBlob } from '../audio/wav';
import { encodeMp3Blob, encodeAacBlob, aacEncoderAvailable, aacUnavailableReason } from '../audio/encoders';
import { formatTime } from '../types';

interface ExportFile {
  name: string;
  blob: Blob;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ');
  return cleaned || 'wishes-mix';
}

export function ExportDialog({ store, onClose }: { store: ProjectStore; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>(store.project.exportSettings.format);
  const [scope, setScope] = useState<ExportScope>(store.project.exportSettings.scope);
  const [filename, setFilename] = useState(store.project.exportSettings.filename);
  const [sampleRate, setSampleRate] = useState(store.project.exportSettings.sampleRate);
  const [bitDepth, setBitDepth] = useState(store.project.exportSettings.bitDepth);
  const [bitrate, setBitrate] = useState(store.project.exportSettings.bitrate);
  const [channels, setChannels] = useState(store.project.exportSettings.channels);
  const [normalizeOut, setNormalizeOut] = useState(store.project.exportSettings.normalize);
  const [preventClipping, setPreventClipping] = useState(store.project.exportSettings.preventClipping);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [files, setFiles] = useState<ExportFile[]>([]);
  const controllerRef = useRef<AbortController | null>(null);

  const aacAvailable = aacEncoderAvailable();
  const selection = store.project.selection;
  const urlsRef = useRef<Map<string, string>>(new Map());

  // Revoke object URLs when the dialog closes; a new export revokes the
  // previous set explicitly (below) so links never dangle mid-export.
  useEffect(() => () => {
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);

  const revokeCurrentFiles = () => {
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  };

  const audibleTracks = (project: typeof store.project): Track[] => {
    const soloed = project.tracks.some((t) => t.solo);
    return project.tracks.filter((t) => !t.muted && (soloed ? t.solo : true));
  };

  const renderAndEncode = async (controller: AbortController): Promise<ExportFile[]> => {
    const project = store.project;
    const allClips = project.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
    if (!allClips.length) throw new Error('No audio to export — import or record something first');

    const check = () => {
      if (controller.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
    };

    const stems = scope === 'stems';
    const tracksToExport: Track[] = stems
      ? audibleTracks(project)
      : scope === 'track'
        ? [project.tracks.find((t) => t.id === (project.selectedTrackId ?? project.tracks[0]?.id)) ?? project.tracks[0]]
        : audibleTracks(project);
    if (!tracksToExport.length || !tracksToExport[0]) throw new Error('No audible tracks to export');
    if (scope === 'track' && !tracksToExport[0]) throw new Error('Selected track has no audio');

    const rangeActive = scope === 'range' && !stems;
    if (rangeActive && !selection) throw new Error('Select a time range first (Shift+drag on the timeline)');

    const clipOverlapsRange = (start: number, duration: number) => {
      if (!rangeActive || !selection) return true;
      return start < selection.end && start + duration > selection.start;
    };

    // Render every clip through its committed chain (pitch, vocal stems,
    // range effects, fades) on the shared mix bus, so the export always
    // matches what the transport plays.
    const perTrack: Record<string, MixEntry[]> = {};
    let totalClips = 0;
    for (const track of tracksToExport) {
      perTrack[track.id] = [];
      for (const clip of track.clips) {
        if (clipOverlapsRange(clip.start, clip.duration)) totalClips++;
      }
    }
    if (!totalClips) throw new Error('Nothing to export in the chosen scope');

    let doneClips = 0;
    const entriesPerTrack: Record<string, MixEntry[]> = {};
    for (const track of tracksToExport) {
      const entries: MixEntry[] = [];
      for (const clip of track.clips) {
        if (!clipOverlapsRange(clip.start, clip.duration)) continue;
        check();
        setMessage(`Rendering ${clip.name} (${track.name})`);
        setProgress(0.05 + 0.55 * (doneClips / totalClips));
        const data = await prepareClipData(track, clip);
        const factor = harmonyClipFactor(track, clip, project.harmonies)
          * originalVoiceFactor(track, project.harmonies);
        entries.push({
          data,
          start: clip.start,
          gain: track.volume * clip.gain * factor,
          // The same constant-power pan law the transport uses.
          pan: effectivePan(track, clip, project.harmonies),
        });
        doneClips++;
        setProgress(0.05 + 0.55 * (doneClips / totalClips));
      }
      entriesPerTrack[track.id] = entries;
    }

    const encode = async (label: string, mixData: ReturnType<typeof mixEntries>, stageProgress: [number, number]): Promise<Blob> => {
      check();
      let data = mixData;
      if (normalizeOut) {
        const p = peak(data);
        if (p > 0.95) data = softLimit(data);
        data = normalize(data);
      }
      if (preventClipping) data = softLimit(data);
      setMessage(`Encoding ${label}…`);
      if (format === 'wav') {
        return encodeWavBlob(data, { bitDepth, channels, sampleRate });
      }
      if (format === 'mp3') {
        return encodeMp3Blob(data, bitrate, channels, {
          onProgress: (p, m) => { setProgress(stageProgress[0] + p * (stageProgress[1] - stageProgress[0])); setMessage(m); },
          signal: controller.signal,
        });
      }
      if (!aacAvailable) throw new Error(aacUnavailableReason());
      return encodeAacBlob(data, bitrate, channels, {
        onProgress: (p, m) => { setProgress(stageProgress[0] + p * (stageProgress[1] - stageProgress[0])); setMessage(m); },
        signal: controller.signal,
      });
    };

    const ext = format === 'wav' ? 'wav' : format === 'mp3' ? 'mp3' : 'm4a';
    const baseName = sanitizeFilename(filename);
    const out: ExportFile[] = [];

    if (stems) {
      for (let i = 0; i < tracksToExport.length; i++) {
        check();
        const track = tracksToExport[i];
        const entries = entriesPerTrack[track.id];
        const rangeOffset = 0;
        const end = entries.reduce((m, e) => Math.max(m, e.start + e.data.length / e.data.sampleRate), 0);
        const mix = mixEntries(entries.map((e) => ({ ...e, start: e.start - rangeOffset })), sampleRate, channels);
        const trackData = audioData(mix.channels, sampleRate);
        const blob = await encode(`${track.name} stem`, trackData, [0.62 + 0.38 * (i / tracksToExport.length), 0.62 + 0.38 * ((i + 1) / tracksToExport.length)]);
        out.push({ name: `${baseName} — ${track.name.replace(/[^\w\- ]+/g, '') || `track-${i + 1}`}.${ext}`, blob });
        check();
      }
      return out;
    }

    const rangeOffset = rangeActive && selection ? selection.start : 0;
    const allEntries: MixEntry[] = [];
    for (const track of tracksToExport) {
      for (const entry of entriesPerTrack[track.id]) {
        allEntries.push({ ...entry, start: entry.start - rangeOffset });
      }
    }
    const mixed = mixEntries(allEntries, sampleRate, channels);
    // The master fader is part of the mix, exactly as it is during playback.
    const master = store.settings.masterVolume;
    const mix = master === 1 ? mixed : applyGain(mixed, master);
    const blob = await encode('mix', mix, [0.62, 1]);
    const trackSuffix = scope === 'track' ? ` — ${tracksToExport[0].name.replace(/[^\w\- ]+/g, '')}` : '';
    const rangeSuffix = rangeActive && selection ? ` — ${formatTime(selection.start)}-${formatTime(selection.end)}` : '';
    out.push({ name: `${baseName}${trackSuffix}${rangeSuffix}.${ext}`, blob });
    return out;
  };

  const handleExport = async () => {
    if (!filename.trim()) { setError('Enter a filename'); return; }
    setError('');
    setBusy(true);
    setProgress(0);
    setMessage('Rendering mix');
    revokeCurrentFiles();
    setFiles([]);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const rendered = await renderAndEncode(controller);
      const next: ExportFile[] = [];
      for (const file of rendered) {
        const url = URL.createObjectURL(file.blob);
        urlsRef.current.set(file.name, url);
        next.push({ name: file.name, blob: file.blob });
      }
      setFiles(next);
      setProgress(1);
      setMessage('Export ready');
      store.announce(`Exported ${next.map((f) => f.name).join(', ')}`);
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setError((e as Error).message);
      else store.announce('Export cancelled');
    } finally {
      setBusy(false);
      controllerRef.current = null;
    }
  };

  const handleCancelExport = () => {
    controllerRef.current?.abort();
  };

  const totalSize = files.reduce((sum, f) => sum + f.blob.size, 0);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Export audio">
      <div className="dialog">
        <h2>Export Audio</h2>
        <p className="hint">The exported file reflects committed pitch, tempo, harmonies, vocal processing, effects, timing, track volume, panning and the master fader — rendered through the same chain the transport uses. Pan is written into stereo exports; a mono export has no stereo field. Files are real encodings: WAV is PCM/float, MP3 is LAME, AAC only when the browser provides an encoder (never a renamed file).</p>

        <label className="field">
          <span>Filename</span>
          <input type="text" value={filename} aria-label="Export filename" onChange={(e) => setFilename(e.target.value)} />
        </label>

        <label className="field">
          <span>Format</span>
          <select value={format} aria-label="Export format" onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            <option value="wav">WAV (PCM 16/24-bit or 32-bit float)</option>
            <option value="mp3">MP3 (LAME)</option>
            <option value="m4a" disabled={!aacAvailable}>AAC/M4A {aacAvailable ? '(browser encoder)' : '(unsupported in this browser)'}</option>
          </select>
        </label>
        {!aacAvailable && format === 'm4a' && <p className="error" role="alert">{aacUnavailableReason()} Choose WAV or MP3 — files are never renamed to fake a format.</p>}

        <label className="field">
          <span>Scope</span>
          <select value={scope} aria-label="Export scope" onChange={(e) => setScope(e.target.value as ExportScope)}>
            <option value="project">Entire project (all audible tracks)</option>
            <option value="range">Selected range {selection ? `${formatTime(selection.start)}–${formatTime(selection.end)}` : '(no range selected)'}</option>
            <option value="track">Selected track</option>
            <option value="stems">Individual stems (one file per audible track)</option>
          </select>
        </label>
        {scope === 'stems' && <p className="hint">Each audible track is rendered separately with its own pitch/vocal/effect chain and downloaded as its own file.</p>}

        <div className="row">
          <label className="field">
            <span>Sample rate</span>
            <select value={sampleRate} aria-label="Sample rate" onChange={(e) => setSampleRate(Number(e.target.value) as 44100 | 48000 | 96000)}>
              <option value={44100}>44100 Hz</option>
              <option value={48000}>48000 Hz</option>
              <option value={96000}>96000 Hz</option>
            </select>
          </label>
          {format === 'wav' && (
            <label className="field">
              <span>Bit depth</span>
              <select value={bitDepth} aria-label="Bit depth" onChange={(e) => setBitDepth(Number(e.target.value) as 16 | 24 | 32)}>
                <option value={16}>16-bit</option>
                <option value={24}>24-bit</option>
                <option value={32}>32-bit float</option>
              </select>
            </label>
          )}
          {format !== 'wav' && (
            <label className="field">
              <span>Bitrate</span>
              <select value={bitrate} aria-label="MP3 or AAC bitrate" onChange={(e) => setBitrate(Number(e.target.value) as 96 | 128 | 192 | 256 | 320)}>
                <option value={96}>96 kbps</option>
                <option value={128}>128 kbps</option>
                <option value={192}>192 kbps</option>
                <option value={256}>256 kbps</option>
                <option value={320}>320 kbps</option>
              </select>
            </label>
          )}
          <label className="field">
            <span>Channels</span>
            <select value={channels} aria-label="Stereo or mono" onChange={(e) => setChannels(Number(e.target.value) as 1 | 2)}>
              <option value={2}>Stereo</option>
              <option value={1}>Mono</option>
            </select>
          </label>
        </div>

        <label className="field checkbox">
          <input type="checkbox" checked={normalizeOut} aria-label="Normalize export" onChange={(e) => setNormalizeOut(e.target.checked)} />
          <span>Normalize to -0.5 dBFS</span>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={preventClipping} aria-label="Prevent clipping" onChange={(e) => setPreventClipping(e.target.checked)} />
          <span>Prevent clipping (soft limiter)</span>
        </label>

        {busy && (
          <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={message}>
            <div className="progress-bar" style={{ width: `${progress * 100}%` }} />
            <span>{message} {Math.round(progress * 100)}%</span>
          </div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        {files.length > 0 && (
          <div className="field">
            <span>Ready to download {files.length > 1 ? `(${files.length} files, ` : `(`}{files.length > 1 ? `${(totalSize / 1024).toFixed(1)} KB total)` : `${(files[0].blob.size / 1024).toFixed(1)} KB)`}</span>
            <ul className="region-list" aria-label="Exported files">
              {files.map((file) => (
                <li key={file.name} className="merge-item">
                  <span>{file.name} · {(file.blob.size / 1024).toFixed(1)} KB</span>
                  <a className="btn btn-primary btn-xs" href={urlsRef.current.get(file.name)} download={file.name} aria-label={`Download ${file.name}`}>Download</a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="row">
          <button type="button" className="btn btn-primary" aria-label="Export audio" disabled={busy} onClick={handleExport}>{busy ? 'Exporting' : 'Export'}</button>
          {busy && <button type="button" className="btn btn-danger" aria-label="Cancel export" onClick={handleCancelExport}>Cancel</button>}
          <button type="button" className="btn" aria-label="Close export dialog" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

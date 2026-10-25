import { useRef, useState } from 'react';
import { Upload, Film, Layers, Scissors, Mic, Music, Clock } from 'lucide-react';
import type { ProjectStore } from '../store/projectStore';
import type { StudioTab } from './StudioPage';
import { decodeAudioFile, extractAudioFromVideo, validateMediaFile } from '../audio/decode';

export function HomePage({ store, onOpenStudio }: { store: ProjectStore; onOpenStudio: (tab?: StudioTab) => void }) {
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const mergeRef = useRef<HTMLInputElement>(null);
  const recents = store.projects.slice(0, 5);

  const handleAudio = async (files: FileList | null, trackId?: string) => {
    if (!files?.length) return;
    setError('');
    setBusy('Decoding audio');
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const validation = validateMediaFile(file, 'audio', store.settings.maxFileSizeMB);
        if (validation) throw new Error(validation);
        setBusy(`Decoding ${file.name}`);
        setProgress(i / files.length);
        const data = await decodeAudioFile(file, (p) => setProgress((i + p) / files.length));
        const target = trackId ?? store.project.selectedTrackId ?? store.project.tracks[0]?.id;
        await store.importAudioData(data, file.name, target);
      }
      store.announce(`Imported ${files.length} file(s)`);
      onOpenStudio();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      setProgress(0);
      if (audioRef.current) audioRef.current.value = '';
    }
  };

  const handleVideo = async (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0];
    setError('');
    const validation = validateMediaFile(file, 'video', store.settings.maxFileSizeMB);
    if (validation) { setError(validation); return; }
    setBusy(`Extracting audio from ${file.name}`);
    try {
      // Keep the original video in the library first — the editor edits the
      // extracted audio and never silently discards the video.
      await store.storeVideoOriginal(file);
      const data = await extractAudioFromVideo(file, (p, m) => { setProgress(p); setBusy(m); });
      await store.importAudioData(data, `${file.name} (audio)`, store.project.selectedTrackId ?? store.project.tracks[0]?.id);
      store.announce(`Extracted audio from ${file.name}; the original video is kept in this project's media`);
      onOpenStudio();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      setProgress(0);
      if (videoRef.current) videoRef.current.value = '';
    }
  };

  const handleMergeFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    setBusy('Preparing merge');
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const v = validateMediaFile(file, 'audio', store.settings.maxFileSizeMB);
        if (v) throw new Error(v);
        setBusy(`Decoding ${file.name}`);
        setProgress(i / files.length);
        const data = await decodeAudioFile(file, (p) => setProgress((i + p) / files.length));
        await store.importAudioData(data, file.name);
      }
      store.announce(`Imported ${files.length} files for merging`);
      onOpenStudio('merge');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      setProgress(0);
      if (mergeRef.current) mergeRef.current.value = '';
    }
  };

  return (
    <div className="home">
      <header className="home-hero">
        <h1>Wishes Audio Editor</h1>
        <p>Upload, record, separate vocals, pitch and time-stretch, and mix multitrack projects — all in your browser.</p>
        {busy && (
          <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={busy}>
            <div className="progress-bar" style={{ width: `${progress * 100}%` }} />
            <span aria-live="polite">{busy} {Math.round(progress * 100)}%</span>
          </div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </header>

      <div className="home-grid">
        <section className="home-card">
          <h2><Upload size={20} aria-hidden="true" /> Upload Audio</h2>
          <p>WAV, MP3, M4A/AAC, OGG, FLAC via the browser's real decoders (WAV has a built-in PCM fallback).</p>
          <button type="button" className="btn btn-primary" aria-label="Upload audio files" onClick={() => audioRef.current?.click()} disabled={Boolean(busy)}>Choose audio files</button>
          <input ref={audioRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(e) => handleAudio(e.target.files)} />
          <label className="field">
            <span>Import into track</span>
            <select aria-label="Target track for upload" value={store.project.selectedTrackId ?? store.project.tracks[0]?.id ?? ''} onChange={(e) => store.selectTrack(e.target.value)}>
              {store.project.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </section>

        <section className="home-card">
          <h2><Film size={20} aria-hidden="true" /> Upload Video</h2>
          <p>MP4/WebM. The original video is stored in the project; the extracted audio track is what gets edited.</p>
          <button type="button" className="btn btn-primary" aria-label="Upload video to extract audio" onClick={() => videoRef.current?.click()} disabled={Boolean(busy)}>Choose video</button>
          <input ref={videoRef} type="file" accept="video/*,.mp4,.m4v,.webm,.mov" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => handleVideo(e.target.files)} />
          <p className="hint">Extraction uses the browser decoder, or a real-time PCM capture worklet as fallback.</p>
        </section>

        <section className="home-card">
          <h2><Layers size={20} aria-hidden="true" /> Merge Audio</h2>
          <p>Import several files, arrange order, set gaps/overlaps, and render a real combined file.</p>
          <button type="button" className="btn" aria-label="Import files to merge" onClick={() => mergeRef.current?.click()} disabled={Boolean(busy)}>Import for merging</button>
          <input ref={mergeRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(e) => handleMergeFiles(e.target.files)} />
          <button type="button" className="btn" aria-label="Open the merge panel in the studio" onClick={() => onOpenStudio('merge')}>Open Merge panel</button>
        </section>

        <section className="home-card">
          <h2><Scissors size={20} aria-hidden="true" /> Remove Silence</h2>
          <p>Analyse the real signal (RMS), preview regions, and remove only the ones you confirm.</p>
          <button type="button" className="btn" aria-label="Open remove silence in the studio" onClick={() => onOpenStudio('silence')}>Open Remove Silence</button>
        </section>

        <section className="home-card">
          <h2><Music size={20} aria-hidden="true" /> Multitrack Editor</h2>
          <p>Voice 1–4 and unlimited additional tracks with independent pitch, effects, and numeric timing.</p>
          <button type="button" className="btn btn-primary" aria-label="Open multitrack editor" onClick={() => onOpenStudio()}>Open Studio</button>
        </section>

        <section className="home-card">
          <h2><Mic size={20} aria-hidden="true" /> Record Voice</h2>
          <p>Real microphone capture with device selection, count-in, level meter, pause/resume, and headphone monitoring (off by default).</p>
          <button type="button" className="btn" aria-label="Open the recording studio" onClick={() => onOpenStudio('record')}>Open Recorder</button>
        </section>

        <section className="home-card">
          <h2><Music size={20} aria-hidden="true" /> Karaoke</h2>
          <p>Import a song, mute or separate its vocals, then record your take at the playhead over the accompaniment — takes stay in sync on playback.</p>
          <button type="button" className="btn" aria-label="Open karaoke recording" onClick={() => onOpenStudio('record')}>Open Karaoke</button>
        </section>

        <section className="home-card">
          <h2><Clock size={20} aria-hidden="true" /> Recent Projects</h2>
          {recents.length ? (
            <ul className="region-list" aria-label="Recent projects">
              {recents.map((p) => (
                <li key={p.id} className="merge-item">
                  <span>{p.title} · {new Date(p.updatedAt).toLocaleString()}</span>
                  <button type="button" className="btn" aria-label={`Open recent project ${p.title}`} onClick={() => store.openProject(p.id).then(() => onOpenStudio()).catch(() => setError('Could not open project'))}>Open</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No saved projects yet. Create one in the Studio and it will appear here.</p>
          )}
        </section>
      </div>
    </div>
  );
}

import { useRef, useState } from 'react';
import { Upload, Film, Layers, Scissors, Mic, Music, Clock } from 'lucide-react';
import type { ProjectStore } from '../store/projectStore';
import { decodeAudioFile, extractAudioFromVideo, validateMediaFile } from '../audio/decode';

export function HomePage({ store, onOpenStudio }: { store: ProjectStore; onOpenStudio: () => void }) {
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const mergeRef = useRef<HTMLInputElement>(null);

  const handleAudio = async (files: FileList | null, trackId?: string) => {
    if (!files?.length) return;
    setError('');
    setBusy('Decoding audio');
    try {
      for (const file of Array.from(files)) {
        const validation = validateMediaFile(file, 'audio', store.settings.maxFileSizeMB);
        if (validation) throw new Error(validation);
        setBusy(`Decoding ${file.name}`);
        const data = await decodeAudioFile(file, (p) => setProgress(p));
        const target = trackId ?? store.project.tracks[0]?.id ?? store.project.selectedTrackId ?? undefined;
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
      const data = await extractAudioFromVideo(file, (p, m) => { setProgress(p); setBusy(m); });
      await store.importAudioData(data, `${file.name} (audio)`, store.project.tracks[0]?.id);
      store.announce(`Extracted audio from ${file.name} — original video kept separately`);
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
      const datas = [];
      for (const file of Array.from(files)) {
        const v = validateMediaFile(file, 'audio', store.settings.maxFileSizeMB);
        if (v) throw new Error(v);
        datas.push({ data: await decodeAudioFile(file), name: file.name });
      }
      // Store as separate clips sequentially; user can adjust gaps in Studio
      for (const { data, name } of datas) {
        await store.importAudioData(data, name);
      }
      store.announce(`Imported ${datas.length} files for merging`);
      onOpenStudio();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      if (mergeRef.current) mergeRef.current.value = '';
    }
  };

  return (
    <div className="home">
      <header className="home-hero">
        <h1>Wishes Audio Editor</h1>
        <p>Upload, record, separate vocals, pitch and time-stretch, and mix multitrack projects — all in your browser.</p>
        {busy && <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={busy}><div className="progress-bar" style={{ width: `${progress * 100}%` }} />{busy} {progress ? `${Math.round(progress * 100)}%` : ''}</div>}
        {error && <div className="error" role="alert">{error}</div>}
      </header>

      <div className="home-grid">
        <section className="home-card">
          <h2><Upload size={20} aria-hidden="true" /> Upload Audio</h2>
          <p>WAV, MP3, M4A/AAC, OGG, FLAC where the browser decoder supports them.</p>
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
          <p>MP4 and WebM where supported. The original video is preserved; only its audio is edited.</p>
          <button type="button" className="btn btn-primary" aria-label="Upload video to extract audio" onClick={() => videoRef.current?.click()} disabled={Boolean(busy)}>Choose video</button>
          <input ref={videoRef} type="file" accept="video/*,.mp4,.m4v,.webm,.mov" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => handleVideo(e.target.files)} />
          <p className="hint">The editor processes the extracted audio and makes it clear it is not silently discarding the video.</p>
        </section>

        <section className="home-card">
          <h2><Layers size={20} aria-hidden="true" /> Merge Audio</h2>
          <p>Import several files, arrange order, and export the combined result.</p>
          <button type="button" className="btn" aria-label="Import files to merge" onClick={() => mergeRef.current?.click()} disabled={Boolean(busy)}>Import for merging</button>
          <input ref={mergeRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(e) => handleMergeFiles(e.target.files)} />
          <button type="button" className="btn" aria-label="Open multitrack editor to arrange merge" onClick={onOpenStudio}>Open Studio to arrange</button>
        </section>

        <section className="home-card">
          <h2><Scissors size={20} aria-hidden="true" /> Remove Silence</h2>
          <p>Analyse the real signal, preview silent regions, and remove only confirmed sections.</p>
          <button type="button" className="btn" aria-label="Open remove silence in studio" onClick={onOpenStudio}>Open in Studio</button>
        </section>

        <section className="home-card">
          <h2><Music size={20} aria-hidden="true" /> Multitrack Editor</h2>
          <p>Voice 1–4 and unlimited additional tracks with independent pitch, effects, and timing.</p>
          <button type="button" className="btn btn-primary" aria-label="Open multitrack editor" onClick={onOpenStudio}>Open Studio</button>
          <div className="row">
            <button type="button" className="btn" aria-label="Create new track" onClick={() => store.addTrack()}>New track</button>
            <button type="button" className="btn" aria-label="Zoom timeline in" onClick={() => store.setZoom(store.project.zoom * 1.25)}>Zoom in</button>
            <button type="button" className="btn" aria-label="Zoom timeline out" onClick={() => store.setZoom(store.project.zoom / 1.25)}>Zoom out</button>
          </div>
        </section>

        <section className="home-card">
          <h2><Mic size={20} aria-hidden="true" /> Record Voice</h2>
          <p>Microphone capture with device selection, count-in, monitoring toggle, and level meter.</p>
          <button type="button" className="btn" aria-label="Open recording studio" onClick={onOpenStudio}>Open Recorder</button>
        </section>

        <section className="home-card">
          <h2><Music size={20} aria-hidden="true" /> Karaoke Recording</h2>
          <p>Record over an accompaniment with synchronized playback and independent vocal effects.</p>
          <button type="button" className="btn" aria-label="Open karaoke recording" onClick={onOpenStudio}>Open Karaoke</button>
        </section>

        <section className="home-card">
          <h2><Clock size={20} aria-hidden="true" /> Recent Project</h2>
          {store.projects[0] ? (
            <>
              <p>{store.projects[0].title} — {new Date(store.projects[0].updatedAt).toLocaleString()}</p>
              <button type="button" className="btn btn-primary" aria-label={`Open recent project ${store.projects[0].title}`} onClick={() => store.openProject(store.projects[0].id).then(onOpenStudio)}>Open Recent Project</button>
            </>
          ) : (
            <p className="hint">No saved projects yet. Create one in the Studio and it will appear here.</p>
          )}
        </section>
      </div>
    </div>
  );
}

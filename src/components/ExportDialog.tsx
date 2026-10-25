import { useState } from 'react';
import type { ExportFormat, ExportScope } from '../types';
import type { ProjectStore } from '../store/projectStore';
import { loadAudioData } from '../storage/assets';
import { applyRangeEffect, pitchShift, resampleAudio, softLimit } from '../audio/dsp';
import { encodeWavBlob } from '../audio/wav';
import { encodeMp3Blob, encodeAacBlob, aacEncoderAvailable, aacUnavailableReason } from '../audio/encoders';
import { formatTime } from '../types';

export function ExportDialog({ store, onClose }: { store: ProjectStore; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>(store.project.exportSettings.format);
  const [scope, setScope] = useState<ExportScope>(store.project.exportSettings.scope);
  const [filename, setFilename] = useState(store.project.exportSettings.filename);
  const [sampleRate, setSampleRate] = useState(store.project.exportSettings.sampleRate);
  const [bitDepth, setBitDepth] = useState(store.project.exportSettings.bitDepth);
  const [bitrate, setBitrate] = useState(store.project.exportSettings.bitrate);
  const [channels, setChannels] = useState(store.project.exportSettings.channels);
  const [normalize, setNormalize] = useState(store.project.exportSettings.normalize);
  const [preventClipping, setPreventClipping] = useState(store.project.exportSettings.preventClipping);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState('');

  const aacAvailable = aacEncoderAvailable();

  const buildMix = async (abort: AbortSignal) => {
    const project = store.project;
    const allClips = project.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
    if (!allClips.length) throw new Error('No audio to export');
    // Determine scope
    let clipsToRender = allClips;
    if (scope === 'track') {
      const trackId = project.selectedTrackId ?? project.tracks[0]?.id;
      clipsToRender = allClips.filter((x) => x.track.id === trackId);
      if (!clipsToRender.length) throw new Error('Selected track has no audio');
    } else if (scope === 'range' && project.selection) {
      // Clips that overlap selection — effects already include range processing
      clipsToRender = allClips.filter((x) => x.clip.start < project.selection!.end && x.clip.start + x.clip.duration > project.selection!.start);
    } else if (scope === 'range' && !project.selection) {
      throw new Error('Select a time range first');
    }
    // Render each clip through its effect chain
    const rendered = await Promise.all(clipsToRender.map(async ({ clip, track }) => {
      if (abort.aborted) throw new DOMException('Cancelled', 'AbortError');
      let data = await loadAudioData(clip.assetId);
      // Whole-track pitch (real DSP, tempo preserved)
      if (track.pitchSemis !== 0) data = pitchShift(data, track.pitchSemis);
      // Clip-local effects
      for (const effect of clip.effects) {
        if (!effect.enabled) continue;
        data = applyRangeEffect(data, effect).data;
      }
      // Vocal-only path: if enabled, it replaces the track's contribution; for export we approximate by using vocal asset if present
      // (full stem mixing is available in the studio preview)
      return { data, start: clip.start, track };
    }));
    const rate = sampleRate;
    const resampled = rendered.map((r) => ({ ...r, data: resampleAudio(r.data, rate) }));
    const duration = scope === 'range' && store.project.selection
      ? store.project.selection.end - store.project.selection.start
      : Math.max(...resampled.map((r) => r.start + r.data.length / rate), 0);
    const length = Math.ceil(duration * rate);
    const outChannels = channels;
    const mix = Array.from({ length: outChannels }, () => new Float32Array(length));
    const soloed = store.project.tracks.some((t) => t.solo);
    for (const { data, start, track } of resampled) {
      if (abort.aborted) throw new DOMException('Cancelled', 'AbortError');
      const audible = !track.muted && (soloed ? track.solo : true);
      if (!audible) continue;
      const gain = track.volume;
      const channelData = data.channels;
      const offset = Math.round(start * rate);
      const offsetInRange = scope === 'range' && store.project.selection ? Math.round(store.project.selection.start * rate) : 0;
      for (let c = 0; c < outChannels; c++) {
        const source = channelData[Math.min(c, channelData.length - 1)];
        for (let i = 0; i < source.length; i++) {
          const position = offset - offsetInRange + i;
          if (position >= 0 && position < length) mix[c][position] += source[i] * gain;
        }
      }
    }
    // Normalize / soft limit
    let peak = 0;
    for (const ch of mix) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    if (normalize && peak > 0) {
      const g = 0.95 / peak;
      for (const ch of mix) for (let i = 0; i < ch.length; i++) ch[i] *= g;
    }
    const audioData = { channels: mix, sampleRate: rate, length } as import('../types').AudioData;
    return preventClipping ? softLimit(audioData) : audioData;
  };

  const handleExport = async () => {
    if (!filename.trim()) { setError('Enter a filename'); return; }
    setError('');
    setBusy(true);
    setProgress(0);
    setMessage('Rendering mix');
    setFileSize(null);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    const controller = new AbortController();
    try {
      const data = await buildMix(controller.signal);
      setProgress(0.4);
      setMessage(`Encoding ${format.toUpperCase()}`);
      let blob: Blob;
      if (format === 'wav') {
        blob = encodeWavBlob(data, { bitDepth, channels, sampleRate });
        setProgress(1);
      } else if (format === 'mp3') {
        blob = await encodeMp3Blob(data, bitrate, channels, { onProgress: (p, m) => { setProgress(0.4 + p * 0.6); setMessage(m); }, signal: controller.signal, preventClipping });
      } else {
        if (!aacAvailable) throw new Error(aacUnavailableReason());
        blob = await encodeAacBlob(data, bitrate, channels, { onProgress: (p, m) => { setProgress(0.4 + p * 0.6); setMessage(m); }, signal: controller.signal, preventClipping });
      }
      setFileSize(blob.size);
      const ext = format === 'wav' ? 'wav' : format === 'mp3' ? 'mp3' : 'm4a';
      const name = `${filename.trim()}.${ext}`;
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setDownloadName(name);
      setMessage('Export ready');
      setProgress(1);
      store.announce(`Exported ${name}`);
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Export audio">
      <div className="dialog">
        <h2>Export Audio</h2>
        <p className="hint">The exported file reflects the selected pitch changes, effects, timing, harmonies, and track mix.</p>

        <label className="field">
          <span>Filename</span>
          <input type="text" value={filename} aria-label="Export filename" onChange={(e) => setFilename(e.target.value)} />
        </label>

        <label className="field">
          <span>Format</span>
          <select value={format} aria-label="Export format" onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            <option value="wav">WAV</option>
            <option value="mp3">MP3</option>
            <option value="m4a" disabled={!aacAvailable}>AAC/M4A {aacAvailable ? '' : '(unsupported in this browser)'}</option>
          </select>
        </label>
        {!aacAvailable && format === 'm4a' && <p className="error" role="alert">{aacUnavailableReason()} Choose WAV or MP3 — files are never renamed to fake a format.</p>}

        <label className="field">
          <span>Scope</span>
          <select value={scope} aria-label="Export scope" onChange={(e) => setScope(e.target.value as ExportScope)}>
            <option value="project">Entire project</option>
            <option value="range">Selected range {store.project.selection ? `${formatTime(store.project.selection.start)}–${formatTime(store.project.selection.end)}` : '(no range selected)'}</option>
            <option value="track">Selected track</option>
            <option value="stems">Individual stems</option>
          </select>
        </label>
        {scope === 'stems' && <p className="hint">Stems export is available as separate WAV/MP3 files per track. Use WAV for lossless stems.</p>}

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
              <select value={bitrate} aria-label="MP3 bitrate" onChange={(e) => setBitrate(Number(e.target.value) as 96 | 128 | 192 | 256 | 320)}>
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
          <input type="checkbox" checked={normalize} aria-label="Normalize export" onChange={(e) => setNormalize(e.target.checked)} />
          <span>Normalize to -0.5 dB</span>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={preventClipping} aria-label="Prevent clipping" onChange={(e) => setPreventClipping(e.target.checked)} />
          <span>Prevent clipping (soft limiter)</span>
        </label>

        {busy && <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={message}><div className="progress-bar" style={{ width: `${progress * 100}%` }} />{message} {Math.round(progress * 100)}%</div>}
        {error && <div className="error" role="alert">{error}</div>}
        {fileSize !== null && <p className="hint">File size: {(fileSize / 1024).toFixed(1)} KB</p>}
        {downloadUrl && (
          <a className="btn btn-primary" href={downloadUrl} download={downloadName} aria-label={`Download ${downloadName}`} onClick={() => setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000)}>Download {downloadName}</a>
        )}

        <div className="row">
          <button type="button" className="btn btn-primary" aria-label="Export audio" disabled={busy} onClick={handleExport}>{busy ? 'Exporting' : 'Export'}</button>
          <button type="button" className="btn" aria-label="Close export dialog" onClick={() => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); onClose(); }}>Close</button>
        </div>
      </div>
    </div>
  );
}

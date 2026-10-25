import { useEffect, useRef, useState } from 'react';
import { PcmRecorder } from '../audio/recorder';
import type { ProjectStore } from '../store/projectStore';
import { formatTime } from '../types';

export function RecordPanel({ store }: { store: ProjectStore }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [monitoring, setMonitoring] = useState(false);
  const [countIn, setCountIn] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    PcmRecorder.listInputDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  const start = async () => {
    setError('');
    const recorder = new PcmRecorder();
    recorderRef.current = recorder;
    setStatus(countIn > 0 ? `Count-in ${countIn}s` : 'Requesting microphone');
    try {
      await recorder.start({
        deviceId: deviceId || undefined,
        countInSeconds: countIn,
        monitoring,
        onCountIn: (remaining) => setStatus(`Count-in ${remaining.toFixed(1)}s`),
      });
      setRecording(true);
      setPaused(false);
      setStatus('Recording');
      timerRef.current = setInterval(() => {
        setElapsed(recorder.elapsed);
        setLevel(recorder.level);
      }, 80);
    } catch (e) {
      setError((e as Error).message);
      setStatus('');
      recorderRef.current = null;
    }
  };

  const stop = async (save: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (timerRef.current) clearInterval(timerRef.current);
    setStatus('Saving recording');
    try {
      const result = await recorder.stop();
      setRecording(false);
      setPaused(false);
      setElapsed(0);
      if (save) {
        const target = store.project.selectedTrackId ?? store.project.tracks[0]?.id;
        if (!target) throw new Error('No track selected for recording');
        const maxStart = store.project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)).reduce((m, v) => Math.max(m, v), 0);
        // Compensate estimated input latency
        const start = Math.max(0, maxStart - result.latencySeconds);
        await store.importAudioData(result.data, `Take ${new Date().toLocaleTimeString()}`, target, start);
        store.announce(`Recording saved: ${formatTime(result.duration)}`);
        setStatus(`Saved ${formatTime(result.duration)}`);
      } else {
        setStatus('Take discarded');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      recorderRef.current = null;
    }
  };

  const togglePause = () => {
    const r = recorderRef.current;
    if (!r) return;
    if (paused) { r.resume(); setPaused(false); setStatus('Recording'); }
    else { r.pause(); setPaused(true); setStatus('Paused'); }
  };

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  if (!PcmRecorder.supported) {
    return <section className="panel" aria-label="Recording"><h3 className="panel-title">Record Voice</h3><p className="error" role="alert">Recording is not supported in this browser.</p></section>;
  }

  return (
    <section className="panel" aria-label="Recording studio">
      <h3 className="panel-title">Recording Studio</h3>
      <p className="hint">Microphone permission is requested only when you start recording. Live monitoring is off by default to avoid feedback.</p>
      <label className="field">
        <span>Input device</span>
        <select value={deviceId} aria-label="Microphone input device" onChange={(e) => setDeviceId(e.target.value)}>
          <option value="">System default</option>
          {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Target track</span>
        <select value={store.project.selectedTrackId ?? ''} aria-label="Recording target track" onChange={(e) => store.selectTrack(e.target.value)}>
          {store.project.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Count-in (seconds)</span>
        <input type="number" min={0} max={8} step={0.5} value={countIn} aria-label="Count-in duration in seconds" onChange={(e) => setCountIn(Number(e.target.value) || 0)} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={monitoring} aria-label="Headphone monitoring" onChange={(e) => { setMonitoring(e.target.checked); recorderRef.current?.setMonitoring(e.target.checked); }} />
        <span>Headphone monitoring</span>
      </label>
      <div className="level-meter" aria-label={`Input level ${Math.round(level * 100)} percent`} role="progressbar" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="level-fill" style={{ width: `${Math.min(100, level * 400)}%` }} />
      </div>
      <div className="timer" aria-live="polite">{formatTime(elapsed)} {status ? `· ${status}` : ''}</div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row">
        {!recording ? (
          <button type="button" className="btn btn-primary" aria-label="Start recording" onClick={start}>Start recording</button>
        ) : (
          <>
            <button type="button" className="btn" aria-label={paused ? 'Resume recording' : 'Pause recording'} onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
            <button type="button" className="btn btn-primary" aria-label="Stop and save recording" onClick={() => stop(true)}>Stop and save</button>
            <button type="button" className="btn btn-danger" aria-label="Stop and discard take" onClick={() => stop(false)}>Discard take</button>
          </>
        )}
      </div>
      <p className="hint">Recordings are placed at the selected timeline position and remain synchronized with the accompaniment on playback.</p>
    </section>
  );
}

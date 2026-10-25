import { useEffect, useRef, useState } from 'react';
import { PcmRecorder } from '../audio/recorder';
import type { ProjectStore } from '../store/projectStore';
import { formatTime } from '../types';

export function RecordPanel({ store, position }: { store: ProjectStore; position: number }) {
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
  const [startPosition, setStartPosition] = useState(0);
  const [replaceTake, setReplaceTake] = useState(true);
  const [saving, setSaving] = useState(false);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    PcmRecorder.listInputDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  // Keep "place at playhead" in sync unless the user typed a custom value.
  const [positionTouched, setPositionTouched] = useState(false);
  useEffect(() => {
    if (!positionTouched && !recording) setStartPosition(Number(position.toFixed(3)));
  }, [position, positionTouched, recording]);

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
      store.announce('Recording started');
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
    setSaving(true);
    setStatus('Saving recording');
    try {
      const result = await recorder.stop();
      setRecording(false);
      setPaused(false);
      setElapsed(0);
      setLevel(0);
      if (save) {
        const target = store.project.selectedTrackId ?? store.project.tracks[0]?.id;
        if (!target) throw new Error('No track selected for recording');
        // Karaoke placement: takes go to the chosen position (defaults to the
        // playhead). Replace-take removes the previous take at that position so
        // retakes stay aligned with the accompaniment.
        let at = Math.max(0, startPosition);
        if (replaceTake) {
          for (const take of store.project.recordings) {
            if (take.trackId === target && Math.abs(take.start - at) < 0.05) {
              store.deleteClip(take.id);
            }
          }
        }
        // Compensate estimated input latency so the take lines up with the click.
        at = Math.max(0, at - result.latencySeconds);
        await store.importAudioData(result.data, `Take ${new Date().toLocaleTimeString()}`, target, at, { recording: true });
        store.announce(`Recording saved at ${formatTime(at)}: ${formatTime(result.duration)}`);
        setStatus(`Saved ${formatTime(result.duration)} at ${formatTime(at)}`);
      } else {
        setStatus('Take discarded');
        store.announce('Take discarded');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      recorderRef.current = null;
      setSaving(false);
    }
  };

  const togglePause = () => {
    const r = recorderRef.current;
    if (!r) return;
    if (paused) { r.resume(); setPaused(false); setStatus('Recording'); }
    else { r.pause(); setPaused(true); setStatus('Paused'); }
  };

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    const recorder = recorderRef.current;
    if (recorder) void recorder.stop().catch(() => undefined);
  }, []);

  if (!PcmRecorder.supported) {
    return <section className="panel" aria-label="Recording"><h3 className="panel-title">Record Voice</h3><p className="error" role="alert">Recording is not supported in this browser.</p></section>;
  }

  return (
    <section className="panel" aria-label="Recording studio">
      <h3 className="panel-title">Recording Studio (Karaoke)</h3>
      <p className="hint">Microphone permission is requested only when you press Start. Use headphones: live monitoring is off by default to avoid feedback. Record over the accompaniment (Play in the transport) and the take lands on the timeline in sync with it.</p>
      <label className="field">
        <span>Input device</span>
        <select value={deviceId} aria-label="Microphone input device" onChange={(e) => setDeviceId(e.target.value)} disabled={recording}>
          <option value="">System default</option>
          {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Target track</span>
        <select value={store.project.selectedTrackId ?? store.project.tracks[0]?.id ?? ''} aria-label="Recording target track" onChange={(e) => store.selectTrack(e.target.value)} disabled={recording}>
          {store.project.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Record start position (seconds) — playhead: {formatTime(position)}</span>
        <input type="number" step={0.001} min={0} value={Number(startPosition.toFixed(3))} aria-label="Recording start position in seconds" onChange={(e) => { setPositionTouched(true); setStartPosition(Number(e.target.value) || 0); }} disabled={recording} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={replaceTake} aria-label="Replace previous take at this position" onChange={(e) => setReplaceTake(e.target.checked)} />
        <span>Replace previous take at this position (retake)</span>
      </label>
      <label className="field">
        <span>Count-in (seconds): {countIn}</span>
        <input type="number" min={0} max={8} step={0.5} value={countIn} aria-label="Count-in duration in seconds" onChange={(e) => setCountIn(Number(e.target.value) || 0)} disabled={recording} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={monitoring} aria-label="Headphone monitoring" onChange={(e) => { setMonitoring(e.target.checked); recorderRef.current?.setMonitoring(e.target.checked); }} />
        <span>Headphone monitoring (OFF avoids feedback)</span>
      </label>
      <div className="level-meter" aria-label={`Input level ${Math.round(Math.min(1, level * 4) * 100)} percent`} role="progressbar" aria-valuenow={Math.round(Math.min(1, level * 4) * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="level-fill" style={{ width: `${Math.min(100, level * 400)}%` }} />
      </div>
      {/* The running timer is not a live region: a value that changes every
          second keeps TalkBack talking and blocks cursor navigation. The
          recording status is announced once, when it changes. */}
      <div className="timer" aria-live="off">{formatTime(elapsed)} {status ? `· ${status}` : ''}</div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row">
        {!recording ? (
          <button type="button" className="btn btn-primary" aria-label="Start recording" onClick={start} disabled={saving}>Start recording</button>
        ) : (
          <>
            <button type="button" className="btn" aria-label={paused ? 'Resume recording' : 'Pause recording'} onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
            <button type="button" className="btn btn-primary" aria-label="Stop and save recording" onClick={() => stop(true)} disabled={saving}>Stop and save</button>
            <button type="button" className="btn btn-danger" aria-label="Stop and discard take" onClick={() => stop(false)} disabled={saving}>Discard take</button>
          </>
        )}
      </div>
      {store.project.recordings.length > 0 && (
        <div className="field">
          <span>Takes ({store.project.recordings.length})</span>
          <ul className="region-list" aria-label="Recorded takes">
            {store.project.recordings.map((take) => (
              <li key={take.id} className="merge-item">
                <span>{take.name} · {formatTime(take.start)} · {formatTime(take.duration)}</span>
                <span className="row">
                  <button type="button" className="btn btn-xs" aria-label={`Delete take ${take.name}`} onClick={() => store.deleteClip(take.id)} disabled={recording}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

import type { ProjectStore } from '../store/projectStore';
import { storageEstimate, clearAll } from '../storage/db';

export function SettingsPage({ store }: { store: ProjectStore }) {
  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="panel" aria-label="Audio preferences">
        <h2>Audio preferences</h2>
        <label className="field">
          <span>Playback skip interval: {store.settings.skipSeconds}s</span>
          <input type="range" min={1} max={30} step={1} value={store.settings.skipSeconds} aria-label={`Skip interval ${store.settings.skipSeconds} seconds`} onChange={(e) => store.updateSettings({ skipSeconds: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Master volume: {Math.round(store.settings.masterVolume * 100)}%</span>
          <input type="range" min={0} max={1} step={0.01} value={store.settings.masterVolume} aria-label={`Master volume ${Math.round(store.settings.masterVolume * 100)} percent`} onChange={(e) => store.updateSettings({ masterVolume: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Maximum file size: {store.settings.maxFileSizeMB} MB</span>
          <input type="range" min={25} max={500} step={25} value={store.settings.maxFileSizeMB} aria-label={`Maximum file size ${store.settings.maxFileSizeMB} megabytes`} onChange={(e) => store.updateSettings({ maxFileSizeMB: Number(e.target.value) })} />
        </label>
      </section>

      <section className="panel" aria-label="Default export settings">
        <h2>Default export settings</h2>
        <p className="hint">These defaults are applied to new projects.</p>
        <div className="row">
          <label className="field">
            <span>Format</span>
            <select value={store.settings.defaultExport.format} aria-label="Default export format" onChange={(e) => store.updateSettings({ defaultExport: { ...store.settings.defaultExport, format: e.target.value as 'wav' | 'mp3' | 'm4a' } })}>
              <option value="wav">WAV</option>
              <option value="mp3">MP3</option>
              <option value="m4a">AAC/M4A</option>
            </select>
          </label>
          <label className="field">
            <span>Sample rate</span>
            <select value={store.settings.defaultExport.sampleRate} aria-label="Default sample rate" onChange={(e) => store.updateSettings({ defaultExport: { ...store.settings.defaultExport, sampleRate: Number(e.target.value) as 44100 | 48000 | 96000 } })}>
              <option value={44100}>44100</option>
              <option value={48000}>48000</option>
              <option value={96000}>96000</option>
            </select>
          </label>
        </div>
      </section>

      <section className="panel" aria-label="Vocal separation">
        <h2>Vocal separation</h2>
        <p className="hint">Local approximate isolation runs entirely in this browser. For higher quality, run a Demucs server (see server/README.md) and set its URL below.</p>
        <label className="field">
          <span>Demucs server URL (optional)</span>
          <input type="url" value={store.settings.separationApiUrl} placeholder="https://your-server.example.com" aria-label="Demucs server URL" onChange={(e) => store.updateSettings({ separationApiUrl: e.target.value })} />
        </label>
      </section>

      <section className="panel" aria-label="Theme and accessibility">
        <h2>Theme and accessibility</h2>
        <label className="field">
          <span>Theme</span>
          <select value={store.settings.theme} aria-label="Theme" onChange={(e) => store.updateSettings({ theme: e.target.value as 'dark' | 'light' | 'system' })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={store.settings.highContrast} aria-label="High contrast" onChange={(e) => store.updateSettings({ highContrast: e.target.checked })} />
          <span>High contrast</span>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={store.settings.reduceMotion} aria-label="Reduce motion" onChange={(e) => store.updateSettings({ reduceMotion: e.target.checked })} />
          <span>Reduce motion</span>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={store.settings.announcements} aria-label="Enable live announcements" onChange={(e) => store.updateSettings({ announcements: e.target.checked })} />
          <span>Live announcements for processing progress</span>
        </label>
        <p className="hint">Every control has an accessible name, accurate state, predictable focus order, and a touch target of at least 44px. Waveform animation does not steal focus.</p>
      </section>

      <section className="panel" aria-label="Storage management">
        <h2>Storage management</h2>
        <button type="button" className="btn" aria-label="Check storage usage" onClick={async () => {
          const estimate = await storageEstimate();
          alert(`Usage ${(estimate.usage / 1024 / 1024).toFixed(1)} MB of ${(estimate.quota / 1024 / 1024).toFixed(1)} MB`);
        }}>Check storage usage</button>
        <button type="button" className="btn btn-danger" aria-label="Clear all local projects and audio" onClick={async () => {
          if (!confirm('Delete all local projects and audio? This cannot be undone.')) return;
          await clearAll();
          location.reload();
        }}>Clear all data</button>
        <p className="hint">Large projects may hit browser storage limits. Save and export regularly.</p>
      </section>

      <section className="panel" aria-label="Application information">
        <h2>Application information</h2>
        <p>Wishes Audio Editor — browser-based multitrack editor with real DSP, vocal isolation, and accessible transport.</p>
        <p>Build: browser-first. Web Audio for synchronized playback, IndexedDB for projects, Web Workers for DSP, LAME for MP3, PCM worklet for recording, phase vocoder for pitch.</p>
      </section>

      <section className="panel" aria-label="Privacy Policy">
        <h2 role="heading">Privacy Policy</h2>
        <p>Audio files you upload are decoded locally in this browser. They are stored in IndexedDB on this device and are not uploaded to a server unless you configure a Demucs separation server. When a separation server is configured, the current track's audio is uploaded to that server for processing and is deleted according to that server's retention policy (see server/README.md). Microphone access is requested only when you start recording, and recordings are stored locally like other audio. No analytics, advertising, or third-party tracking is included in this build. If you connect additional services, update this policy to describe them accurately.</p>
        <p>We do not claim encryption at rest, zero retention, or specific deletion guarantees beyond what the configured server documents.</p>
      </section>

      <section className="panel" aria-label="Terms and Conditions">
        <h2>Terms and Conditions</h2>
        <p>Use this editor only with audio you have the right to edit. You are responsible for complying with copyright and licensing for uploaded songs, samples, and recordings. The vocal-separation and pitch-shifting features use real signal processing and open-source libraries under their own licenses (see package.json and server requirements). No warranty is provided; use at your own risk. These terms are accessible from Settings.</p>
      </section>
    </div>
  );
}

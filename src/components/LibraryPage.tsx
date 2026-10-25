import { useState } from 'react';
import type { ProjectStore } from '../store/projectStore';
import { formatTime } from '../types';

export function LibraryPage({ store, onOpen }: { store: ProjectStore; onOpen: () => void }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');

  return (
    <div className="library">
      <header className="library-header">
        <h1>Library</h1>
        <button type="button" className="btn btn-primary" aria-label="New project" onClick={() => store.newProject().then(onOpen).catch(() => setError('Could not create project'))}>New Project</button>
      </header>
      {error && <div className="error" role="alert">{error}</div>}
      {store.projects.length === 0 ? (
        <p className="hint">No saved projects yet. Projects store track names, order, offsets, volume, pitch and effect settings, harmony settings, timeline edits, selection, recording references, export preferences, duration and last-modified date.</p>
      ) : (
        <ul className="project-list" aria-label="Saved projects">
          {store.projects.map((project) => {
            const duration = project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)).reduce((m, v) => Math.max(m, v), 0);
            const clips = project.tracks.reduce((sum, t) => sum + t.clips.length, 0);
            return (
              <li key={project.id} className="project-card">
                <div className="project-info">
                  <h2>{project.title}</h2>
                  <p>{project.tracks.length} tracks · {clips} clips · {formatTime(duration)} · {new Date(project.updatedAt).toLocaleString()}</p>
                </div>
                <div className="row wrap">
                  <button type="button" className="btn btn-primary" aria-label={`Open ${project.title}`} onClick={() => store.openProject(project.id).then(onOpen).catch(() => setError('Could not open project'))}>Open</button>
                  <button type="button" className="btn" aria-label={`Duplicate ${project.title}`} onClick={() => store.duplicateProject(project.id).catch((e: Error) => setError(e.message))}>Duplicate</button>
                  {renaming === project.id ? (
                    <>
                      <input
                        type="text" value={name} aria-label={`New name for ${project.title}`}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            store.renameProject(project.id, name)
                              .then(() => setRenaming(null))
                              .catch((err: Error) => setError(err.message));
                          }
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                      <button type="button" className="btn" aria-label="Confirm rename" onClick={() => {
                        store.renameProject(project.id, name)
                          .then(() => setRenaming(null))
                          .catch((err: Error) => setError(err.message));
                      }}>Save</button>
                      <button type="button" className="btn" aria-label="Cancel rename" onClick={() => setRenaming(null)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" className="btn" aria-label={`Rename ${project.title}`} onClick={() => { setRenaming(project.id); setName(project.title); }}>Rename</button>
                  )}
                  {confirm === project.id ? (
                    <>
                      <span role="alert">Delete {project.title}?</span>
                      <button type="button" className="btn btn-danger" aria-label={`Confirm delete ${project.title}`} onClick={() => {
                        store.deleteProject(project.id).catch((e: Error) => setError(e.message));
                        setConfirm(null);
                      }}>Delete</button>
                      <button type="button" className="btn" aria-label="Cancel delete" onClick={() => setConfirm(null)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-danger" aria-label={`Delete ${project.title}`} onClick={() => setConfirm(project.id)}>Delete</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint">Reopening a saved project restores its actual editable state (tracks, clips, offsets, volumes, pitch, harmonies, effects, selection, recordings, export preferences). Projects and audio assets live in IndexedDB on this device.</p>
    </div>
  );
}

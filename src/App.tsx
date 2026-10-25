import { useState, useEffect } from 'react';
import { Navigation } from './components/Navigation';
import { HomePage } from './components/HomePage';
import { StudioPage, type StudioTab } from './components/StudioPage';
import { LibraryPage } from './components/LibraryPage';
import { SettingsPage } from './components/SettingsPage';
import { useProjectStore } from './store/projectStore';

export type View = 'home' | 'studio' | 'library' | 'settings';

export default function App() {
  const store = useProjectStore();
  const [view, setView] = useState<View>('home');
  const [studioTab, setStudioTab] = useState<StudioTab>('effects');

  useEffect(() => {
    const theme = store.settings.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : store.settings.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.highContrast = String(store.settings.highContrast);
    document.documentElement.dataset.reduceMotion = String(store.settings.reduceMotion);
  }, [store.settings.theme, store.settings.highContrast, store.settings.reduceMotion]);

  if (store.loading) return <div className="loading" role="status" aria-live="polite">Loading Wishes Audio Editor…</div>;

  const titles: Record<View, string> = { home: 'Home', studio: store.project.title, library: 'Library', settings: 'Settings' };

  return (
    <div className="app">
      <a href="#main" className="skip-link">Skip to content</a>
      <Navigation view={view} onView={setView} title={titles[view]} />
      <main id="main" className="main">
        {view === 'home' && <HomePage store={store} onOpenStudio={(tab) => { if (tab) setStudioTab(tab); setView('studio'); }} />}
        {view === 'studio' && <StudioPage key={store.project.id} store={store} initialTab={studioTab} />}
        {view === 'library' && <LibraryPage store={store} onOpen={() => setView('studio')} />}
        {view === 'settings' && <SettingsPage store={store} />}
      </main>
      <div className="live-region" aria-live="polite" aria-atomic="true">{store.settings.announcements ? store.announcement : ''}</div>
    </div>
  );
}

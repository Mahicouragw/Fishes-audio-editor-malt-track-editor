import { Music2, Library, Settings, Home } from 'lucide-react';
import type { View } from '../App';

export function Navigation({ view, onView, title }: { view: View; onView: (v: View) => void; title: string }) {
  const items: Array<{ id: View; label: string; icon: typeof Home }> = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'studio', label: 'Studio', icon: Music2 },
    { id: 'library', label: 'Library', icon: Library },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];
  return (
    <nav className="nav" aria-label="Primary">
      <div className="nav-brand" aria-hidden="true">
        <span className="nav-logo">♪</span>
        <span className="nav-title">Wishes Audio Editor</span>
        <span className="nav-subtitle">{title}</span>
      </div>
      <div className="nav-links" role="tablist" aria-label="Sections">
        {items.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            aria-label={label}
            className={`nav-link ${view === id ? 'active' : ''}`}
            onClick={() => onView(id)}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

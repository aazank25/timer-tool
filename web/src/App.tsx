import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { FocusPage } from './pages/Focus';
import { ProjectsPage } from './pages/Projects';
import { ReviewPage } from './pages/Review';
import { SettingsPage } from './pages/Settings';
import { TodayPage } from './pages/Today';
import { Button, Swatch } from './components/ui';
import { useLiveSession, useSessionActions, useTheme } from './hooks';
import { clock } from './lib/format';
import { seriesColor } from './lib/palette';

const TABS = [
  { to: '/', label: 'Focus' },
  { to: '/today', label: 'Today' },
  { to: '/projects', label: 'Projects' },
  { to: '/review', label: 'Review' },
  { to: '/settings', label: 'Settings' },
];

export default function App() {
  const [, , dark] = useTheme();

  return (
    <div className="min-h-full">
      <Header dark={dark} />
      <main className="mx-auto max-w-6xl px-4 py-5">
        <Routes>
          <Route path="/" element={<FocusPage dark={dark} />} />
          <Route path="/today" element={<TodayPage dark={dark} />} />
          <Route path="/projects" element={<ProjectsPage dark={dark} />} />
          <Route path="/review" element={<ReviewPage dark={dark} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<FocusPage dark={dark} />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ dark }: { dark: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-plane/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <span className="text-sm font-semibold tracking-tight text-ink">FocusDesk</span>
        <nav className="flex gap-0.5">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                `rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  isActive ? 'bg-surface text-ink' : 'text-muted hover:text-ink-2'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto">
          <MiniTimer dark={dark} />
        </div>
      </div>
    </header>
  );
}

/**
 * The clock follows you across tabs — a timer you cannot see is a timer you
 * forget to stop.
 */
function MiniTimer({ dark }: { dark: boolean }) {
  const live = useLiveSession();
  const actions = useSessionActions();
  const navigate = useNavigate();

  if (!live.session) return null;
  const { session } = live;
  const over = live.overrunSeconds > 0;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="flex items-center gap-2 rounded-lg border border-hairline bg-surface
          px-2.5 py-1.5 text-xs hover:border-axis"
      >
        <Swatch color={seriesColor(session.projectColor, dark)} />
        <span className="max-w-40 truncate text-ink-2">{session.title}</span>
        <span className={`tabular font-semibold ${over ? 'text-warning' : 'text-ink'}`}>
          {over ? `+${clock(live.overrunSeconds)}` : clock(live.remainingSeconds)}
        </span>
      </button>
      {session.status === 'running' ? (
        <Button size="sm" variant="ghost" onClick={() => actions.pause.mutate(session.id)}>
          Pause
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => actions.resume.mutate(session.id)}>
          Resume
        </Button>
      )}
    </div>
  );
}

import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { FocusPage } from './pages/Focus';
import { ProjectsPage } from './pages/Projects';
import { ReviewPage } from './pages/Review';
import { SettingsPage } from './pages/Settings';
import { TodayPage } from './pages/Today';
import { Button } from './components/ui';
import { useLiveSession, useSessionActions, useTheme } from './hooks';
import { clock, duration } from './lib/format';
import { seriesColor } from './lib/palette';

type IconProps = { className?: string };

const Icon = {
  focus: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" />
    </svg>
  ),
  today: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...p}>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8.5 3.5v3M15.5 3.5v3" strokeLinecap="round" />
    </svg>
  ),
  projects: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...p}>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.4l1.8 2.2h7.8a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z" />
    </svg>
  ),
  review: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...p}>
      <path d="M4 20V4" strokeLinecap="round" />
      <path d="M4 20h16" strokeLinecap="round" />
      <path d="M8.5 20v-6M13 20V8M17.5 20v-9" strokeLinecap="round" />
    </svg>
  ),
  settings: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...p}>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 3.5v2M12 18.5v2M4.9 7.8l1.7 1M17.4 15.2l1.7 1M4.9 16.2l1.7-1M17.4 8.8l1.7-1" strokeLinecap="round" />
    </svg>
  ),
};

const TABS = [
  { to: '/', label: 'Focus', icon: Icon.focus },
  { to: '/today', label: 'Today', icon: Icon.today },
  { to: '/projects', label: 'Projects', icon: Icon.projects },
  { to: '/review', label: 'Review', icon: Icon.review },
  { to: '/settings', label: 'Settings', icon: Icon.settings },
];

export default function App() {
  const [, , dark] = useTheme();

  return (
    <div className="flex min-h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col border-l border-hairline">
        <LiveBar dark={dark} />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6">
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
    </div>
  );
}

function Sidebar() {
  return (
    <aside
      className="sticky top-0 flex h-dvh w-14 shrink-0 flex-col bg-plane px-2 py-3
        lg:w-52 lg:px-3"
    >
      <div className="mb-4 flex items-center gap-2 px-1 lg:px-2">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-white"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v4l2.5 1.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="hidden text-sm font-semibold tracking-tight text-ink lg:block">
          FocusDesk
        </span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            title={tab.label}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium
               transition-colors lg:px-2.5 ${
                 isActive
                   ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                   : 'text-muted hover:bg-surface/60 hover:text-ink-2'
               }`
            }
          >
            <tab.icon className="size-[18px] shrink-0" />
            <span className="hidden lg:block">{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

/**
 * The clock follows you across every screen — a timer you cannot see is a
 * timer you forget to stop.
 */
function LiveBar({ dark }: { dark: boolean }) {
  const live = useLiveSession();
  const actions = useSessionActions();
  const navigate = useNavigate();
  const { session } = live;

  if (!session) {
    return (
      <div className="sticky top-0 z-40 border-b border-hairline bg-plane/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <span className="text-xs text-muted">Nothing running</span>
          <Button size="sm" variant="primary" onClick={() => navigate('/')}>
            Start a block
          </Button>
        </div>
      </div>
    );
  }

  const color = seriesColor(session.projectColor, dark);
  const over = live.overrunSeconds > 0;
  const paused = session.status === 'paused';

  return (
    <div className="sticky top-0 z-40 border-b border-hairline bg-plane/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2 sm:px-6">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-1 text-left
            hover:bg-surface/60 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ background: color, opacity: paused ? 0.4 : 1 }}
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-ink">{session.title}</span>
            <span className="block truncate text-[11px] text-muted">
              {session.projectName ?? 'No project'}
              {paused && ' · paused'}
              {over && ` · ${duration(live.overrunSeconds)} over`}
            </span>
          </span>
        </button>

        <span
          className={`tabular shrink-0 text-lg font-semibold ${over ? 'text-warning' : 'text-ink'}`}
        >
          {over ? `+${clock(live.overrunSeconds)}` : clock(live.remainingSeconds)}
        </span>

        {paused ? (
          <Button size="sm" variant="primary" onClick={() => actions.resume.mutate(session.id)}>
            Resume
          </Button>
        ) : (
          <Button size="sm" onClick={() => actions.pause.mutate(session.id)}>
            Pause
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => navigate('/')}>
          Done
        </Button>
      </div>
    </div>
  );
}

# FocusDesk

A local-first deep-work timer that can tell you, at the end of a day, **what you
worked on, how long, and how focused you were.**

Blocks of time roll up to overarching **projects**, each block is titled with
what you actually did, and each gets a focus rating — so the day becomes
reviewable instead of a blur.

Everything lives in one SQLite file on your machine. The server binds to
loopback only. Nothing leaves the laptop unless you connect a calendar feed.

## Run it

```bash
npm install
npm run build
npm start          # http://127.0.0.1:4317
```

For development, with hot reload on both halves:

```bash
npm run dev        # api on :4317, UI on http://localhost:5173
```

Other scripts: `npm test` (server suite), `npm run typecheck`.

Requires Node 20.11+. `better-sqlite3` ships prebuilt binaries, so there is
nothing to compile.

## Where your data lives

`./data/focusdesk.sqlite` — a plain SQLite file. Copy it to back it up, open it
with any SQLite tool, delete it to start over. Override the location with
`FOCUSDESK_DATA_DIR`; the port with `FOCUSDESK_PORT`.

## The loop

1. **Focus** — start one of your saved timers with a single click, or name a new
   block: project, what you're working on, a length. Pause, add 5 minutes, or
   log an interruption without stopping the clock.
2. **Finish** — rate the block 1–5 (number keys), rewrite the title to what you
   actually did, add notes.
3. **Today** — the shape of the day: timeline, time per project, time per hour,
   daily target, and the full block log (click any row to fix it).
4. **Review** — 7/30/90 days: where the time went, and which hours you actually
   focus in.

**Saved timers** are the fast path. The list builds itself from the
project + task pairs you keep returning to, so it is useful on day two without
anyone curating it; pin one to hold it at the top.

The clock is owned by the server and stored as run/pause segments, so a
refresh, a closed lid or a restart loses nothing, and paused time is never
counted as focus.

## Connect a calendar (optional)

Settings → Calendar. Paste a private ICS feed URL — no OAuth app needed:

- **Google Calendar** — Settings → your calendar → Integrate calendar →
  *Secret address in iCal format*
- **Outlook / Microsoft 365** — Calendar → Share → Publish a calendar → *Can
  view all details* → copy the ICS link

Recurring meetings are expanded. Attribute a meeting to a project once and later
instances of the same meeting inherit it. You can log a meeting as time spent or
add it to the day's plan.

That URL is a secret — anyone holding it can read the calendar. It is stored in
your local database and never sent back to the browser.

Note that a published ICS feed can lag the real calendar by hours; see
[docs/PLAN.md](docs/PLAN.md) for the API-based alternative.

## Layout

```
server/   Express + SQLite. Owns the clock, the rollups and integration secrets.
  src/lib/      sessions (timer), stats (rollups), calendar (ICS), time, settings
  src/routes/   projects, sessions, timers, plan, stats, settings, calendar
  test/         timer accounting, day boundaries, rollups, ICS parsing
web/      React + Vite + Tailwind. Focus · Today · Projects · Review · Settings
docs/     PLAN.md — the model, what's built, and what's next
```

## What's next

Notion context (meeting notes and transcripts attached to projects and days),
real calendar APIs, and a tray/menu-bar countdown. See
[docs/PLAN.md](docs/PLAN.md).

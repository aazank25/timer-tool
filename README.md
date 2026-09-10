# FocusDesk

A local-first deep-work timer that can tell you, at the end of a day, **what you
worked on, how long, and how focused you were.**

Blocks of time roll up to overarching **projects**, each block is titled with
what you actually did, and each gets a focus rating — so the day becomes
reviewable instead of a blur.

Everything lives in one SQLite file on your machine. The server binds to
loopback only. Nothing leaves the laptop unless you connect a calendar feed.

## Install it as a real app

One command builds a proper desktop app — a dock icon, a menu-bar countdown,
launch at login, and no terminal or browser tab in sight:

```bash
npm install
npm run desktop:mac      # or desktop:win / desktop:linux
```

The installer lands in `desktop/release/`. On macOS you get two disk images —
take **`FocusDesk-0.1.0-arm64.dmg`** on any Apple Silicon Mac (M1 and later)
and the plain `x64` one on an Intel Mac. Open it, drag FocusDesk to
Applications, done.

To run it without packaging, for a quick look: `npm run desktop`.

### What you get

- **A menu-bar countdown.** The remaining time sits in the menu bar; its menu
  pauses, resumes, logs an interruption or opens the window.
- **Closing the window doesn't stop the clock** — the app parks in the menu bar
  and keeps counting. Quit properly from the menu-bar item or ⌘Q.
- **Global hotkeys.** ⌘⇧F shows the window; ⌘⇧Space pauses or resumes the
  running block from anywhere.
- **Launch at login**, off by default — the menu-bar item has the toggle.
- **Offline.** The whole thing runs inside the app; nothing needs a network
  except a calendar sync you set up yourself.

### First launch on macOS

An app you build yourself opens normally. If you move the `.dmg` between
machines, macOS quarantines it and shows "FocusDesk cannot be opened" — then
**right-click the app → Open** once, and it is trusted from then on. If it
still refuses (which happens to unsigned Apple Silicon builds), re-sign it
locally:

```bash
codesign --force --deep --sign - /Applications/FocusDesk.app
```

Building with an Apple Developer certificate in your keychain signs it
properly and skips all of that. To force an unsigned build:
`CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:mac`.

## Run it in a browser instead

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

One plain SQLite file. Copy it to back it up, open it with any SQLite tool,
delete it to start over.

| How you run it | Location |
|---|---|
| Desktop app (macOS) | `~/Library/Application Support/FocusDesk/data/focusdesk.sqlite` |
| Desktop app (Windows) | `%APPDATA%\FocusDesk\data\focusdesk.sqlite` |
| From the repo | `./data/focusdesk.sqlite` |

The menu-bar item's **Reveal data folder** opens it. Override the location with
`FOCUSDESK_DATA_DIR`, and the browser port with `FOCUSDESK_PORT`.

Because the app keeps its data in Application Support, rebuilding or
reinstalling it never touches your history.

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
  src/app.ts    boots the API and client on a port; embedded by the desktop app
  src/lib/      sessions (timer), stats (rollups), calendar (ICS), time, settings
  src/routes/   projects, sessions, timers, plan, stats, settings, calendar
  test/         timer accounting, day boundaries, rollups, ICS parsing
web/      React + Vite + Tailwind. Focus · Today · Projects · Review · Settings
desktop/  Electron shell: menu-bar countdown, hotkeys, packaging
  main.mjs      window, tray, shortcuts; starts the server in-process
  scripts/      icon generator and payload bundler (no binaries in git)
docs/     PLAN.md — the model, what's built, and what's next
```

## What's next

Notion context — meeting notes and transcripts attached to projects and days —
then real calendar APIs. See [docs/PLAN.md](docs/PLAN.md).

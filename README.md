# FocusDesk

A local-first deep-work timer that can tell you, at the end of a day, **what you
worked on, how long, and how focused you were.**

Blocks of time roll up to overarching **projects**, each block is titled with
what you actually did, and each gets a focus rating — so the day becomes
reviewable instead of a blur. Smaller **tasks** — the rows of a weekly
priorities list — can be what a block is for, so each shows the time really
logged against its estimate.

Everything lives in one SQLite file on your machine. The server binds to
loopback only. Nothing leaves the laptop unless you connect a calendar feed.

## Install it as a real app

One command builds a proper desktop app — a dock icon, a menu-bar clock,
launch at login, and no terminal or browser tab in sight:

```bash
npm install
npm run desktop:mac      # or desktop:win / desktop:linux
```

Needs **Node 22 or newer** (`node -v`). Nothing gets compiled: SQLite arrives as
a prebuilt Node-API binary, which is why no Xcode, Python or build toolchain is
required and why the same binary works under both Node and Electron.

The installer lands in `desktop/release/`. On macOS you get two disk images —
take **`FocusDesk-0.1.0-arm64.dmg`** on any Apple Silicon Mac (M1 and later)
and the plain `x64` one on an Intel Mac. Open it, drag FocusDesk to
Applications, done.

To run it without packaging, for a quick look: `npm run desktop`.

### What you get

- **A menu-bar clock.** The elapsed time sits in the menu bar (the remaining
  time, for a Pomodoro); its menu pauses, resumes, logs an interruption or opens
  the window.
- **Closing the window doesn't stop the clock** — the app parks in the menu bar
  and keeps counting. Quit properly from the menu-bar item or ⌘Q.
- **Quick switch.** ⌘⌥K, from any app, pops a small box over whatever you are
  doing. Type a few letters of a task or saved timer and press Enter: the block
  on the clock is finished and the new one starts, and the box is gone and you
  are back where you were. If a focus block was running it asks how it went
  first (1–5, or Enter to skip); a break is just stopped. Escape backs out. It
  works whenever FocusDesk is running, with its window open or not. Change the
  shortcut, or turn it off, in Settings → Quick switch.
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

Requires Node 22+. `better-sqlite3` ships prebuilt Node-API binaries for every
platform, so there is nothing to compile and no toolchain to install.

## Where your data lives

One plain SQLite file. Open it with any SQLite tool, or delete it to start over.

To back it up, **quit FocusDesk first** (menu bar → Quit FocusDesk), then copy
the file. While the app is running, recent changes sit in a `-wal` file beside
it, so a plain copy can be incomplete or unreadable. To back up without
quitting, let SQLite take a consistent snapshot:

```bash
sqlite3 ~/Library/Application\ Support/FocusDesk/data/focusdesk.sqlite \
  "VACUUM INTO '$HOME/Desktop/focusdesk-backup.sqlite'"
```

The app takes the same kind of snapshot itself before any upgrade changes the
database's format, leaving `focusdesk.backup-before-…sqlite` files beside it.

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
   block: project, what you're working on (or the task it's for), and
   optionally a guess at how long it will take. It runs as a stopwatch until you
   stop it; pick Pomodoro for a fixed-length countdown instead. Pause, add 5
   minutes to a Pomodoro, or log an interruption without stopping the clock:
   *Got interrupted* opens a short list (Slack / chat, a meeting, someone
   stopping by, a phone call, email, something else, or no reason), and one tap
   logs it.
2. **Finish** — rate the block 1–5 (number keys), rewrite the title to what you
   actually did, add notes.
3. **Today** — the shape of the day: timeline, time per project, time per hour,
   daily target, and the full block log (click any row to fix it).
4. **Review** — 7/30/90 days: where the time went, which hours you actually
   focus in, what interrupted you (by the reason you tapped, with the ones you
   logged without a reason, or from before reasons existed, counted apart), and
   how your estimates hold up: the median of actual over estimate for finished
   blocks and completed tasks, overall and by project, over the last 90 days.
5. **Wrap up** — at the end of the day, *Wrap up the day* (a button on Today)
   closes it out: rate the blocks you left unrated with one tap each, move the
   tasks you worked on along, leave yourself a line for tomorrow, and copy a
   short plain-text summary into Slack. *Done for the day* stamps it. On Monday,
   *Weekly review* (a button on Review) does the same for the week: totals, the
   time per day and project, what got done and what is still open, a line for
   the week ahead, and a summary to copy. A block still on the clock counts in
   these totals, with the time it has so far, so wrapping up before you stop it
   does not leave it out.

**Saved timers** are the fast path. The list builds itself from the
project + task pairs you keep returning to, so it is useful on day two without
anyone curating it; pin one to hold it at the top.

**Quick switch** is the faster one, for moving between things without going back
to the window: ⌘⌥K, a few letters, Enter. With nothing typed it lists your saved
timers first and then your open tasks. Typing searches both by title and project,
best match first, and once there is anything typed the last row starts a new
block with exactly what you typed, whether or not anything else fits. Starting a
task files the block under the task's project and moves the task along, exactly
as starting it from the Tasks tab does. Finishing the old block and starting the
new one is one step on the server, so a start that is refused (a task deleted in
the meantime) leaves the block you were on running, as it was. If the box was put
away while that was on its way, the refusal is what it opens on the next time.

An app cannot be told that another app already owns a keyboard shortcut, so if
pressing yours does nothing, pick another in Settings. What you type there is
checked, because Electron is not: a name it does not know is dropped without a
word and the rest registered, so a typo would grab some other key. FocusDesk
accepts a deliberate subset of what Electron does: letters, digits, F1–F24 and
Space, Tab, Enter, Escape, Backspace, Delete, Insert, the arrows, Home, End,
PageUp, PageDown and Plus. It refuses punctuation keys, the lock keys (Caps
Lock, Num Lock, Scroll Lock), the numeric keypad, media and volume keys,
PrintScreen and AltGr. It also wants at least one of Command, Control,
CommandOrControl or Super in the shortcut, because Shift or Alt (Option) on
their own would take ordinary typing from every app: ⇧A is a capital A, and on a
Mac ⌥A is å. The function keys type nothing, so F1–F24 may use any modifier
(Shift+F5 is fine; Shift+A is not). ⌘⇧F and ⌘⇧Space are FocusDesk's own
shortcuts, and are refused here too. The default is ⌘⌥K, not ⌘⇧K, which is Browse
DMs in Slack and Delete Line in VS Code. The card shows the shortcut that is
really registered, or why a new one could not be, and when the app cannot
register what you saved it puts the setting back to the one that works, so a
restart never finds a shortcut it cannot have.

**Tasks** are the weekly priorities list that replaces a spreadsheet: a row for
each thing that needs doing, with its project (or none), priority, status,
target date and estimate, grouped by the week it sits in. Press ▶ on a row, or
pick the task on the Focus screen, and the block counts against it — the estimate
finally has an actual beside it. A task moves to *in progress* when you start
work on it, and deleting one keeps every block logged on it.

Like the spreadsheet's separate *Week Of* and *Date Added* columns, a task's week
is its own: it starts as the week the task was added and stays put when you edit
the day it was added. What moves it is the *Week of* field in the edit dialog (any
day of the week will do) or the banner that appears when unfinished tasks are
left behind in earlier weeks: **Carry into this week** brings them all forward at
once, to the bottom of their priority and in the order they had. A task that has
been carried says so, with the week it was added in on hover.

Inside a week, the rows of one priority stay in the order you put them in: a new
task goes to the bottom, like a row added to the end of the sheet, and you drag a
row by its grip to put it elsewhere in its priority — or focus the grip and press
↑ or ↓. Forgot to pick the task before you started? Click the block in Today's
block log and link it there; the task moves along as if you had started the block
on it.

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
  src/lib/      sessions (timer, and quick switch's stop-and-start), tasks, stats
                (rollups), wrapup (day and week reviews), calendar (ICS), time,
                settings, accelerator (the shortcut rule)
  src/routes/   projects, sessions, tasks, timers, plan, stats, wrapup, settings,
                calendar
  test/         timer accounting, stopwatch, saved-timer mode, day boundaries,
                rollups, ICS parsing, migration and backup; tasks (status dates,
                logged time, validation, ordering and moves, linking a block
                later, migration 4); insights (interruption reasons and their
                stats, estimate accuracy, migration 5); carry-over (the stored
                week, carrying unfinished tasks forward, migration 6); wrap-up
                (live totals, notes, done stamps, the weekly sort, the summary
                text, the setting, migration 7); switch (quick switch, the
                shortcut rule)
web/      React + Vite + Tailwind. Focus · Today · Tasks · Projects · Review · Settings,
          the wrap-up pages (/wrap-up, /wrap-up/week) reached from Today and Review,
          and the quick-switch box at /palette, which has no chrome of its own
desktop/  Electron shell: menu-bar clock, hotkeys, packaging
  main.mjs      window, tray, shortcuts; starts the server in-process
  palette.mjs   the quick-switch window: frameless, raised over other apps
  preload.cjs   the three calls a page may make of the shell (CommonJS on purpose)
  scripts/      icon generator and payload bundler (no binaries in git)
docs/     PLAN.md — the model, what's built, and what's next
```

## What's next

Notion context — meeting notes and transcripts attached to projects and days —
then real calendar APIs. See [docs/PLAN.md](docs/PLAN.md).

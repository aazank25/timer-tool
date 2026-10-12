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
npm ci
npm run desktop:mac      # or desktop:win / desktop:linux
```

Needs **Node 22 or newer** (`node -v`). Nothing gets compiled: SQLite arrives as
a prebuilt Node-API binary, which is why no Xcode, Python or build toolchain is
required and why the same binary works under both Node and Electron. `npm ci`
installs exactly what the lockfiles say and never rewrites them, which is why it
is used everywhere here, in the desktop scripts too. Those run it only when
`desktop/node_modules` is missing or was installed from another
`package-lock.json` (or on another platform), so running `npm run desktop` a
second time starts at once instead of installing Electron again.

The installer lands in `desktop/release/`. On macOS `desktop:mac` makes **one**
disk image, for the chip of the Mac you build it on: on Apple silicon (M1 and
later) that is `FocusDesk-<version>-arm64.dmg`, on an Intel Mac the plain
`FocusDesk-<version>.dmg`. Open it, drag FocusDesk to Applications, done. To
make both, for someone else's Mac, run `npm run desktop:mac:all`.

To run it without packaging, for a quick look: `npm run desktop`.

### What you get

- **A menu-bar clock.** The elapsed time sits in the menu bar (the remaining
  time, for a Pomodoro); its menu pauses, resumes, logs an interruption or opens
  the window. *Got interrupted ▸* is a submenu of the reasons (Slack / chat, a
  meeting, someone stopping by, a phone call, email, something else, or *No
  reason*), so naming it is one more click, as in the window; on a break it logs
  at once.
- **Away detection.** If the screen locks, the Mac goes to sleep, another user
  takes over, or you leave it untouched for `away_minutes` (ten by default) while
  a focus block is running, the app tells the server when you are back, and
  FocusDesk asks whether to keep that time or drop it. The stretch starts at the
  last time you touched the machine, so a Mac that locks itself after five
  minutes of nobody there counts those five, and it ends at your return: the
  unlock, the wake-up, or your first keystroke. If an unlock or wake-up is
  missed, input at a screen that is no longer locked ends it, and no stretch is
  reported as longer than twelve hours. The block it is held against is the one
  on the clock when it begins. A paused block, a break and no block at all are
  not reported, and neither is anything shorter than the threshold. Locking,
  sleeping, waking and unlocking is one stretch, not three.
- **Notifications.** What needs your attention (see below) is a notification
  the first time it is asked, if you are there to see it: the screen unlocked and
  the Mac touched in the last two minutes. If you are not, it waits until you are
  back. Clicking one opens the window; the end-of-day and last-week ones take it to
  the page they are about (the wrap-up, last week's review), and the nudge to
  start a block opens quick switch instead. A notification is taken down when its
  question goes away. What the app has told you is kept only while it runs, so
  after a restart whatever is still waiting is told once more.
- **Needs attention, in the menu bar.** While anything is waiting, the menu
  starts with a *Needs attention* section, a submenu for each question with the
  same answers as the banners, and a dot comes before the clock. An answer that
  is refused (it was answered in the window a moment ago) is shown, not dropped.
- **Closing the window is your call.** The first time you press the close button
  it asks whether to keep FocusDesk running in the menu bar (where the clock, away
  detection and the reminders keep going while the window is closed) or to quit.
  Tick *Don't ask again* to keep the answer; Settings → *Closing the window*
  changes it later. Quit any time from the menu-bar item or ⌘Q.
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

**Notifications.** The first time FocusDesk has something to say, macOS may ask
whether it may; if you said no, or never saw the question, switch it on in System
Settings → Notifications → FocusDesk. A notification has no buttons of its own,
whether the build is signed or not: it says that something is waiting, and
clicking it opens the app, where the answers are. It is the same list as the
menu bar's *Needs attention* section.

## Run it in a browser instead

```bash
npm ci
npm run build
npm start          # http://127.0.0.1:4317
```

For development, with hot reload on both halves:

```bash
npm run dev        # api on :4317, UI on http://localhost:5173
```

Other scripts: `npm test` (the server's suite, then the desktop app's), `npm run typecheck`.

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
`FOCUSDESK_DATA_DIR`, and the browser port with `FOCUSDESK_PORT`. The calendar
feeds are re-read in the background every 15 minutes; `FOCUSDESK_CALENDAR_SYNC_MS`
changes that, and `0` switches it off.

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
   the week ahead, and a summary to copy. For a week that is over, *Carry into
   this week* brings what is still open forward, the same action as the Tasks
   tab's banner, so it carries every unfinished task of every earlier week and
   not only the ones listed, and it says so under the button. A block still on
   the clock counts in these totals, with the time it has so far, so wrapping up
   before you stop it does not leave it out. Both come to you when they are due
   (see *Needs your attention*).

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
once, to the bottom of their priority and in the order the list had them in (the
newest week first). A task that has been carried says so, with the week it was
carried from on hover; one you filed under another week by hand has not been
carried, so it does not.

Inside a week, the rows of one priority stay in the order you put them in: a new
task goes to the bottom, like a row added to the end of the sheet, and you drag a
row by its grip to put it elsewhere in its priority — or focus the grip and press
↑ or ↓. Forgot to pick the task before you started? Click the block in Today's
block log and link it there; the task moves along as if you had started the block
on it.

The clock is owned by the server and stored as run/pause segments, so a
refresh, a closed lid or a restart loses nothing, and paused time is never
counted as focus.

## Needs your attention

Some things are better asked than assumed. FocusDesk keeps a short list of
questions and shows them as banners under the clock on every page except the
quick-switch box. The ones about a meeting or a block left running come first, the
rest are oldest first, at most three are open at once and the others are behind
*Show N more*. The desktop app shows the same list as notifications and at the top
of its menu-bar menu. A banner has a button for each answer, and the menu has an
item for each (a notification has none: clicking it opens the app). A question
goes away by itself once it stops being true: from a banner at the next read of the
list (every 15 seconds, whenever the window is focused, and at once when you answer
in that window), and from a notification when the app next reads it. An answer that comes
too late, because the question was answered somewhere else, says *That was already
answered, so nothing changed.* for a few seconds; any other trouble is told in
plain words; and a screen reader is told of a banner that arrives, not of the ones
that were there when the page opened.

- **Time you were away.** The desktop app notices when the machine was locked,
  asleep or idle while a block ran and reports the stretch when you are back
  (`POST /api/sessions/:id/away`; see *Away detection* above for where a stretch
  starts and ends). The clock kept ticking through it, so it is
  yours to decide: **Keep it**, or **Drop 40 min**, which takes exactly that
  stretch off the block. A running block keeps running; a paused or finished one is
  corrected the same way; time that was paused anyway costs it nothing. Reports of
  the same absence merge into one, and a stretch you have answered never comes back:
  a later report of an absence that overlaps it holds only what is new. Setting a
  block's time by hand (typing it in, giving it when you finish, moving the block)
  answers the stretches still waiting on it, since you have said what the time was.
  An away stretch that is not from today names its day.
- **A block left running.** Once the running block has worked
  `long_block_minutes` (two hours unless you change it) it asks *Still on …?* —
  **Finish block** opens the finish dialog for that block (`/?finish=<block id>`), but
  only if that block is still the focus block on the clock: otherwise the page says
  *That block is no longer on the clock*. **Keep going** hides the question until the
  next multiple (four hours, six…), and covers the ones below it too. 0 turns it off.
- **Meetings**, from a synced calendar. When one starts while a block is running:
  *Pause … for it?* (only that block is paused: if you switched to another while the
  question was up, it is not). When it ends: log it as a block linked to the meeting,
  and pick the block you paused back up, in one click. Only the part of the meeting
  that is not on a block already is logged, from the first moment of it: a block you
  paused 14 minutes into a half-hour meeting leaves *Log 16m*, and one that ran all
  through it leaves nothing to log. A meeting is never logged twice: one that has time
  on it already is refused (a 409), by the prompt and by logging it by hand alike.
  A meeting that is moved after it was handled counts as a new one and can be logged
  again.
- **The end of the day.** From `wrapup_time` (17:30 unless you change it; empty
  turns it off), on a work day that has had focus time on it and has not been
  wrapped up: *Time to wrap up the day*, naming the focused time so far. **Wrap up**
  opens the wrap-up page and **Not today** hides it for that day only. It keeps
  asking through the small hours, about the day that has not ended yet, until the
  day turns over at the day-start hour. A `wrapup_time` at or before that hour is in
  the small hours at the end of the day (01:00 is the night after, not the morning
  before), and exactly that hour is the moment the day turns over, so it never comes.
- **Last week.** From when work starts on the first work day of the week (Monday,
  unless Monday is not one) to the end of that week: *Review last week*, if last
  week had focus time on it and has not been reviewed. **Review** opens that week's
  review and **Not this week** hides it.
- **Nothing on the clock.** In work hours on a work day (the weekday is the one of
  the day the hours are on), with no block running or paused, no meeting going on
  and the day not wrapped up, for `nudge_minutes` (fifteen; 0 turns it off):
  *Nothing on the clock*, *Since 2:15 PM. Start something?* **Start a block** takes
  you to the Focus page from the banner in the window, and opens quick switch from
  the menu-bar item and the notification of the desktop app. **Not now** asks again
  after another `nudge_minutes`. The quiet is counted from the latest of: work
  starting, the last block of any kind ending, the last time you dismissed it, and
  the app starting, so opening it at 14:00 does not meet you with a question about
  the whole morning. A Mac that sleeps does not start the app again: the same quiet
  is the same question, and it is not asked twice.

All of the times are read in the timezone you set, so they stay put across a clock
change, and a day is the focus day that turns over at the day-start hour (the
nudge's work days go with its work hours, which are the clock's, so they are the
calendar day's).

Settings → **Prompts & nudges** holds the thresholds, the meeting switch, and the
work days and hours the nudge and the reminders keep to; the wrap-up time is set
under *End-of-day wrap-up*. Away detection and notifications need the desktop app;
everything else shows as banners in a browser too.

## Connect a calendar (optional)

Settings → Calendar. Paste a private ICS feed URL — no OAuth app needed:

- **Google Calendar** — Settings → your calendar → Integrate calendar →
  *Secret address in iCal format*
- **Outlook / Microsoft 365** — Calendar → Share → Publish a calendar → *Can
  view all details* → copy the ICS link

Recurring meetings are expanded. Attribute a meeting to a project once and the
instances of it that turn up in later syncs take it (from the same series, or else a
meeting of exactly the same name in the same calendar, never another's), and a sync
never changes the project of a meeting that is there already: not one you gave it, not
one you took off. You can log a meeting as time spent, which links the block to it so
the meeting shows what was logged and cannot be logged twice, or add it to the day's
plan.

The feed is re-read in the background, soon after start-up and then every 15
minutes while one is connected, so the meeting prompts are working from fresh
events; **Sync now** is still there for when you cannot wait.

A feed that answers with something that is not a calendar (an error page, an empty
answer, a download that stopped short) is left alone: the sync says so, and nothing is
removed. A calendar with no events in it at all keeps the meetings it had, as that is at
least as often trouble at the other end as a calendar that was emptied; one that still has
events, none of them in the window any more (a series that has ended), has its meetings removed.

That URL is a secret — anyone holding it can read the calendar. It is stored in
your local database and never sent back to the browser, and it is never put in an
error message or the log (a feed is named by its label). An address with a user name
or password in it is refused: the private addresses Google and Outlook give out need
neither.

Note that a published ICS feed can lag the real calendar by hours; see
[docs/PLAN.md](docs/PLAN.md) for the API-based alternative.

## Layout

```
server/   Express + SQLite. Owns the clock, the rollups and integration secrets.
  src/app.ts    boots the API and client on a port; embedded by the desktop app
  src/lib/      sessions (timer, and quick switch's stop-and-start), tasks, stats
                (rollups), wrapup (day and week reviews), calendar (ICS), time,
                settings, accelerator (the shortcut rule); prompts (the "needs your
                attention" list and its providers: away, long-block, meetings,
                and reminders, the three that are due at a time of day),
                local-time (a time of day in a timezone as an instant),
                segments (arithmetic on a block's runs)
  src/routes/   projects, sessions, tasks, timers, plan, stats, wrapup, settings,
                calendar, prompts
  test/         timer accounting, stopwatch, saved-timer mode, day boundaries,
                rollups, ICS parsing, migration and backup; tasks (status dates,
                logged time, validation, ordering and moves, linking a block
                later, migration 4); insights (interruption reasons and their
                stats, estimate accuracy, migration 5); carry-over (the stored
                week, carrying unfinished tasks forward, migration 6); wrap-up
                (live totals, notes, done stamps, the weekly sort, the summary
                text, the setting, migration 7); switch (quick switch, the
                shortcut rule); away time (reports, merging, dropping from
                running, paused and finished blocks), the prompt engine,
                long-block and meeting prompts, the new settings, migration 8;
                reminders (the wrap-up, last-week and nothing-on-the-clock
                prompts, across timezones and clock changes); calendar sync
                (hand attribution, inheritance, feeds that are not calendars,
                removals, one sync at a time, addresses that stay secret) and
                the background timer, closing included
web/      React + Vite + Tailwind. Focus · Today · Tasks · Projects · Review · Settings,
          the wrap-up pages (/wrap-up, /wrap-up/week) reached from Today and Review,
          and the quick-switch box at /palette, which has no chrome of its own; the
          prompt banners sit under the clock on every page but that one
desktop/  Electron shell: menu-bar clock, hotkeys, packaging
  main.mjs      window, tray, shortcuts; starts the server in-process
  palette.mjs   the quick-switch window: frameless, raised over other apps
  away.mjs      away detection: lock, sleep, user switching and idle time, as a
                tracker that knows nothing of Electron
  attention.mjs notifications, the menu's Needs attention section and Got
                interrupted's submenu, with Electron handed in
  window-route.mjs  where the window goes for a route: the address, and whether
                to load it or to move the page that is loaded
  menu-bar.mjs  what the menu-bar item says: the clock, the dot, the tooltip
  requests.mjs  which finished requests mean the menu bar must read again
  preload.cjs   the three calls a page may make of the shell (CommonJS on purpose)
  scripts/      icon generator, payload bundler, the Mac packager (builds the chip
                of the machine it runs on; no binaries in the repo) and ensure-deps,
                which runs npm ci only when node_modules is not what the lockfile says
  test/         node:test, no Electron: away, attention, window-route, menu-bar,
                requests, the packaging arguments, ensure-deps
docs/     PLAN.md — the model, what's built, and what's next
```

## What's next

Notion context — meeting notes and transcripts attached to projects and days —
then real calendar APIs. See [docs/PLAN.md](docs/PLAN.md).

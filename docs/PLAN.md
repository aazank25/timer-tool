# FocusDesk — plan

A local-first deep-work timer that answers three questions at the end of a day:
**what did I work on, how long, and how focused was I?**

Everything lives on your laptop in one SQLite file. Nothing is sent anywhere
unless you explicitly connect a calendar feed.

---

## 1. The model

Six concepts, and no more:

| Concept | What it is |
|---|---|
| **Project** | An overarching thing you're pushing on — *ROI Dashboard*, *Unit Pricing Model*. Long-lived, colour-coded, optional weekly hour target. |
| **Block** | One stretch of focused work. Belongs to at most one project, titled with **what you actually did** ("Competitor demo teardown — Vendor A"), rated 1–5 afterwards. |
| **Task** | A smaller unit of work than a project: one row of a weekly priorities list, with a priority, a status, an estimate and a target date. Belongs to a project or, for the odd job, to none. A block can be the work on a task, so a task shows the time really logged against its estimate. |
| **Plan item** | A block you intend to do today. One click turns it into a running block. |
| **Saved timer** | A project + task pair you start with one click. Derived from what you repeat; pinning only holds one at the top. |
| **Context item** | Something from outside — a meeting, a Notion page, a transcript — attached to a project or a block. |

### Why the title is written twice

You name a block *before* you start ("what am I working on") and can rewrite it
*after* ("what I actually did"). Those are rarely the same sentence, and the
second one is the one worth reading back in a month. The optional **intent**
field holds the "what does done look like" note from the start of the block.

### Focus: two numbers, not one

- **Focus rating (1–5)** — what you report when the block ends. You know best.
- **Focus score (0–100)** — a derived blend, so a block you cut short or spent
  fielding interruptions can't score like one you rode out:

  ```
  score = 100 × (0.60 × (rating−1)/4          # self-report leads
               + 0.25 × min(1, worked/planned) # did you ride it out?
               + 0.15 × 1/(1 + interruptions/2))
  ```

  A stopwatch block has no planned length to fall short of — you stopped when
  you were done — so its completion term is 1. An estimate never enters the
  score; it is a guess, shown beside the actual.

  Null until rated. Tunable in `server/src/lib/sessions.ts` — the weights are a
  starting point, not a truth.

### The clock is server-side

Every run and pause is stored as a segment row (`session_segments`). Elapsed
time is the sum of those segments, so **closing the lid, refreshing, or
restarting the process loses nothing**, and paused time is never counted as
focus. The browser only interpolates between polls so the clock ticks — down for
a Pomodoro, up for a stopwatch.

Two consequences worth knowing:
- At most one block is live at a time, enforced by a partial unique index in
  SQLite — not just by the UI.
- If the timer ran on while you walked away, the finish dialog offers to trim
  a Pomodoro to its planned length (a stopwatch to its estimate, if it has one),
  and any logged block's minutes stay editable afterwards.

### Days, not midnights

A "day" is resolved in your timezone with a configurable **day-start hour**
(default 04:00), so a 1am push counts toward the day it felt like. Hour-of-day
reporting splits a block across the hours it really covered — 10:15 + 50m lands
45m in hour 10 and 5m in hour 11.

---

## 2. What is built

**Phase 1 — the core loop.** Done.

- Projects: CRUD, colour from a validated 8-slot palette, weekly targets,
  archive and unarchive (history is never deleted; hard-delete only detaches).
  An archived project is listed under *Show archived* with an **Unarchive**
  button, which puts it back on the timer's pickers and in the list; a failed
  attempt says so under the row it was made on.
- Timer: start with project + title + intent. It is a **stopwatch** by default —
  count up, stop when you are done, with an optional estimate shown against the
  actual — or a fixed-length **Pomodoro** that counts down. Pause/resume, +5 min
  (Pomodoro), log an interruption without stopping the clock (and say what it
  was, one tap more: see *Interruption reasons* below), complete, discard.
- **Saved timers** — the one-click grid, borrowed from Timery. Rather than
  making you curate a list, it is derived from the project+title pairs you
  actually repeat (completed blocks, ranked by frequency then recency), with an
  explicit pin to hold one at the top. Zero setup, useful on day two.
- Finish dialog: rate 1–5 with the number keys, rewrite the title, add notes.
- Manual logging for work done away from the timer.
- Editing after the fact: retitle, reassign project, re-rate, fix the minutes,
  link to a task, reschedule, delete.
- Today: hero total, daily-target meter, avg rating, focus score,
  interruptions, longest unbroken run, day timeline, time-by-project,
  time-by-hour, full block log.
- Review: 7/30/90-day windows, per-day columns, per-project bars and table,
  best-hours chart, and two cards of their own: what interrupted you, and how
  your estimates hold up (see *Interruption reasons and estimate accuracy*).
- Settings: default timer (stopwatch or Pomodoro), Pomodoro length, breaks,
  daily target, timezone, day-start hour, theme.
- Light and dark, keyboard-friendly, no horizontal scroll down to 400px.
- Sidebar shell with the running block pinned to a bar on every screen, a
  per-day composition bar, and entry rows carrying duration and time range.

**Phase 2 — day planning.** Done.

Plan blocks for any day, check them off, start one with a click; a started plan
item is marked done when its block completes and shows actual vs planned.

**Phase 3 — calendar, without OAuth.** Done.

Both Google Calendar and Outlook publish a **private read-only ICS feed**. Paste
that URL and FocusDesk syncs it — no cloud project, no consent screen, no write
access. Recurring meetings are expanded (`RRULE`), cancelled instances honoured
(`EXDATE`), and moved instances respected.

- Attribute a meeting to a project once and **later instances of the same
  meeting inherit it** on the next sync; a hand-made attribution always beats
  an inherited guess.
- "Log as time spent" turns a meeting into a logged block, linked to it, so the
  meeting shows what was logged on it and a second click cannot log it again.
- "Add to plan" turns a meeting into a plan item.
- **A sync never undoes what you did by hand.** It upserts what the feed has and
  deletes only the window's rows the feed no longer has (it used to clear the whole
  window first, which wiped a meeting's project on every sync).
- **The feed is read in the background** — soon after start-up, then every 15
  minutes while a feed is switched on (`FOCUSDESK_CALENDAR_SYNC_MS`, 0 for off) —
  and syncs run one at a time, whoever asks.
- Feed URLs are bearer secrets: stored locally, never returned to the browser
  (the UI sees only a label and a hostname).

> **Known limit:** a published ICS feed can lag the real calendar — Google in
> particular refreshes the secret address lazily, sometimes by hours. Fine for
> "what did today look like", not good enough for "start my 2pm now". Phase 5
> fixes this with a real API integration.

**Tasks — the weekly priorities sheet, in the app.** Done.

The Tasks tab replaces the spreadsheet of the same job. Each row is a task: a
project (or none), priority, status, target date, estimate and what was logged,
grouped under a "Week of" header — the Monday of the week it sits in — with
completed rows struck through. Group by project or status instead, and cut the
list to open, completed or all.

- **A block can be the work on a task**, so the estimate finally has an actual
  beside it: the task's finished focus blocks, plus the block on the clock right
  now. Press ▶ on a row or pick the task on the Focus screen; the block takes the
  task's project unless you say otherwise. A task's estimate is total effort
  across many blocks, so it is never copied onto a block as that block's guess.
- **Status moves the dates.** A block started on a task that is not started or
  held up makes it in progress. Moving a task to in progress stamps a start date
  and to completed stamps a completion date; reopening clears the latter. A date
  you type always wins over the one the status would have filled in.
- **A block on a task follows the task's project, archived or not.** Starting one
  from the Tasks tab sends the task alone and the server files the block under the
  task's project; the Focus screen names that same project, so both ways end in the
  same place. An archived project is hidden from the pickers, not from the work
  already on it: the Focus screen's project picker and the block editor's list it,
  marked *(archived)*, for as long as it is the project in use or the project of the
  task picked, whoever chose the project. The mark waits for the list of live
  projects to arrive: a project missing from a list that has not loaded, or failed,
  is not called archived.
- **The order inside a week is yours, by band.** The list runs newest week first
  and, within a week, high, medium, low. A task's *band* is its week and its
  priority, and the order inside a band is the one you put the rows in: a new task
  takes the bottom of its band, like a row added to the end of a sheet, and you drag
  a row by its grip (shown in week grouping only, where each card is one week) or
  focus the grip and press ↑ or ↓. A move puts a task right before or right after
  another one in its band; the server reads the whole band, completed rows the
  screen hides included, and numbers it 0..n-1 again, so a hidden row keeps its
  place in the order too. A task is never moved out of its band: an anchor in
  another week or priority is refused. Editing a task's priority, or the week it
  is filed under, sends it to the bottom of its new band; any other edit leaves its
  place alone, the day it was added included, whatever that is changed to. The
  added-on day no longer orders anything, and no longer files a task in a week
  either (see the next bullet). What changes on screen: within a week and priority,
  tasks now list in the order they were added (new ones at the bottom), not newest
  day first.
- **A week of its own, and carrying unfinished work forward.** The week a task sits
  in is stored (`tasks.week_of`, always a Monday), like the sheet's separate *Week
  Of* and *Date Added* columns, so the two only agree until a task is carried. A new
  task is filed under the week of the day it was added unless `weekOf` is given, and
  `weekOf` on a create or an edit takes any real day and files the task under that
  day's Monday; editing `addedOn` is editing a record and moves nothing. The order,
  the bands and the moves all go by this stored week. In the task view `weekOf` is
  that week, and `carriedFrom` is the Monday of the week the task was first carried
  forward from, once the carry-over has moved it, otherwise null: it is recorded
  (`tasks.carried_from`, cleared when a task is filed under another week by hand) and
  never worked out from the day added, so a task filed under an earlier week by hand
  has not been carried and a carried one keeps saying so when its day added is
  corrected. `POST /api/tasks/carry-over` (no body)
  brings every task that is not completed and whose week is before this week's
  Monday into this week, answering `{ carried, weekOf }`. This week is the user's:
  it turns over at the day-start hour like every other day. Each carried task goes to
  the bottom of its band here, one after the other, the newest week first (the order
  the list shows the weeks in, and what carrying a week at a time would leave) and in
  the order it had within its week, so tasks that were in an order keep it, and what
  was already in the week stays above them. Completed tasks stay in the week they were
  finished in, and anything in this week or a later one is left alone. It is one
  transaction, and the second call carries nothing. On the Tasks tab a banner says
  how many unfinished tasks are left in earlier weeks and offers **Carry into this
  week**; the edit dialog has a *Week of* field, sent only when it was changed; and a
  carried row says *carried*, with the week it was carried from as its tooltip. The
  dialog's hint says the same, with the year when it is not this one.
- **A block can be linked to a task after the fact.** Forgot to pick one? Open the
  block in Today's block log and choose its task: open tasks first, completed ones
  under their own heading. The task moves along as if the block had been started on
  it, by what the block is. A running or paused block does exactly what starting one
  does. A finished block moves only a task that was not started, to in progress, and
  stamps the day *that block was worked* as its start date, not today; a start date
  the task already has is kept. A task held up or completed stays as it is: holding
  or finishing it was decided after a block that old. A discarded block, or a break,
  moves nothing. All of it happens in the same transaction as the rest of the edit.
  Saying the same task again, unlinking, or editing something else never touches a
  task, and the server never changes the block's project for it: the editor moves
  its project picker to the task's, unless you have already picked one there. The
  minutes of a running block are the clock's to count: the server refuses to rewrite
  them, and the edit with them, so the editor disables that field until it is paused.
- **Deleting a task keeps its blocks.** They lose the link, never their minutes.
  Deleting a project likewise leaves its tasks behind as misc ones.

**Interruption reasons and estimate accuracy — what pulls you away, and how good
your guesses are.** Done.

- **Interruption reasons.** *Got interrupted* on the Focus screen opens a short menu:
  Slack / chat, Meeting, Someone stopped by, Phone call, Email, Something else, and
  *No reason*. One tap logs it and closes the menu; Escape closes it without logging
  anything, and the arrow keys, Home, End and Enter work as in any menu. The count on
  the block is still the number the score and the day's totals read. Each
  interruption logged from now on also gets a row in `interruptions` (migration 5;
  `reason` is NULL for *No reason*), written in the same transaction as the count, so
  neither can be left without the other. `POST /api/sessions/:id/interruption` takes
  `{ delta?, reason? }` (delta -10 to 10, default 1; a reason from the fixed list,
  anything else is a 400 that writes nothing) and answers with the block, as it
  always has. A delta above zero adds that many rows, each with the reason; below
  zero it takes that many of the block's most recent rows away, never below zero. A
  block logged before reasons has a count and no rows, and taking one back from it
  only lowers the count. The block editor's `PATCH /api/sessions/:id { interruptions }`
  takes the newest rows above the new count away in the same transaction as it writes
  the count, so the next reason logged is its own and not read as one of the old ones
  (a count raised by hand leaves the rows alone: the difference is interruptions with
  no reason). On a break *Got interrupted* logs at once and opens no menu, since
  reasons are only read for focus blocks. A screen reader is told "Logged an
  interruption: Meeting" once the request has succeeded, again for the same reason
  twice in a row, and a failed request is an alert instead. The reason list is written
  once on the server (`server/src/lib/interruptions.ts`) and mirrored in
  `web/src/lib/interruptions.ts`.
- **What interrupted you.** `GET /api/stats/interruptions?from=&to=` (days; the 7
  ending today unless given, checked like the other stats, `from` not after `to`)
  answers `{ from, to, total, byReason: [{ reason, label, count }], unspecified }`:
  the interruptions counted on focus blocks in the window, whatever the status of the
  block (a discarded block was still interrupted) and leaving out breaks. `byReason`
  is most often first, ties in the order of the list, and leaves out a reason nobody
  gave. `unspecified` is what was counted with no reason: the interruptions of blocks
  from before reasons, and those logged with *No reason*; `total` is always the
  reasons given plus that. A block's rows are only read up to its own count, so a
  block whose rows outnumber its count (a count lowered before the editor took the
  rows down with it) cannot make this show more than the rest of the app does. It
  is the focus blocks' counts only, where Today's *Interruptions* tile adds up every
  block of the day, a break included. `DayStats` and `RangeStats` are unchanged. Review
  has a *What interrupted you* card for the window picked there, with an empty state.
- **How your estimates hold up.** `GET /api/stats/estimates?from=&to=` (the 90 days
  ending today unless given) answers `{ from, to, blocks, tasks, byProject }`, where
  `blocks` and `tasks` are each `{ count, medianRatio }` and `byProject` has the same
  two for each project, with *No project* as the entry whose id is null and a project
  with nothing in either left out. The ratio is actual ÷ estimate. A block counts when
  it is a completed focus block with an estimate and some time on it (a block of no
  seconds has no actual to compare, as a task with nothing logged has none), worked
  on a day in the window, and its actual is its active seconds; a task counts when it
  is completed on a day in the
  window, has an estimate, and has focus time logged on it, counted by the rule the
  Tasks tab's *Logged* column uses (finished focus blocks only). A block is filed under
  its own project and a task under its task's, which can differ. The median rather
  than the mean, so one marathon block cannot drag a typical guess far; it is null
  until there are three, because the middle of one or two numbers says nothing about
  how you usually guess. Review's *How your estimates hold up* card reads it as "Blocks
  run 1.6× your guess (8)", "about right" within a tenth either way, "finish in 70% of
  your guess" below that, and "not enough yet" for a null. The words go by the ratio
  rounded to a tenth, the figure printed, so one that prints as 1.1× or 0.9× is "about
  right" and the card never says "run 1.1×" or "finish in 90%"
  (`web/src/lib/accuracyWords.ts`). It always looks back 90
  days, whatever window is picked above it, because a week holds too few estimated
  blocks to judge a guess by.

**End-of-day wrap-up and the Monday review.** Done.

Two screens that close out a day and a week, reached from a button on Today
(*Wrap up the day*, `/wrap-up`, any day with `?day=`) and on Review (*Weekly
review*, `/wrap-up/week`, any week with `?week=`). Neither is a sidebar tab.

- **The day** opens with what yesterday's wrap-up said to do (*Yesterday you
  planned: …*, or the day it is from when yesterday had no note), then the
  headline totals, then *Rate what's left* (every finished focus block with no
  rating, one tap for 1–5, and it leaves the list once rated; each button's name
  carries the block's start time, since two blocks can share a title), *Tasks you
  moved* (time put on each, what is logged against its estimate, and a status menu that
  changes the task; completed from the wrap-up of a past day it is stamped with that
  day, not today), a one-line *Tomorrow* note that saves on Enter or when you
  leave the box (Ctrl or Cmd+Enter in the week's; both save and leave the focus where
  it is), a summary to copy, and *Done for the day*, which stamps when. Today's *Avg
  focus* and *Focus score* are averaged over the same blocks as the wrap-up: focus
  blocks that were not thrown away.
- **The week** has the totals, focused time per day (all seven, zero days
  included), time per project, the tasks worked on with this week's time beside
  all that is logged against the estimate, what was completed that week, and
  *Unfinished from this week* (the tasks from that week's sheet still open; for a
  week before the current one it has a **Carry into this week** button, see below).
  It takes a *Next week's focus* note, offers the summary to copy, and is closed with
  *Mark week reviewed*. It opens on last week on a Monday or Tuesday, when the week just
  finished is the one being reviewed and the new one has barely begun, and on the
  current week from Wednesday; the arrows step between weeks.
- **A block still on the clock counts.** Every figure is built from the blocks as
  the timer reads them, with their live elapsed time, not from the stored
  `active_seconds` column: that is only written when a block is paused or stopped,
  so a summary built from it would leave out the block running at the very moment
  you wrap up. A paused block counts what it had when it was paused; breaks and
  discarded blocks are never counted. A block started, paused or stopped from the menu
  bar or another window changes the page too: it is read again when the live session's
  id or status changes, which the shared live-session poll notices within about 15
  seconds. If the server cannot say which day it is, the page says so with a *Try
  again* button instead of waiting on "Loading…".
- **The summary is plain text** (`Mon Oct 12 — 5h 20m focused, 7 blocks, focus
  3.9/5`, a bullet per project with its block titles, the tasks with what is
  logged against the estimate and their status, then the Tomorrow line), written
  by pure functions (`daySummary` and `weekSummary`, in
  `web/src/lib/wrapupSummary.ts`) that the page previews and *Copy summary* puts
  on the clipboard. Where the browser has no clipboard to write to, the text is
  selected and the person is told to copy it themselves. The week's version lists
  the time per project, what was worked on, completed and left open, and the
  next-week note. Its lengths of time are `duration`, the formatter every screen
  uses (whole minutes first, so 1h 59m 40s reads 2h and never 1h 60m). The web app
  has no test runner of its own, so the server's suite loads these small files (and
  `lib/weeks.ts`, which decides the week the review opens on, `lib/format.ts` and
  `lib/accuracyWords.ts`) by their path and tests them there.
- **Notes and stamps are stored apart from the blocks** (`day_notes`,
  `week_reviews`): a note and a done stamp are each optional and independent, a
  second *Done* keeps the first stamp, and editing a note never undoes a stamp.
  `isDayWrappedUp(day)` and `isWeekReviewed(day)` in `server/src/lib/wrapup.ts`
  say whether one was done, for anything that reminds you.
- **A week is named by its Monday, and a task's week is the task view's.** The
  review takes any day of a week and files under its Monday. What is *unfinished*
  from a week is read off each task's `weekOf`, as the Tasks tab states it, and
  never worked out again from the day it was added.
- **Carrying a week's leftovers forward is one button for the lot.** For a week before
  the current one, *Unfinished from this week* has **Carry into this week**: the same
  action as the Tasks tab's banner (`POST /api/tasks/carry-over`), which carries every
  unfinished task of *every* earlier week and not only the ones listed, so a line under
  the list says so and names the week they go into. While it is in flight the button
  reads *Carrying…* and is disabled; then a status line says what was done (*Carried 3
  tasks into the week of Oct 12*) in a live region that is on the page before it is
  needed and stays when the button goes (once they are carried there is nothing left to
  offer), and the task lists and the wrap-up pages are read again. A failure is shown
  where the button was. It is not shown for the current week, and there are no buttons
  on the rows: filing one task under another week by hand is not carrying it, and takes
  off the mark that says it was.
- **`wrapup_time`** (default `17:30`, `HH:MM` on a 24-hour clock, or empty for
  off) is when the wrap-up is due. Settings has a card for it with its own Save.
  The page's own *Save settings* sends only the fields edited
  in its card, and its fields follow the saved settings except the ones being edited,
  so saving a card neither discards an unsaved edit nor is undone by that button.
  The reminder that is due at that time is one of the prompts below.

API: `GET /api/wrapup/day?day=`, `PUT /api/wrapup/day/:day {note}`, `POST
/api/wrapup/day/:day/done`, and the same three under `/api/wrapup/week` with
`?week=` and `/:week`. A note is at most 500 characters, trimmed, and null or
blank clears it.

**Quick switch — one box, any app.** Done.

A Mac-wide shortcut (⌘⌥K by default) pops a Spotlight-like box over whatever app
you are in. You type a few letters of a task or a saved timer and press Enter: the
block on the clock is finished (rated 1–5 if you want, unless it was a break) and
the new one starts, the box disappears, and you are back where you were. Escape
cancels. It works whenever FocusDesk is running, with its window open or not.

- **One request, all or nothing.** `POST /api/sessions/switch` takes
  `{ start, rating? }`, where `start` is exactly the body that starting a block
  takes, and answers 201 with `{ stopped, started }` (`stopped` is null when
  nothing was on the clock). Whatever is live, running or paused, is completed,
  with the rating when there is one, and the new block goes through the same
  `startSession` every other start does, so its rules apply unchanged: a task files
  the block under its project and moves along, a stopwatch given a length is
  refused. It is one transaction. A start that is refused rolls the completion back
  with it, so the block that was on the clock is left exactly as it was, plan item
  and all. Two calls from the client could not promise that: a refused second one
  would leave you with nothing running.
- **The shortcut is a setting.** `quick_switch_hotkey`, `CommandOrControl+Alt+K`
  by default and empty for off. (Not `Shift+K`: ⌘⇧K is Browse DMs in Slack and Delete
  Line in VS Code, and a global shortcut takes the key from every app.) It is
  validated strictly, because Electron is not: it drops a key name it does not know
  and registers what is left (`Foo+A` becomes plain A, a key taken from every app),
  and it cannot say that another app already owns a combination.
  `normalizeAccelerator` (`server/src/lib/accelerator.ts`) accepts a deliberate
  subset of what Electron accepts, not everything it documents: A–Z, 0–9, F1–F24 and
  Space, Tab, Enter, Escape, Backspace, Delete, Insert, the arrows, Home, End, PageUp,
  PageDown and Plus. Refused on purpose are punctuation keys, the lock keys, the
  numeric keypad, media and volume keys, PrintScreen and AltGr. It takes printable
  ASCII only (`toLowerCase()` turns the Kelvin sign U+212A into a k, and `trim()`
  takes no-break and em spaces off the ends, so text that only looks like a shortcut
  would read as one), exactly one key, and a modifier that makes the key press a
  command: one of Command, Control, CommandOrControl or Super. Shift and Alt (Option)
  alone are refused, because Shift+A would take every capital A from every app and
  on a Mac Option+A is å. F1–F24 type nothing, so they may take any modifier.
  Two names for one key count as a repeat, and so does `CommandOrControl` beside
  `Command` or `Control`, which is the same key on one platform. What it returns is
  the one spelling that is saved. The desktop app imports the very same function
  through the server bundle, so what the setting accepts and what the app will
  register cannot drift apart.
- **FocusDesk's own two shortcuts are refused.** ⌘⇧F (show the window) and ⌘⇧Space
  (pause or resume) are registered first, and Electron answers false to a second
  registration of the same keys. If the setting were saved first and refused after,
  the next start would find a shortcut it cannot register and leave none. So the
  settings route refuses them with a 400 that says what the shortcut is already for.
  `usedByApp` compares the keys pressed, not the text, as Electron does:
  `Shift+CommandOrControl+F` is the same shortcut, and so is `Control+Shift+F`
  wherever `CommandOrControl` means Control (`Command+Shift+F` on a Mac). The list,
  `APP_SHORTCUTS`, is checked by a test against what `desktop/main.mjs` registers.
- **The box is a page.** `/palette` renders the palette and nothing else: no rail,
  no clock bar. It lists open tasks and saved timers together, filtered on title and
  project without regard to case, a title that starts with what was typed first,
  then a word that does, then anywhere. With nothing typed the saved timers come
  first, then the tasks: the timers are the fast path, and a long list of tasks
  cannot push them past the 50 rows shown. A saved timer the history made for
  something that is already listed as a task is left out, because it would start
  the same work without the link to the task; a pinned one stays. The last row,
  once something is typed, starts a new block with that text and no project, whether
  or not anything else fits. An Enter pressed before the lists have arrived is kept
  only when something is typed, and acts on the match once they do; on an empty box
  it does nothing. With a focus block on the clock, picking asks how it went first
  (1–5, or Enter to skip, Escape to go back); a break is just stopped. The step is
  left alone for its first 300 ms, and a click the system counts as a repeat is not
  an answer either, because the second click of a double-click on a row lands on a
  rating button that was not there for the first. Keys are not clicks and are
  unaffected. A refusal from the server is shown in the box with everything kept,
  worded for a person (a 500 or a dead connection says "Couldn't switch — the server
  had a problem", the server's own words are kept for a 4xx). If the box was put
  away while the request was on its way, the refusal comes back into a page nobody
  is looking at, and the next show opens on it, saying which switch it was about.
  In a browser, closing goes back to the app.
- **The window is a panel.** `desktop/palette.mjs` makes it once, the first time it
  is wanted: frameless, 640×420, on top, a quarter of the way down the display the
  pointer is on. On a Mac it is an `NSPanel`, which can take the keyboard without
  making FocusDesk the active app, so hiding it leaves you in the app you came from
  with nothing to hand back. It is shown with `showInactive()` and then focused,
  because on a Mac `show()` activates the app as well. It hides itself when it
  loses focus. Both windows may only navigate within the app's own origin, compared
  as parsed addresses and not as text: `http://127.0.0.1:PORT@elsewhere.example/`
  begins with the app's address and is another host, and the bridge would go along
  with the window if it were followed. (Anything else is refused in the box, and
  handed to the real browser from the main window.)
- **Three calls cross the bridge.** `desktop/preload.cjs` puts
  `window.focusdesk = { closePalette(), onPaletteShow(callback), reloadHotkey() }`
  on the main window and the palette, and nothing else of Electron or Node. The
  window is hidden, not closed, so the page starts itself over each time it is shown.
  `onPaletteShow` ignores anything that is not a function. `reloadHotkey()` reads the
  setting again and answers `{ ok, accelerator, error? }`: the shortcut registered
  afterwards, and when a new one could not be had, why. The one that was working is
  kept, and it is kept across restarts too: when Settings saves a shortcut and
  `reloadHotkey()` says no, the card puts the setting back to `accelerator` (or to
  empty, when nothing was registered) and says so, so what is saved is always a
  shortcut that was registered and a restart never finds one it cannot have.
  Merely opening the card while another app holds the shortcut does not rewrite
  what is saved: the other app may let go of it.
- **Off remembers.** Turning the shortcut off and saving keeps the last one in the
  card's draft and in `localStorage`, and turning it on again starts from that, not
  from the default.

> **Known limit:** macOS lets an app register a combination another app owns
> without saying so. FocusDesk cannot detect it, which is why Settings shows the
> shortcut that is registered, not just the one that was typed, and why a refusal
> names the reason. If pressing it does nothing, pick another. As with a pause from
> the menu bar, a main window that is open reads the new block on its next poll.
> `localStorage` belongs to one origin and the desktop app serves on a different port
> at every launch, so what Off remembers is kept for as long as the app runs, and a
> restart falls back to the default (as the theme choice does).

**Prompts — "needs your attention".** Done: the server, the web app (banners under
the clock) and the desktop app (away detection, notifications, the menu-bar menu).

One list of questions the app has, served as `GET /api/prompts` and answered with
`POST /api/prompts/act`. A prompt is `{ id, kind, title, body, createdAt, actions }`,
oldest first by `createdAt`; an action is `{ id, label, primary?, open? }`, where
`open` is a client route (`/?finish=1`) that the client goes to itself and never
posts. A prompt that no longer applies is a 409 (*That prompt is no longer
current*), an action it does not offer a 400. Each kind is a provider
(`{ kind, list(now), act(id, action, now) }`) registered in `lib/prompts.ts`, so
an end-of-day wrap-up or a weekly review is one more provider and nothing else.
Prompts are worked out from the data as it stands, so they go away by themselves;
what was dismissed is written to `prompt_state`, an answer runs in one
transaction, and a provider that fails does not hide the others.

- **`away:<id>`** — the desktop app reports a stretch it saw you were away
  (`POST /api/sessions/:id/away {startedAt, endedAt}`: at least a minute, not in
  the future (5 s of skew allowed), a focus block that was not discarded, start
  clamped to the block's own). Overlapping or touching pending stretches of a
  block merge into the earliest. **Keep it** marks it kept; **Drop** takes that
  wall-clock stretch off the block (`dropInterval`): every run of the clock that
  overlaps it is trimmed, split or removed, an open run becomes a closed one up to
  the start of the stretch and a new open one from its end, and `active_seconds`
  is worked out again from the closed runs, in one transaction, whether the block
  is running, paused or finished. Only ticking time comes off, so a stretch that
  was partly paused costs the block only the part that was running, and the prompt
  says so when that is less than the whole.
- **`long-block:<block>:<n>`** — the running focus block has worked n ×
  `long_block_minutes`. Only the latest multiple is ever asked. **Finish block**
  opens `/?finish=1` (the Focus page opens its finish dialog and takes the
  parameter off the address); **Keep going** hides that multiple.
- **`meeting-start:<event>`** — a timed event began 15 minutes ago or less, has not
  ended, and a focus block is running that is not the time spent on it. **Pause**
  pauses the block and writes its id into `prompt_state.data`.
- **`meeting-end:<event>`** — a timed event ended an hour ago or less and is not
  logged (no block linked to it) or the block paused for it is still paused:
  **Log** (a finished focus block over the scheduled time, under the event's
  project, linked), **Resume**, or **Log and resume** together. Logging never
  creates a second block for a meeting that is logged already.

Three more are due at a time of day and not because of anything that happened. They
live in `lib/reminders.ts`, are registered with the rest in the provider loop of
`lib/prompts.ts`, and are worked out from the data and the settings like the others:
what is written is only a note in `prompt_state` that one was dismissed, and listing
is read-only and cheap, because it runs on every poll of every window.

- **`wrapup:<day>`** — *Time to wrap up the day.* The focus day is a work day,
  `wrapup_time` is set and has passed, the day has a focus block on it (not a break,
  not a discarded one; a running one counts, by the time it has so far) and has not
  been wrapped up (`isDayWrappedUp`) or dismissed. The body names the focused time and
  the blocks. **Wrap up** opens `/wrap-up`, **Not today** dismisses it for that day;
  the next day's is another id. `createdAt` is the instant of `wrapup_time`. It belongs
  to the focus day, so after midnight it still asks about the day that has not ended,
  until the day-start hour turns it over; a `wrapup_time` earlier than that hour is in
  the small hours at the end of the day, and falls on the next calendar day.
- **`week-review:<last week's Monday>`** — *Review last week.* From `work_start` on
  the first work day of the current week (Monday, or the first of the work days if
  Monday is not one; with no work days it never comes) until that week ends, when last
  week had a focus block and is not reviewed (`isWeekReviewed`) or dismissed.
  **Review** opens `/wrap-up/week?week=<that Monday>`; **Not this week** dismisses it.
  Named by last week's Monday, so next week's is another prompt and this one is gone.
- **`idle:<stretch start>`** — *Nothing on the clock*, `Since 2:15 PM. Start
  something?` In work hours (`work_start` up to `work_end`) of a work day, with no
  block live (running or paused), no timed event in progress (an all-day one says
  nothing about the hour) and the day not wrapped up, once the quiet has lasted
  `nudge_minutes` (0 is off). The quiet starts at the latest of: `work_start` today,
  the end of the last block of any kind (a discarded one too: the clock stopped then),
  the last time this nudge was dismissed, and the moment the server started, so
  opening the app at 14:00 does not meet you with the whole morning. The id is the
  start, so a dismissal or a new block makes the next one a different prompt, due
  another `nudge_minutes` on, and the desktop app, which notifies once per id, tells
  again. `createdAt` is the start plus `nudge_minutes`. **Start a block** opens `/`
  (the desktop app opens quick switch instead of the window) and **Not now** dismisses.
  The server's start is the process's uptime counted back from now, held to one
  instant (a new reading only replaces the last when it is more than a second away, since
  the id is the start to the millisecond and the two clocks are read a little apart), and
  `setServerStartedAt` replaces it, which is what the tests do. A meeting that has
  just ended does not restart the quiet (only the four moments above do), so the nudge
  can come the moment a long meeting is over.

Every time of day is read in the user's timezone, with the focus day turning over at
the day-start hour, and is turned into an instant by `lib/local-time.ts`, which asks
Intl for the zone's offset at the instant in question, and so is right across a clock
change: a time that happens twice is its first occurrence, and one that the clocks
skip is read with the old offset, so it lands just after the gap, as `Date` does. The
weekday is the focus day's, and the hours are the clock's, so night work stays with its
day. These three are in the same list as the others, oldest first by `createdAt`.

Settings: `away_minutes` (10), `long_block_minutes` (120), `meeting_prompts`
(true), `work_days` (1,2,3,4,5), `work_start` (09:00), `work_end` (18:00),
`nudge_minutes` (15), `wrapup_time` (17:30); the minutes take 0 for off. The
desktop app reads the away threshold; the server reads the rest. The web client polls
the list every 15 seconds and on window focus.

**The desktop app's half.** `desktop/away.mjs` and `desktop/attention.mjs` import
nothing from Electron: what they need of it is handed in, so `desktop/test/` (run by
`npm test`, with `node --test`) covers every rule without a screen to lock.

- **Away detection** (`createAwayTracker`). A stretch begins at the screen locking, the
  system sleeping, another user taking over (`user-did-resign-active`), or the
  machine having had no input for `away_minutes`, polled every 15 s, in which case it
  began at the last input (`now − idle time`), so nothing is watched in between. It
  ends at an unlock, whatever else was keeping you away (somebody who has just unlocked
  the screen is awake and in their own session, and a wake-up that was never seen must
  not leave the stretch open for ever), and at wake-up or the user coming back only if
  nothing else still keeps you away, which is the screen being locked; for idle, at the
  first input, which is where it ended. Lock, sleep, wake and unlock is one stretch,
  from the earliest start to the last return. When it ends it is reported (`POST
  /api/sessions/<id>/away`) if it was at least `away_minutes` and a focus block was
  running as it began (read from the menu bar's own poll of the live block); a paused
  block, a break or no block is not reported. The end is clamped to now. A refused
  report (400, 404) or any other failure is logged and dropped, and nothing ever
  throws into Electron. The settings are read at start-up, every minute, at unlock
  and wake, and when a window saves them (a `PATCH /api/settings` seen by the
  session's `webRequest`).
- **Notifications** (`createAttention`). The list is read every 15 s, after any
  answer from the menu, and at unlock and wake. Each id is notified **once**, the
  first time it is listed while you are there (screen not locked, and the machine
  touched in the last two minutes); otherwise it waits until you are back. Nothing
  is shown where `Notification.isSupported()` is false. Each notification is kept
  until it is clicked or closed, because macOS lets go of one nothing refers to and
  its click never arrives. A click opens the quick-switch box for an `idle` prompt, the
  main window at the route of the prompt's *primary* answer when that opens a page, and
  the main window for anything else. There are no action buttons: they need a signed app.
- **The menu bar.** With prompts pending, the menu starts with *Needs attention*, a
  submenu per prompt (its title, cut to 60 characters) with an item for each action: one
  the server carries out is posted to `/api/prompts/act` and the list read again, and
  one that opens a page shows the window at that route (`showWindow(route)`, which
  loads it with the `desktop=1` flag the shell uses). A refused answer is shown in a
  message box with the server's own words, never swallowed. The title gets a leading
  dot while anything is pending. *Got interrupted ▸* is a submenu of the reasons from
  `INTERRUPTION_REASONS` (re-exported from `app.ts`, so the two cannot drift) and *No
  reason*, each posting `{ reason }`; on a break it is one item that logs at once, as in
  the window.
- **Test hooks**, only with `FOCUSDESK_TEST=1`: `globalThis.__focusdesk` has the
  tracker's state and events at chosen times, and the clock and idle time it goes by
  (`away`), the latest prompts and the ids notified about (`attention`), the menu as
  plain data with a way to press an item by its labels (`menuTemplate`, `clickMenu`),
  the words of the menu-bar title and tooltip, which only a Mac shows (`trayText`), and
  where the main window is (`showWindow`, `windowUrl`, `windowVisible`), beside what
  quick switch put there.

---

## 3. Roadmap

### Phase 4 — Notion context

The goal: on any day or project, see the meeting notes and transcripts that
explain what was going on.

**Auth.** A Notion *internal integration* token (notion.so/my-integrations),
then share the specific databases with it. One secret, no OAuth dance — same
posture as the calendar feed.

**The target database (confirmed).** The workspace already has a *Meeting
Notes* database — data source `collection://<meeting-notes-data-source-id>`
— with the properties phase 4 needs:

| Property | Type | Use |
|---|---|---|
| `Name` | title | context item title |
| `Event time` | date | which day the note belongs to |
| `Attended` | people | who was there; helps match a calendar event |
| `Last Edited Time` | timestamp | incremental sync cursor |
| `ID` | unique id | stable `external_id` |

Pages carry an *Agenda* / *Meeting Notes* / *To-Do* body, where the Meeting
Notes section is a Notion AI meeting-note block holding a summary and, when
recording ran, a transcript.

**Sync design.**

1. Query the database filtered on `Event time` within the sync window, ordered
   by `Last Edited Time` so re-syncs are incremental.
2. Upsert each page into `context_items` as `source='notion'`,
   `external_id=<page id>`, `occurred_at=<Event time>`, plus a snippet from the
   summary. The unique index on `(source, external_id)` makes this idempotent.
3. Attribute to a project in descending order of confidence: a calendar event
   on the same day already attributed to a project (attendee overlap breaks
   ties) → fuzzy title match against project names → unassigned. A hand-made
   attribution always wins, exactly as it does for calendar events.

**One thing to verify before building.** Transcripts live inside Notion's AI
meeting-note block. Standard blocks (agenda, to-dos, plain summary text) come
back over the public REST API; whether that block's transcript body does is
untested and needs one call with a real token. If it doesn't, the fallback is
the summary text plus a deep link into the page — still enough to answer "what
was going on that day", just without the full transcript body. Worth settling
first, because it decides whether transcript search is on the table.

**Also worth wiring:** a *Projects* database, if one exists, mapped onto
FocusDesk projects via the `notion_url` column that already ships, so a project
card links straight into Notion.

**New surface:**

```
GET  /api/notion/config          what's connected
PUT  /api/notion/config          token + database ids
POST /api/notion/sync            pull a window of pages
GET  /api/context?day=&projectId= what's attached
```

**In the UI:** a "Context" card on Today listing the day's notes; recent notes
on each project card; and in the finish dialog, a "pull from Notion" affordance
that offers today's notes for that project as a starting point for your block
notes.

**Effort:** ~1 focused day. The schema and the attribution hooks are already in
place; this is a client, a sync job and two cards.

### Phase 5 — real calendar APIs (optional)

Worth doing only if the ICS lag annoys you.

- **Google Calendar** — OAuth 2.0 loopback flow (client type "Desktop app"),
  scope `calendar.readonly`, refresh token in the local DB. Buys near-real-time
  sync, your RSVP status, and private event detail. Costs: you create a Google
  Cloud project and an OAuth client once.
- **Outlook / Microsoft 365** — Graph `Calendars.Read` via the device-code flow.

The sync layer is already provider-shaped (`calendar_events.provider`), so this
is a new adapter beside the ICS one, not a rewrite.

### Phase 6 — a real desktop app. Done.

`npm run desktop:mac` produces a `.dmg`, for the chip of the Mac it is built on
(`desktop/scripts/dist-mac.mjs` names the target and the one architecture to
electron-builder, `--mac dmg --arm64` or `--x64` from the machine's chip, and says
`arm64` for an Intel Node running under Rosetta on an Apple silicon Mac;
`dist:mac:all` makes both, for someone else's Mac). The scripts install with `npm ci`,
which never rewrites a lockfile. The app carries the whole stack: the
Electron main process starts the Express server in-process on an ephemeral
loopback port and points a window at it.

- **Menu-bar clock.** A stopwatch counts up there and a Pomodoro counts down.
  The server owns the clock, so the tray polls it every five seconds and
  interpolates in between rather than keeping its own count. Its menu pauses,
  resumes, logs an interruption (a submenu of the reasons), shows what needs your
  attention, or opens the window.
- **Away detection, notifications and the Needs attention section** are the desktop
  half of the prompts (see section 2). They run in the menu bar with the window closed.
  On a Mac the first notification may need allowing under System Settings →
  Notifications, and an unsigned or ad-hoc signed build shows banners without action
  buttons.
- **Closing the window parks the app in the menu bar** and the block keeps
  running; quitting is explicit.
- **Global hotkeys:** Cmd+Shift+F to show, Cmd+Shift+Space to pause/resume, and
  Cmd+Option+K for quick switch (see section 2).
- **Launch at login**, off by default, toggled from the menu bar.
- **Data in `~/Library/Application Support/FocusDesk/data`**, so reinstalling
  or rebuilding never touches your history.
- Window uses the hidden-inset title bar, with the app's own top bar as the
  drag handle. The client learns it is inside the shell from a `?desktop=1`
  flag, so the browser build is unchanged.

**Electron, not Tauri — reversing the earlier recommendation.** The plan
originally called for Tauri on size grounds. That was the wrong read once the
packaging was actually worked through: the server is Node with a native SQLite
module, and Tauri has no Node runtime, so it would have to ship the server as a
separately compiled sidecar binary with its own native-module story. Electron
*is* a Node runtime, so the server runs inside the app with no sidecar at all.
The cost is bundle size (~190MB installed) — the right trade for a personal
tool that has to be reliable.

**Why SQLite is a Node-API build.** better-sqlite3 11 shipped
version-specific binaries and compiled from source whenever one was missing.
That broke twice over: on Node 26 its C++ reaches for V8 APIs that were removed
(`GetPrototype`, `Context::GetIsolate`, `PropertyCallbackInfo::This`), and even
where it did compile, a binary built for the system Node is the wrong binary for
Electron — so the desktop build depended on a second rebuild step landing in the
right order, which it did not. Version 13 is Node-API based and ships a prebuilt
`.node` per platform inside the package, so one binary satisfies every Node
version *and* Electron, nothing compiles at install time, and no toolchain is
needed. The build therefore sets `npmRebuild: false`: rebuilding from source
would discard a working prebuilt binary for no gain. Node 22+ is the floor.

**How the payload is assembled** (`desktop/scripts/build.mjs`): esbuild bundles
the server into one `dist/server.mjs` with only `better-sqlite3` left external,
so the packaged app carries no `node_modules` tree beyond that one native
module. Icons are generated at build time by a small PNG encoder, so no binary
assets sit in git.

### Later, if wanted

- Break timer with auto-suggested short/long breaks (the settings already exist).
- Sending the weekly review to you (an email or a notification on Monday): the
  review itself is built, so what is left is delivering it.
- CSV / JSON export.
- Sync across machines. This is the one feature that breaks the local-first
  promise; a synced SQLite file (Litestream, iCloud/Dropbox folder) is a much
  smaller change than a server.

---

## 4. Data model

```
projects          id, name, color, description, weekly_target_minutes,
                  notion_url, archived, timestamps

sessions          id, project_id→projects, task_id→tasks, title, intent,
                  kind(focus|break),
                  planned_minutes (NULL = stopwatch), estimated_minutes
                  (display only), started_at, ended_at, local_day,
                  active_seconds, interruptions, focus_rating(1-5), notes,
                  status(running|paused|completed|abandoned),
                  calendar_event_id, timestamps
                  · partial unique index: at most one running/paused row
                  · task_id is ON DELETE SET NULL: a deleted task unlinks its
                    blocks, it never deletes one
                  · interruptions is the count the score and the day's totals
                    read; the reasons behind it are in the interruptions table

tasks             id, project_id→projects (NULL = a misc task), title,
                  priority(high|medium|low),
                  status(not_started|in_progress|held_up|completed),
                  estimated_minutes (total effort across blocks; display only),
                  added_on, week_of, carried_from, start_date, target_date,
                  completed_on, notes, results, position, timestamps
                  · dates are plain YYYY-MM-DD days, not instants
                  · week_of is the Monday of the week the task sits in, stored
                    apart from added_on (migration 6 filled it from added_on, so
                    no task moved). Every write sets it; carrying a task forward
                    or filing it under another week changes it and added_on
                    stays the record of when it was added. Indexed with
                    priority and position, the order the list is read in
                  · carried_from is the week the task was first carried forward
                    from (NULL = never carried): written by the carry-over, the
                    first time only, and cleared when the task is filed under
                    another week by hand. Migration 6 adds it beside week_of
                  · position orders a task inside its band (its week_of and its
                    priority) and nowhere else: a new task takes the highest
                    position + 1, a move renumbers its band 0..n-1, and a task
                    carried into a week takes the highest + 1 as well. The app
                    itself never reordered tasks before, so positions were
                    simply the order they were made in, which is where the new
                    rule starts from, so nothing was migrated

interruptions     id, session_id→sessions, at,
                  reason(chat|meeting|person|phone|email|other, NULL = "No reason")
                  · one row per interruption logged since migration 5. A block
                    from before has a count and no rows, and its interruptions
                    are counted as "unspecified" rather than guessed at
                  · session_id is ON DELETE CASCADE: a deleted block takes its
                    rows with it

session_segments  id, session_id→sessions, started_at, ended_at
                  · an open row means the clock is ticking

plan_items        id, plan_day, position, project_id, title, planned_minutes,
                  calendar_event_id, session_id→sessions, done, timestamps

calendar_events   id("provider:uid:start"), provider, calendar_id, title,
                  description, location, starts_at, ends_at, all_day,
                  attendees(json), local_day, project_id, raw, synced_at

context_items     id, source(notion|calendar|manual), external_id, title, url,
                  snippet, occurred_at, project_id, session_id, raw, created_at

day_notes         day (YYYY-MM-DD, the key), note, wrapped_up_at, updated_at
                  · one row per day the wrap-up was touched: the "tomorrow"
                    line, and when "Done for the day" was pressed. Each stays
                    NULL until set and neither implies the other
                  · a plain focus day, like sessions.local_day, so it does not
                    shift with the timezone

week_reviews      week (the Monday, the key), note, reviewed_at, updated_at
                  · the same for a week; any day of the week is filed under it

away_intervals    id, session_id→sessions (ON DELETE CASCADE), started_at,
                  ended_at, status(pending|kept|dropped), created_at,
                  resolved_at
                  · wall-clock stretches the desktop app saw you were away;
                    pending until kept or dropped, then never asked again

prompt_state      key (a prompt's id), status(done|dismissed), data(json),
                  updated_at
                  · what was done about a prompt that is worked out from other
                    tables (a long block, a meeting, a reminder); data remembers
                    what the prompt needs, such as the block it paused for a
                    meeting. A dismissed `idle:` row's updated_at is also where
                    the next quiet stretch starts

settings          key, value
                  · wrapup_time: HH:MM (24-hour) or '' for off, default 17:30
                  · includes away_minutes, long_block_minutes, meeting_prompts,
                    work_days, work_start, work_end, nudge_minutes
```

Migrations are append-only in `server/src/db.ts` — never edit a shipped one.
The phase-4/5 tables ship in the initial schema so the shape is stable before
the integrations land. Before applying a migration to an existing database,
it is snapshotted beside itself with `VACUUM INTO` as
`focusdesk.backup-before-<migration id>-<timestamp>.sqlite` — a raw copy of a
WAL database can be torn while anything else holds it open. A fresh install
has nothing to lose and takes no backup.

---

## 5. Stack, and why

| Piece | Choice | Reason |
|---|---|---|
| Storage | SQLite (`better-sqlite3`) | One file you can copy, back up and query with any tool. Prebuilt binaries, so no compiler needed. |
| Server | Express + Zod on `127.0.0.1` | Loopback-only and single-user, so no auth to build. Needed anyway to own the clock and hold integration secrets. |
| Client | React + Vite + Tailwind v4 | Static bundle; a desktop shell can host it unchanged in phase 6. |
| Data fetching | TanStack Query | Cache invalidation across six screens for free. |
| Charts | Hand-rolled CSS/SVG | No chart library. Every mark follows one validated palette and spec. |

**No accounts, no cloud, no telemetry.** The server binds to loopback and is
unauthenticated *because* it binds to loopback — do not expose the port.

### Colour

Projects pick from a fixed 8-slot categorical palette, each slot carrying its
own light and dark step. The order is a colour-vision-deficiency safety
mechanism, not decoration, and it is machine-validated (worst adjacent CVD
ΔE 9.1 light / 8.4 dark; normal-vision ΔE 19.6 / 19.3). Three light steps sit
under 3:1 on the light surface, so every coloured mark in the app is paired with
a text label and every chart offers a values table — identity is never carried
by hue alone.

---

## 6. Open decisions

Answers change what gets built next; none of them block what already works.

1. ~~Which calendar?~~ **Google.** The secret iCal address works today; phase 5
   would move it to `calendar.readonly` OAuth.
2. **Notion shape.** The *Meeting Notes* database is mapped (see phase 4).
   Still open: is there a **Projects** database to map onto, and does the public
   API return AI meeting-note transcripts?
3. **Breaks.** Do you want enforced Pomodoro breaks, or just the focus blocks?
   Everything is in place; the loop is deliberately not opinionated yet.
4. **Auto-update.** Worth wiring (electron-updater against GitHub releases) or
   is rebuilding by hand fine? Only matters once more than one machine runs it.

Settled: Google Calendar, macOS, a real desktop app (shipped), and Notion
context as the next phase.

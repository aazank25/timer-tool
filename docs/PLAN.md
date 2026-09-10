# FocusDesk — plan

A local-first deep-work timer that answers three questions at the end of a day:
**what did I work on, how long, and how focused was I?**

Everything lives on your laptop in one SQLite file. Nothing is sent anywhere
unless you explicitly connect a calendar feed.

---

## 1. The model

Four concepts, and no more:

| Concept | What it is |
|---|---|
| **Project** | An overarching thing you're pushing on — *RCM Dashboard*, *Auth Pricing Model*. Long-lived, colour-coded, optional weekly hour target. |
| **Block** | One stretch of focused work. Belongs to at most one project, titled with **what you actually did** ("Competitor demo teardown — Waystar"), rated 1–5 afterwards. |
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

  Null until rated. Tunable in `server/src/lib/sessions.ts` — the weights are a
  starting point, not a truth.

### The clock is server-side

Every run and pause is stored as a segment row (`session_segments`). Elapsed
time is the sum of those segments, so **closing the lid, refreshing, or
restarting the process loses nothing**, and paused time is never counted as
focus. The browser only interpolates between polls so the countdown ticks.

Two consequences worth knowing:
- At most one block is live at a time, enforced by a partial unique index in
  SQLite — not just by the UI.
- If the timer ran on while you walked away, the finish dialog offers to trim
  the block to its planned length, and any logged block's minutes stay editable
  afterwards.

### Days, not midnights

A "day" is resolved in your timezone with a configurable **day-start hour**
(default 04:00), so a 1am push counts toward the day it felt like. Hour-of-day
reporting splits a block across the hours it really covered — 10:15 + 50m lands
45m in hour 10 and 5m in hour 11.

---

## 2. What is built

**Phase 1 — the core loop.** Done.

- Projects: CRUD, colour from a validated 8-slot palette, weekly targets,
  archive (history is never deleted; hard-delete only detaches).
- Timer: start with project + title + intent + length; pause/resume, +5 min,
  log an interruption without stopping the clock, complete, discard.
- **Saved timers** — the one-click grid, borrowed from Timery. Rather than
  making you curate a list, it is derived from the project+title pairs you
  actually repeat (completed blocks, ranked by frequency then recency), with an
  explicit pin to hold one at the top. Zero setup, useful on day two.
- Finish dialog: rate 1–5 with the number keys, rewrite the title, add notes.
- Manual logging for work done away from the timer.
- Editing after the fact: retitle, reassign project, re-rate, fix the minutes,
  reschedule, delete.
- Today: hero total, daily-target meter, avg rating, focus score,
  interruptions, longest unbroken run, day timeline, time-by-project,
  time-by-hour, full block log.
- Review: 7/30/90-day windows, per-day columns, per-project bars and table,
  best-hours chart.
- Settings: block lengths, breaks, daily target, timezone, day-start hour,
  theme.
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
- "Log as time spent" turns a meeting into a logged block.
- "Add to plan" turns a meeting into a plan item.
- Feed URLs are bearer secrets: stored locally, never returned to the browser
  (the UI sees only a label and a hostname).

> **Known limit:** a published ICS feed can lag the real calendar — Google in
> particular refreshes the secret address lazily, sometimes by hours. Fine for
> "what did today look like", not good enough for "start my 2pm now". Phase 5
> fixes this with a real API integration.

---

## 3. Roadmap

### Phase 4 — Notion context

The goal: on any day or project, see the meeting notes and transcripts that
explain what was going on.

**Auth.** A Notion *internal integration* token (notion.so/my-integrations),
then share the specific databases with it. One secret, no OAuth dance — same
posture as the calendar feed.

**The target database (confirmed).** The workspace already has a *Meeting
Notes* database — data source `collection://adcb70f5-305f-4cc6-bd5d-3dd8a47e0633`
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

`npm run desktop:mac` produces a `.dmg`. The app carries the whole stack: the
Electron main process starts the Express server in-process on an ephemeral
loopback port and points a window at it.

- **Menu-bar countdown.** The server owns the clock, so the tray polls it every
  five seconds and interpolates in between rather than keeping its own count.
  Its menu pauses, resumes, logs an interruption, or opens the window.
- **Closing the window parks the app in the menu bar** and the block keeps
  running; quitting is explicit.
- **Global hotkeys:** Cmd+Shift+F to show, Cmd+Shift+Space to pause/resume.
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
- Weekly review email or a Monday "here's where last week went" summary.
- Idle detection — notice the machine was locked and offer to trim the block.
- CSV / JSON export.
- Sync across machines. This is the one feature that breaks the local-first
  promise; a synced SQLite file (Litestream, iCloud/Dropbox folder) is a much
  smaller change than a server.

---

## 4. Data model

```
projects          id, name, color, description, weekly_target_minutes,
                  notion_url, archived, timestamps

sessions          id, project_id→projects, title, intent, kind(focus|break),
                  planned_minutes, started_at, ended_at, local_day,
                  active_seconds, interruptions, focus_rating(1-5), notes,
                  status(running|paused|completed|abandoned),
                  calendar_event_id, timestamps
                  · partial unique index: at most one running/paused row

session_segments  id, session_id→sessions, started_at, ended_at
                  · an open row means the clock is ticking

plan_items        id, plan_day, position, project_id, title, planned_minutes,
                  calendar_event_id, session_id→sessions, done, timestamps

calendar_events   id("provider:uid:start"), provider, calendar_id, title,
                  description, location, starts_at, ends_at, all_day,
                  attendees(json), local_day, project_id, raw, synced_at

context_items     id, source(notion|calendar|manual), external_id, title, url,
                  snippet, occurred_at, project_id, session_id, raw, created_at

settings          key, value
```

Migrations are append-only in `server/src/db.ts` — never edit a shipped one.
The phase-4/5 tables ship in the initial schema so the shape is stable before
the integrations land.

---

## 5. Stack, and why

| Piece | Choice | Reason |
|---|---|---|
| Storage | SQLite (`better-sqlite3`) | One file you can copy, back up and query with any tool. Prebuilt binaries, so no compiler needed. |
| Server | Express + Zod on `127.0.0.1` | Loopback-only and single-user, so no auth to build. Needed anyway to own the clock and hold integration secrets. |
| Client | React + Vite + Tailwind v4 | Static bundle; a desktop shell can host it unchanged in phase 6. |
| Data fetching | TanStack Query | Cache invalidation across five screens for free. |
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

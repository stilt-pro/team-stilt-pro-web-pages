# team.stilt.pro — Team Hub

Internal web hub for the STILT shop. Serves resources, equipment docs, and the
team Tasks (Squares) board. Hosted on cPanel, no login (internal use only).

## Layout

```
.
├── index.html            Team Hub landing page
├── serial-numbers.html   Serial number lookup
├── press-brake.html      Press brake operation / programs
├── tasks.html            Team Tasks — per-person Squares board (markup + CSS)
├── tasks.js              Team Tasks — behavior (fetches + rendering)
├── api/
│   ├── squares.php       Personal board JSON per user
│   ├── channel.php       Directional cross-user channel JSON
│   └── view.php          Bulk loader — fetches one user's whole view
├── data/                 JSON storage (written by PHP, gitignored)
│   └── .gitkeep
└── .gitignore
```

## Tasks (Squares) system

`tasks.html` is a single page with a person dropdown. Pick a person and their
board loads from the server; every edit auto-saves (~700ms debounce). Everyone
on the team can see and edit any board — matches the no-auth internal pattern
used by the rest of the hub.

### Team list

Current members (edit the `USERS` array in `tasks.js` to change):

    tom, ben, jeffery, tyler, david, raymond, charlie, trenten, ashton

Nine people, so each person's view shows eight peers — fits the two-page print
layout cleanly.

### Board layout

**Page 1 — TO DO FOR OTHERS** (20-col × 5-row grid):

- Row 1: five personal goals (Week / Fortnight / Quarter / Mid Year / Year End)
- Rows 2–3: eight **outbound peer boxes** (4 per row). Items here are tasks
  *you* are doing *for* that person.
- Row 4: Press Brake + Laser
- Row 5: Notes / Scratchpad

**Page 2 — WAITING ON FROM OTHERS** (3-col grid + Key Dates band):

- Row 1: Critical Response + first two **inbound peer boxes**. Items here are
  tasks *they* are doing *for you*.
- Rows 2–3: the other six inbound peer boxes
- Row 4: Key Dates table

Peer boxes have a blue-tinted header and a TO/FROM badge so the eye reads them
as "this is shared with that person," not part of your personal list.

### Cross-user linking — the important bit

Tom's "to Ben" outbound box and Ben's "from Tom" inbound box are **literally
the same file on disk**. If Tom types "ship part #123" in his box to Ben, Ben
sees it in his waiting-from-Tom box the moment he reloads. Either person can
edit either view — the team is small and trust is implicit.

Storage layout:

    data/squares-<user>.json              ← that user's personal page stuff
    data/channel-<from>-to-<to>.json      ← one file per directed pair

With 9 users there are at most 72 directed channels (9 × 8). Only the ones
that have ever been written to actually exist; the rest are treated as empty.

### Data flow

**Load** — a single bulk request returns everything for that user's view:

```
Browser                           Server (cPanel / PHP)
-------                           ---------------------
GET api/view.php?user=tom         ┐
    &peers=ben,jeffery,...        ├─► reads squares-tom.json,
                                  │   channel-tom-to-*.json, and
                                  │   channel-*-to-tom.json
                                  ▼
   { user, personal,              ◄─┘
     outbound:{ben:{...},...},
     inbound: {ben:{...},...} }
```

**Save** — granular per slot, debounced ~700ms, each slot has its own queue
so a burst of edits on different boxes doesn't stomp each other:

```
edit in goals/press/laser/notes/critical/keydates
  → POST api/squares.php?user=tom             (personal)

edit in outbound box for Ben
  → POST api/channel.php?from=tom&to=ben       (out:ben)

edit in inbound box from Ben (editing on Ben's behalf, same file)
  → POST api/channel.php?from=ben&to=tom       (in:ben)
```

### Safety rails

- `squares.php` validates `user` against `/^[a-z]{1,20}$/`.
- `channel.php` validates both `from` and `to`, and rejects `from===to`.
- `view.php` validates peers the same way and caps the list at 50.
- All writes go to a temp file then `rename()` — no partial writes.
- Payloads capped at 1 MB.
- On page unload, any pending save is flushed via `navigator.sendBeacon()`.

### Per-person URLs

`tasks.html?user=ben` opens Ben's board directly. Without the param, the page
loads whoever was viewed last on that device, or defaults to the first user.

## How to add a new team member

1. Open `tasks.js`.
2. Find the `USERS` constant at the top.
3. Add the person's lowercase first name to the array:

   ```js
   const USERS = [
     "tom", "ben", "jeffery", /* ... */ "ashton",
     "jordan"    // <-- new person
   ];
   ```

4. Commit and deploy. No server change needed — their JSON files are
   auto-created on first save. The grid still fits as long as the total is 9.
   If you go above 9 you'll need to resize `grid.p1` and `grid.p2` in
   `tasks.html` so the peer boxes lay out without overflowing.

## Deploy notes (cPanel)

The repo deploys to cPanel (File Manager or cPanel's Git Version Control).
First time through, confirm:

- **PHP enabled**: default on cPanel. All three PHP files need PHP 7+ (for
  `random_bytes`). Any cPanel from the last 7 years has this.
- **`data/` is writable** by the PHP user: usually `755` works; if saves fail
  with a 500, chmod `data/` to `775` in File Manager.
- **`data/*.json` stays out of git**: `.gitignore` handles this so a `git pull`
  on the server won't overwrite live data.
- **First time**: the `data/` folder must exist. The PHP files will `mkdir`
  it if missing, but only if the parent is writable. Safer to make sure
  `data/` exists on the server before the first write.

## Conventions

- No auth — team hub is internal. If that changes, add a shared token check in
  each PHP endpoint (`$_SERVER['HTTP_X_TEAM_TOKEN']`) and send it from the JS.
- Lowercase usernames everywhere (filenames, URLs, JSON `owner` field). Display
  is capitalized in the UI (`CAP(name)`).
- Two-page print layout in `tasks.html` is load-bearing — the CSS grid math is
  tuned to fit Letter portrait with 0.3" margins and `--band-h: 0.55in`.
  Don't bump `--band-h` or resize the grid rows without testing `Ctrl/Cmd+P`
  preview — you will spill to a 3rd page.
- Save queue keys: `"personal"`, `"out:<peer>"`, `"in:<peer>"`. Each key has
  an independent debounce so editing multiple boxes in quick succession
  doesn't race.

## Data-model versions

- v2: single `p1.squares[]` array of 15 free-form squares on page 1, and
  `p2.squares[]` of 9 on page 2. Replaced when linking was added.
- v3 (current): `p1 = { goals[5], press, laser, notes }`,
  `p2 = { critical, keydates }`. Channels live in separate files. `tasks.js`
  includes a migration path for v2 personal JSON — v2 goals become v3 goals,
  old slot 14 becomes the new Notes box, old slot 0 on p2 becomes Critical
  Response. Freeform middle slots from v2 are not migrated (they would have
  become peer boxes, but we can't guess which peer).

## Open follow-ups

- **Concurrent edit conflicts.** Last write wins per slot. Since each slot has
  its own file, the blast radius is small — simultaneous edits to the same
  peer box can still stomp each other, but edits to different boxes never
  collide.
- **Audit / history.** No history of who changed what. If this ever matters,
  each PHP endpoint could append to `data/<slot>.log.jsonl` on every save.
- **Presence / live updates.** Everyone's view is a point-in-time snapshot.
  To make Tom's changes appear on Ben's screen without a reload would need
  polling or SSE. Not worth the complexity yet.

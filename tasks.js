/* ===================================================================
   STILT Tasks — server-backed per-person Squares with cross-user
   linking via directional channels.

   Storage on the server (cPanel):
     data/squares-<user>.json             -- personal stuff only
     data/channel-<from>-to-<to>.json     -- one file per directed pair

   Load a whole view with one request:
     GET  api/view.php?user=X&peers=a,b,c,...

   Save in pieces:
     POST api/squares.php?user=X                (personal)
     POST api/channel.php?from=X&to=Y           (outbound from current user)
     POST api/channel.php?from=Y&to=X           (inbound, editing peer->me)

   Tom's "to Ben" box and Ben's "from Tom" box are literally the same
   file on disk — edit either one, both update on next load.
   =================================================================== */

/* Edit this list to add or remove team members */
const USERS = [
  "tom", "ben", "jeffery", "tyler",
  "david", "raymond", "charlie", "trenten", "ashton"
];

const API_SQUARES = "api/squares.php";
const API_CHANNEL = "api/channel.php";
const API_VIEW    = "api/view.php";

const SAVE_DEBOUNCE_MS = 700;
const LAST_USER_KEY = "stilt.tasks.lastUser";

const Q_LABELS = { 1: "Do Now", 2: "Schedule", 3: "Delegate", 4: "Drop" };
const CAP = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";

/* --- default shapes --- */
function defaultPersonal(owner) {
  return {
    version: 3,
    owner,
    p1: {
      title: "TO DO FOR OTHERS",
      left:  "Safe / Simple / Priority",
      right: "Tough / Tech When Needed",
      goals: [
        { title: "Week Goals",     items: [] },
        { title: "Fortnight",      items: [] },
        { title: "Quarter",        items: [] },
        { title: "Mid Year Goals", items: [] },
        { title: "Year End Goal",  items: [] }
      ],
      press: { title: "Press Brake", items: [] },
      laser: { title: "Laser",       items: [] },
      notes: { title: "NOTES / Scratchpad", items: [] }
    },
    p2: {
      title: "WAITING ON FROM OTHERS",
      left:  "Safe / Simple / Priority",
      right: "Tough / Tech When Needed",
      critical: { title: "Critical Response", items: [] },
      keydates: []
    }
  };
}
function defaultChannel() { return { items: [] }; }

/* --- state --- */
let currentUser = null;
let state = null;

/* --- status + per-slot save queues --- */
const statusEl = document.getElementById("status");
function setStatus(kind, text) { statusEl.className = "status " + kind; statusEl.textContent = text; }

const saveQueues = new Map();
let lastSaveError = null;

function refreshStatus() {
  let pending = false;
  for (const q of saveQueues.values()) if (q.pending) { pending = true; break; }
  if (pending) setStatus("saving", "Saving…");
  else if (lastSaveError) setStatus("error", "Save failed");
  else setStatus("saved", "Saved");
}

function queueSave(key) {
  if (!saveQueues.has(key)) saveQueues.set(key, { timer: null, pending: false });
  const q = saveQueues.get(key);
  clearTimeout(q.timer);
  q.pending = true;
  refreshStatus();
  q.timer = setTimeout(async () => {
    try { await saveSlot(key); lastSaveError = null; }
    catch (err) { console.error("Save failed for", key, err); lastSaveError = err; }
    q.pending = false;
    refreshStatus();
    checkOverflow();
  }, SAVE_DEBOUNCE_MS);
}

function payloadFor(key) {
  if (key === "personal") {
    return { url: `${API_SQUARES}?user=${encodeURIComponent(currentUser)}`,
             body: JSON.stringify(state.personal) };
  }
  if (key.startsWith("out:")) {
    const peer = key.slice(4);
    return { url: `${API_CHANNEL}?from=${encodeURIComponent(currentUser)}&to=${encodeURIComponent(peer)}`,
             body: JSON.stringify(state.outbound[peer] || defaultChannel()) };
  }
  if (key.startsWith("in:")) {
    const peer = key.slice(3);
    return { url: `${API_CHANNEL}?from=${encodeURIComponent(peer)}&to=${encodeURIComponent(currentUser)}`,
             body: JSON.stringify(state.inbound[peer] || defaultChannel()) };
  }
  return null;
}

async function saveSlot(key) {
  if (!state || !currentUser) return;
  const p = payloadFor(key);
  if (!p) return;
  const res = await fetch(p.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: p.body
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function flushSaves() {
  const pending = [];
  for (const [key, q] of saveQueues) {
    if (q.pending) {
      clearTimeout(q.timer);
      pending.push((async () => {
        try { await saveSlot(key); lastSaveError = null; }
        catch (err) { lastSaveError = err; }
        q.pending = false;
      })());
    }
  }
  await Promise.all(pending);
  refreshStatus();
}

window.addEventListener("beforeunload", () => {
  if (!state || !currentUser) return;
  for (const [key, q] of saveQueues) {
    if (!q.pending) continue;
    const p = payloadFor(key);
    if (!p) continue;
    try { navigator.sendBeacon(p.url, new Blob([p.body], { type: "application/json" })); }
    catch (_) { /* best effort */ }
  }
});

/* --- normalize loaded data --- */
function normalizeItem(it) {
  if (typeof it === "string") it = { text: it, done: false };
  if (!it || typeof it !== "object") it = { text: String(it || ""), done: false };
  if (typeof it.q !== "number") it.q = 0;
  if (typeof it.done !== "boolean") it.done = !!it.done;
  if (typeof it.text !== "string") it.text = String(it.text || "");
  return it;
}
function normalizeChannel(raw) {
  const ch = (raw && typeof raw === "object") ? { ...raw } : {};
  ch.items = Array.isArray(ch.items) ? ch.items.map(normalizeItem) : [];
  return ch;
}
function normalizeBox(b, fallbackTitle) {
  const box = (b && typeof b === "object") ? { ...b } : {};
  if (typeof box.title !== "string" || !box.title) box.title = fallbackTitle;
  box.items = Array.isArray(box.items) ? box.items.map(normalizeItem) : [];
  return box;
}
function normalizePersonal(raw, owner) {
  const d = defaultPersonal(owner);
  if (!raw || typeof raw !== "object") return d;

  // migrate v2 (array of 15/9 squares) to v3 structure if needed.
  if ((raw.version || 0) < 3 && raw.p1 && Array.isArray(raw.p1.squares)) {
    const sq = raw.p1.squares;
    d.p1.goals = d.p1.goals.map((g, i) => normalizeBox(sq[i], g.title));
    d.p1.notes = normalizeBox(sq[14], d.p1.notes.title);
    if (raw.p2 && Array.isArray(raw.p2.squares)) {
      d.p2.critical = normalizeBox(raw.p2.squares[0], d.p2.critical.title);
    }
    if (raw.p2 && Array.isArray(raw.p2.keydates)) d.p2.keydates = raw.p2.keydates;
    d.owner = raw.owner || owner;
    return d;
  }

  d.owner = raw.owner || owner;
  if (raw.p1) {
    if (typeof raw.p1.title === "string" && raw.p1.title) d.p1.title = raw.p1.title;
    if (Array.isArray(raw.p1.goals)) {
      d.p1.goals = d.p1.goals.map((g, i) => normalizeBox(raw.p1.goals[i], g.title));
    }
    d.p1.press = normalizeBox(raw.p1.press, d.p1.press.title);
    d.p1.laser = normalizeBox(raw.p1.laser, d.p1.laser.title);
    d.p1.notes = normalizeBox(raw.p1.notes, d.p1.notes.title);
  }
  if (raw.p2) {
    if (typeof raw.p2.title === "string" && raw.p2.title) d.p2.title = raw.p2.title;
    d.p2.critical = normalizeBox(raw.p2.critical, d.p2.critical.title);
    if (Array.isArray(raw.p2.keydates)) d.p2.keydates = raw.p2.keydates.map(r => ({
      date: String(r.date || ""), activity: String(r.activity || ""), desc: String(r.desc || "")
    }));
  }
  return d;
}

/* --- server i/o --- */
async function loadUser(user) {
  setStatus("saving", "Loading…");
  const peers = USERS.filter(u => u !== user);
  try {
    const url = `${API_VIEW}?user=${encodeURIComponent(user)}&peers=${peers.map(encodeURIComponent).join(",")}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const view = await res.json();
    buildStateFromView(view, user);
    currentUser = user;
    localStorage.setItem(LAST_USER_KEY, user);
    saveQueues.clear();
    lastSaveError = null;
    render();
    setStatus("saved", "Saved");
  } catch (err) {
    console.error("Load failed:", err);
    state = {
      user,
      personal: defaultPersonal(user),
      outbound: Object.fromEntries(peers.map(p => [p, defaultChannel()])),
      inbound:  Object.fromEntries(peers.map(p => [p, defaultChannel()]))
    };
    currentUser = user;
    render();
    setStatus("error", "Offline");
  }
}

function buildStateFromView(view, user) {
  const peers = USERS.filter(u => u !== user);
  state = {
    user,
    personal: normalizePersonal(view.personal, user),
    outbound: {},
    inbound:  {}
  };
  for (const p of peers) {
    state.outbound[p] = normalizeChannel(view.outbound && view.outbound[p]);
    state.inbound[p]  = normalizeChannel(view.inbound  && view.inbound[p]);
  }
}

/* --- render --- */
const app = document.getElementById("app");

function render() {
  app.innerHTML = "";
  app.appendChild(buildPage1());
  app.appendChild(buildPage2());
  requestAnimationFrame(checkOverflow);
}

function buildPageHeader(pageData, label) {
  const frag = document.createElement("div");
  frag.innerHTML = `
    <div class="page-label">${label}</div>
    <div class="band">
      <div class="pill left">${pageData.left.split(' / ').map(s=>`<div>${s}</div>`).join('')}</div>
      <div class="pill center" contenteditable="true" spellcheck="false" data-pagetitle></div>
      <div class="pill right">${pageData.right.split(' / ').map(s=>`<div>${s}</div>`).join('')}</div>
    </div>
    <div class="legend">
      <span class="owner-chip">${CAP(state.user)}</span>
      <b>Eisenhower</b>
      <span class="chip"><span class="dot q1">1</span>Do Now</span>
      <span class="chip"><span class="dot q2">2</span>Schedule</span>
      <span class="chip"><span class="dot q3">3</span>Delegate</span>
      <span class="chip"><span class="dot q4">4</span>Drop</span>
      <span class="hint no-print">Blue-bordered boxes are shared with that person — they see it as the opposite direction.</span>
    </div>`;
  return frag;
}

function buildPage1() {
  const pageData = state.personal.p1;
  const page = document.createElement("section");
  page.className = "page";
  const head = buildPageHeader(pageData, "Page 1 — Front");
  while (head.firstChild) page.appendChild(head.firstChild);

  const titleEl = page.querySelector("[data-pagetitle]");
  titleEl.textContent = pageData.title;
  titleEl.addEventListener("input", () => { pageData.title = titleEl.textContent.trim(); queueSave("personal"); });
  titleEl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); } });

  const grid = document.createElement("div");
  grid.className = "grid p1";
  page.appendChild(grid);

  // Row 1: 5 goal squares (4 cols each)
  pageData.goals.forEach(goal => grid.appendChild(buildPersonalSquare(goal, "goal", "personal")));

  // Rows 2-3: 8 outbound peer boxes (4 per row, 5 cols each)
  const peers = USERS.filter(u => u !== state.user);
  peers.forEach(peer => grid.appendChild(buildChannelSquare(state.outbound[peer], peer, "out")));

  // Row 4: press brake + laser (10 + 10)
  grid.appendChild(buildPersonalSquare(pageData.press, "press", "personal"));
  grid.appendChild(buildPersonalSquare(pageData.laser, "laser", "personal"));

  // Row 5: notes (full width)
  grid.appendChild(buildPersonalSquare(pageData.notes, "notes", "personal"));

  return page;
}

function buildPage2() {
  const pageData = state.personal.p2;
  const page = document.createElement("section");
  page.className = "page";
  const head = buildPageHeader(pageData, "Page 2 — Back");
  while (head.firstChild) page.appendChild(head.firstChild);

  const titleEl = page.querySelector("[data-pagetitle]");
  titleEl.textContent = pageData.title;
  titleEl.addEventListener("input", () => { pageData.title = titleEl.textContent.trim(); queueSave("personal"); });
  titleEl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); } });

  const grid = document.createElement("div");
  grid.className = "grid p2";
  page.appendChild(grid);

  // Row 1: critical + 2 inbound
  const peers = USERS.filter(u => u !== state.user);
  grid.appendChild(buildPersonalSquare(pageData.critical, "critical", "personal"));
  peers.slice(0, 2).forEach(peer => grid.appendChild(buildChannelSquare(state.inbound[peer], peer, "in")));
  // Rows 2-3: remaining 6 inbound
  peers.slice(2).forEach(peer => grid.appendChild(buildChannelSquare(state.inbound[peer], peer, "in")));

  // Row 4: keydates spanning all 3 cols
  grid.appendChild(buildKeydates(pageData));

  return page;
}

function buildPersonalSquare(box, layoutClass, saveKey) {
  const node = document.getElementById("tpl-square").content.firstElementChild.cloneNode(true);
  node.classList.add(layoutClass);
  const title = node.querySelector("[data-title]");
  title.value = box.title || "";
  title.addEventListener("input", () => { box.title = title.value; queueSave(saveKey); });

  node.querySelector("[data-clear]").onclick = () => {
    if (!box.items.length) return;
    if (confirm(`Clear all items in "${box.title || 'this box'}"?`)) {
      box.items = []; render(); queueSave(saveKey);
    }
  };
  wireItems(node, box, saveKey);
  return node;
}

function buildChannelSquare(channel, peer, dir) {
  const node = document.getElementById("tpl-square").content.firstElementChild.cloneNode(true);
  node.classList.add(dir);
  const title = node.querySelector("[data-title]");
  title.value = CAP(peer);
  title.readOnly = true;
  title.tabIndex = -1;

  const dirBadge = node.querySelector("[data-dir]");
  dirBadge.hidden = false;
  dirBadge.textContent = dir === "out" ? "TO" : "FROM";

  const saveKey = `${dir}:${peer}`;
  node.querySelector("[data-clear]").onclick = () => {
    if (!channel.items.length) return;
    const label = dir === "out" ? `to ${CAP(peer)}` : `from ${CAP(peer)}`;
    if (confirm(`Clear all items ${label}?`)) {
      channel.items = []; render(); queueSave(saveKey);
    }
  };
  wireItems(node, channel, saveKey);
  return node;
}

function wireItems(node, container, saveKey) {
  const ul = node.querySelector("[data-items]");
  container.items.forEach((item, ii) => ul.appendChild(buildItem(item, container, ii, saveKey)));
  const addInput = node.querySelector("[data-add]");
  addInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && addInput.value.trim()) {
      container.items.push({ text: addInput.value.trim(), done: false, q: 0 });
      render(); queueSave(saveKey);
    }
  });
}

function buildItem(item, container, ii, saveKey) {
  const node = document.getElementById("tpl-item").content.firstElementChild.cloneNode(true);
  const qBtn = node.querySelector("[data-q]");
  const chk  = node.querySelector("[data-check]");
  const txt  = node.querySelector("[data-text]");
  chk.checked = !!item.done;
  txt.value = item.text;
  if (item.done) node.classList.add("done");

  function applyQ() {
    node.classList.remove("q1","q2","q3","q4");
    if (item.q >= 1 && item.q <= 4) {
      node.classList.add("q" + item.q);
      qBtn.textContent = item.q;
      qBtn.title = `Eisenhower: ${Q_LABELS[item.q]} — click to cycle`;
    } else {
      qBtn.textContent = "";
      qBtn.title = "Eisenhower quadrant — click to tag (1=Do, 2=Schedule, 3=Delegate, 4=Drop)";
    }
  }
  applyQ();

  qBtn.addEventListener("click", () => { item.q = ((item.q || 0) + 1) % 5; applyQ(); queueSave(saveKey); });
  chk.addEventListener("change", () => { item.done = chk.checked; node.classList.toggle("done", item.done); queueSave(saveKey); });
  txt.addEventListener("input", () => { item.text = txt.value; queueSave(saveKey); });
  txt.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && /^[0-4]$/.test(e.key)) {
      e.preventDefault(); item.q = parseInt(e.key, 10); applyQ(); queueSave(saveKey); return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const next = node.nextElementSibling?.querySelector("[data-text]");
      if (next) next.focus();
      else node.parentElement.parentElement.querySelector("[data-add]")?.focus();
    }
    if (e.key === "Backspace" && !txt.value) {
      e.preventDefault(); container.items.splice(ii, 1); render(); queueSave(saveKey);
    }
  });
  node.querySelector("[data-rm]").onclick = () => { container.items.splice(ii, 1); render(); queueSave(saveKey); };
  return node;
}

function buildKeydates(pageData) {
  const wrap = document.createElement("div");
  wrap.className = "keydates";
  wrap.innerHTML = `
    <div class="keydates-head"><b>Key Dates</b>
      <button class="btn no-print" data-addrow style="padding:1px 6px; font-size:9pt">+ row</button>
    </div>
    <div class="keydates-scroll">
      <table>
        <thead><tr><th class="c-date">Date</th><th class="c-act">Activity</th><th>Description / Preparation</th><th class="c-rm no-print"></th></tr></thead>
        <tbody data-rows></tbody>
      </table>
    </div>`;
  const tbody = wrap.querySelector("[data-rows]");
  pageData.keydates.forEach((row, ri) => tbody.appendChild(buildKeyRow(pageData, row, ri)));
  wrap.querySelector("[data-addrow]").onclick = () => {
    pageData.keydates.push({ date: "", activity: "", desc: "" });
    render(); queueSave("personal");
  };
  return wrap;
}

function buildKeyRow(pageData, row, ri) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="c-date"><input data-k="date" placeholder="Date"></td>
    <td class="c-act"><input data-k="activity" placeholder="Activity"></td>
    <td><input data-k="desc" placeholder="Description / preparation"></td>
    <td class="c-rm no-print"><button class="rm-btn" title="Remove">&times;</button></td>`;
  tr.querySelectorAll("[data-k]").forEach(el => {
    const k = el.getAttribute("data-k");
    el.value = row[k] || "";
    el.addEventListener("input", () => { row[k] = el.value; queueSave("personal"); });
  });
  tr.querySelector(".rm-btn").onclick = () => {
    pageData.keydates.splice(ri, 1); render(); queueSave("personal");
  };
  return tr;
}

function checkOverflow() {
  document.querySelectorAll(".square").forEach(sq => {
    const ul = sq.querySelector("ul.items");
    if (!ul) return;
    const over = ul.scrollHeight > ul.clientHeight + 1;
    sq.classList.toggle("overflowing", over);
  });
}
window.addEventListener("resize", checkOverflow);

/* --- user picker --- */
const userSel = document.getElementById("userSel");
USERS.forEach(u => {
  const opt = document.createElement("option");
  opt.value = u; opt.textContent = CAP(u);
  userSel.appendChild(opt);
});
userSel.addEventListener("change", async e => {
  await flushSaves();
  await loadUser(e.target.value);
});

/* --- toolbar --- */
document.getElementById("btnPrint").onclick = () => window.print();

document.getElementById("btnReset").onclick = async () => {
  if (!currentUser) return;
  if (!confirm(`Reset ${CAP(currentUser)}'s PERSONAL board (goals, press, laser, notes, critical, key dates)?\n\nChannels to/from peers are LEFT ALONE — clear those one at a time.`)) return;
  state.personal = defaultPersonal(currentUser);
  render();
  queueSave("personal");
};

document.getElementById("btnExport").onclick = () => {
  if (!state || !currentUser) return;
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `tasks-${currentUser}-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
};

/* --- boot --- */
(async function init() {
  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get("user") || "").toLowerCase();
  const lastUsed = localStorage.getItem(LAST_USER_KEY);
  const start = USERS.includes(fromUrl) ? fromUrl
              : (USERS.includes(lastUsed) ? lastUsed : USERS[0]);
  userSel.value = start;
  await loadUser(start);
})();

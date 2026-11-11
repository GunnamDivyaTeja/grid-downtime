/* Grid Downtime — phone app.
 * Works fully offline: every change is applied and saved on the phone first, queued, and
 * uploaded to your Google Sheet (through your Apps Script web app) whenever there is a connection.
 */
(function () {
"use strict";
const VERSION = "1.3.0";
const CAUSES = ["Collision", "Human Error", "Network Error", "Robot Error", "Low Battery"];
const ORDER = [...CAUSES, ""];
const CVAR = { "Collision": "--c1", "Human Error": "--c2", "Network Error": "--c3", "Robot Error": "--c4", "Low Battery": "--c5" };
const cc = c => `var(${CVAR[c] || "--c0"})`;
const causeLabel = c => c || "Cause not set";
const $ = s => document.querySelector(s);
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms || 10); } catch (e) {} };

/* ---------- formatting & dates (phone's local time) ---------- */
const pad = n => String(n).padStart(2, "0");
function fmtDur(ms) { ms = Math.max(0, ms); if (ms < 60000) return Math.round(ms / 1000) + "s"; const t = Math.round(ms / 60000), h = Math.floor(t / 60), m = t % 60; return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`; }
function fmtClock(ms) { const s = Math.floor(Math.max(0, ms) / 1000); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; }
const tf = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const df = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dfy = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const dm = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dmy = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const mf = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const fmtTime = ms => tf.format(ms);
function sod(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(ms, n) { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
function sow(ms) { const d = new Date(sod(ms)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function som(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function addMonths(ms, n) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); }
const wdIdx = ms => (new Date(ms).getDay() + 6) % 7;
const toInput = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromInput = v => v ? new Date(v).getTime() : NaN;
const isoDate = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const plural = (n, w) => `${n} ${n === 1 ? w : w === "entry" ? "entries" : w + "s"}`;

/* ---------- storage on the phone ---------- */
const LS = "grid-downtime.v2", LS_CFG = "grid-downtime.cfg", LS_PREFS = "grid-downtime.prefs";
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
let S = Object.assign({ events: {}, active: null, pending: [], seq: 0, synced: false, lastSync: 0 }, load(LS, {}));
if (!Array.isArray(S.pending)) S.pending = [];
let cfg = load(LS_CFG, null);
let prefs = Object.assign({ mode: "week" }, load(LS_PREFS, {}));
const persist = () => save(LS, S);

/* ---------- shift hours: downtime only counts inside the shift, on working days ---------- */
const LS_SCHED = "grid-downtime.sched";
const DEFAULT_SHIFT = { start: 360, end: 840 }; // 6:00 am – 2:00 pm, minutes after midnight
let SHIFT = shiftFrom(load(LS_SCHED, null));
function shiftFrom(s) {
  const sh = s && s.shift && s.shift.end > s.shift.start ? s.shift : DEFAULT_SHIFT;
  return { start: sh.start, end: sh.end, hol: (s && Array.isArray(s.holidays)) ? s.holidays : [] };
}
const atMin = (day, m) => { const d = new Date(day); d.setHours(0, m, 0, 0); return d.getTime(); };
const isShiftDay = day => { const w = new Date(day).getDay(); return w >= 1 && w <= 5 && !SHIFT.hol.includes(isoDate(day)); };
const minLabel = m => fmtTime(atMin(sod(Date.now()), m));
/** Time of stoppage x between a and b that falls inside shift hours. */
function clip(x, a, b) {
  const lo = Math.max(x.s, a), hi = Math.min(x.e, b);
  if (!(hi > lo)) return 0;
  let t = 0;
  for (let d = sod(lo); d <= hi; d = addDays(d, 1)) {
    if (!isShiftDay(d)) continue;
    t += Math.max(0, Math.min(hi, atMin(d, SHIFT.end)) - Math.max(lo, atMin(d, SHIFT.start)));
  }
  return t;
}
/** Where `now` is relative to the shift: { on } during it, otherwise the next start and (today) the end. */
function shiftNow(now) {
  const d = sod(now), s = atMin(d, SHIFT.start), e = atMin(d, SHIFT.end), work = isShiftDay(d);
  if (work && now >= s && now < e) return { on: true, s, e };
  let next = work && now < s ? s : null;
  for (let i = 1; !next && i < 20; i++) { const dd = addDays(d, i); if (isShiftDay(dd)) next = atMin(dd, SHIFT.start); }
  return { on: false, next, ended: work && now >= e ? e : null };
}

/* ---------- entries ---------- */
const blankIssue = () => ({ robot: "", cause: "", note: "" });
/** Each robot has its own cause and note. Older entries had one note for the whole stoppage: it moves to the first robot. */
function issuesOf(e) {
  const list = e && Array.isArray(e.issues) && e.issues.length
    ? e.issues.map(i => ({ robot: String((i && i.robot) || ""), cause: CAUSES.includes(i && i.cause) ? i.cause : "", note: String((i && i.note) || "") }))
    : [{ robot: String((e && e.robot) || ""), cause: CAUSES.includes(e && e.cause) ? e.cause : "", note: "" }];
  const legacy = String((e && e.notes) || "").trim();
  if (legacy && !list.some(i => i.note)) list[0] = { ...list[0], note: legacy };
  return list;
}
const cleanIssues = a => { const f = a.filter(i => i.robot || i.cause || i.note); return f.length ? f : [blankIssue()]; };
const mainCause = a => (a.find(i => i.cause) || {}).cause || "";
const notesText = issues => issues.filter(i => i.note).map(i => (i.robot ? i.robot + ": " : "") + i.note).join(" · ");
function toItem(id, e, s, en, live) {
  const issues = cleanIssues(issuesOf(e));
  return { id, s, e: en, issues, cause: mainCause(issues), robots: issues.map(i => i.robot).filter(Boolean), notes: notesText(issues), live: !!live };
}
function eventData(start, end, issues) { return { start, end, issues: cleanIssues(issues), notes: "" }; }
let EV = [];
function derive() {
  EV = Object.entries(S.events).map(([id, e]) => toItem(id, e, Date.parse(e.start), Date.parse(e.end)))
    .filter(x => isFinite(x.s) && isFinite(x.e) && x.e >= x.s).sort((a, b) => b.s - a.s);
}
function items(now) {
  const l = EV.slice();
  if (S.active) { const s = Date.parse(S.active.start); if (isFinite(s)) l.unshift(toItem("live", S.active, s, Math.max(s, now), true)); }
  return l;
}
// Entries logged outside the shift still show in lists (counted as 0), so nothing seems to vanish.
const inRange = (a, b, now) => items(now).filter(x => clip(x, a, b) > 0 || (x.s >= a && x.s < b));

/* ---------- change queue ---------- */
const opKey = op => op.t === "act" ? "a" : "e:" + op.id;
function applyOp(op) {
  if (op.t === "ev") S.events = { ...S.events, [op.id]: op.data };
  else if (op.t === "del") { const n = { ...S.events }; delete n[op.id]; S.events = n; }
  else if (op.t === "act") S.active = op.data;
}
function commit(op) {
  applyOp(op);
  op.seq = ++S.seq;
  const k = opKey(op);
  S.pending = S.pending.filter(p => opKey(p) !== k); // only the latest change per entry needs uploading
  S.pending.push(op);
  persist(); derive(); render(); scheduleSync(250);
}
let remoteEvents = null, remoteActive; // last copy from the Sheet this session
function rebuild() {
  if (remoteEvents) S.events = { ...remoteEvents };
  if (remoteActive !== undefined) S.active = remoteActive;
  for (const op of S.pending) applyOp(op);
  persist(); derive(); render();
}

/* ---------- sync with the Google Sheet ---------- */
let net = cfg ? "connecting" : "local", syncing = false, syncT = null, syncErr = "";
function scheduleSync(ms) { clearTimeout(syncT); syncT = setTimeout(sync, ms || 0); }
async function api(body, timeoutMs) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    const r = await fetch(cfg.url, { method: "POST", body: JSON.stringify({ key: cfg.key, ...body }), headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow", signal: ctrl.signal });
    if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { code: "http" });
    return await r.json();
  } finally { clearTimeout(t); }
}
async function sync() {
  if (!cfg) { net = "local"; updateSync(); return; }
  if (syncing) { scheduleSync(1500); return; }
  if (navigator.onLine === false) { net = "offline"; updateSync(); return; }
  syncing = true; updateSync();
  const sent = S.pending.slice(), seqs = new Set(sent.map(o => o.seq));
  try {
    // Only changes since the last sync are downloaded; everything is fetched again once a day to be safe.
    const full = !S.since || !S.fullAt || Date.now() - S.fullAt > 864e5;
    const j = await api({ action: "sync", ops: sent.map(({ seq, ...o }) => o), since: full ? undefined : S.since });
    if (!j || !j.ok) {
      net = j && j.error === "bad_key" ? "badkey" : "error";
      syncErr = (j && (j.message || j.error)) || "No answer";
    } else {
      S.pending = S.pending.filter(o => !seqs.has(o.seq));
      const m = {}; (j.events || []).forEach(e => { if (e && e.id) m[e.id] = { start: e.start, end: e.end, issues: e.issues, notes: e.notes || "" }; });
      if (j.full !== false) { remoteEvents = m; S.fullAt = Date.now(); } // older scripts always send everything
      else {
        const base = { ...(remoteEvents || S.events) };
        (j.deleted || []).forEach(id => { delete base[id]; });
        remoteEvents = Object.assign(base, m);
      }
      S.since = typeof j.time === "string" ? j.time : null;
      remoteActive = j.active || null;
      S.synced = true; S.lastSync = Date.now(); net = "online"; syncErr = "";
      rebuild();
    }
  } catch (e) {
    net = navigator.onLine === false ? "offline" : "error";
    syncErr = e && e.name === "AbortError" ? "Timed out" : "Can't reach Google right now";
  } finally {
    syncing = false; updateSync();
    if (net === "online" && S.pending.length) scheduleSync(300);
    else if (net === "offline" || net === "error") scheduleSync(20000);
  }
}
window.addEventListener("online", () => scheduleSync(300));
window.addEventListener("offline", () => { net = cfg ? "offline" : "local"; updateSync(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { render(); scheduleSync(200); } });
setInterval(() => { if (!document.hidden && cfg && !syncing) sync(); }, 60000);

function connectWith(url, key, quiet) {
  url = String(url || "").trim(); key = String(key || "").trim();
  const okUrl = /^https:\/\/script\.google(usercontent)?\.com\//.test(url) || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)); // localhost only when testing locally
  if (!okUrl || key.length < 16) { toast("That doesn't look like a valid connect link."); return false; }
  cfg = { url, key }; save(LS_CFG, cfg); net = "connecting"; S.since = null; S.fullAt = 0; remoteEvents = null;
  // Upload anything logged on this phone before it was connected.
  if (!S.synced) Object.entries(S.events).forEach(([id, data]) => { if (!S.pending.some(p => opKey(p) === "e:" + id)) S.pending.push({ t: "ev", id, data, seq: ++S.seq }); });
  if (!S.synced && S.active && !S.pending.some(p => p.t === "act")) S.pending.push({ t: "act", data: S.active, seq: ++S.seq });
  persist(); if (!quiet) toast("Connected to your Google Sheet"); render(); sync();
  return true;
}
/** Accepts a full connect link (or just its #connect=… part) and connects. */
function connectFromText(text) {
  const m = String(text || "").match(/#connect=([A-Za-z0-9_\-=]+)/);
  if (!m) return false;
  try {
    const b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(decodeURIComponent(escape(atob(b))));
    connectWith(j.url, j.key);
  } catch (e) { toast("That connect link is damaged. Send yourself a new one from the Sheet."); }
  return true;
}
function readConnectHash() {
  if (!/^#connect=/.test(location.hash)) return false;
  connectFromText(location.hash);
  history.replaceState(null, "", location.pathname + location.search + "#more");
  return true;
}

/* ---------- small UI helpers ---------- */
let toastT = null;
function toast(msg, act, fn, ms) {
  const t = $("#toast"); $("#toast-msg").textContent = msg;
  const b = $("#toast-act"); b.hidden = !act; b.textContent = act || ""; b.onclick = () => { t.classList.remove("show"); fn && fn(); };
  t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms || (act ? 6000 : 3000));
}
function openSheet(el) {
  el.hidden = false; document.body.classList.add("lock");
  el.style.removeProperty("--drag");
  void el.offsetWidth; // apply the closed position first so the slide-up animates
  el.classList.add("open");
}
function closeSheet(el) {
  if (el.hidden) return;
  el.classList.remove("open"); document.body.classList.remove("lock");
  setTimeout(() => { if (!el.classList.contains("open")) el.hidden = true; }, 380);
}
// Drag the grab handle down to dismiss a sheet.
document.querySelectorAll(".sheet-bg").forEach(bg => {
  const grab = bg.querySelector(".grab"); if (!grab) return;
  let y0 = null, dy = 0;
  grab.addEventListener("pointerdown", e => { y0 = e.clientY; dy = 0; bg.classList.add("dragging"); grab.setPointerCapture(e.pointerId); });
  grab.addEventListener("pointermove", e => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); bg.style.setProperty("--drag", dy + "px"); });
  const end = () => { if (y0 === null) return; y0 = null; bg.classList.remove("dragging"); if (dy > 90) closeSheet(bg); else bg.style.removeProperty("--drag"); };
  grab.addEventListener("pointerup", end); grab.addEventListener("pointercancel", end);
  bg.addEventListener("click", e => { if (e.target === bg) closeSheet(bg); });
});
function showText(title, text) { $("#txt-title").textContent = title; const o = $("#txt-out"); o.value = text; openSheet($("#txt-sheet")); setTimeout(() => { o.focus(); o.select(); }, 350); }
$("#txt-close").onclick = () => closeSheet($("#txt-sheet"));
function copyText(text, label) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(() => toast(label || "Copied"), () => showText("Copy text", text)); return; } } catch (e) {}
  showText("Copy text", text);
}
async function saveFile(filename, text, type) {
  const blob = new Blob([text], { type });
  try {
    const file = new File([blob], filename, { type });
    if (/Android|iPhone|iPad/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000); toast("Saved " + filename);
}
function updateSync() {
  const b = $("#sync"), sp = b.querySelector("span"), n = S.pending.length;
  let cls = "", txt = "";
  if (net === "local") { cls = "warn"; txt = "Not connected"; }
  else if (syncing) { cls = "warn busy"; txt = "Syncing…"; }
  else if (net === "badkey") { cls = "bad"; txt = "Reconnect needed"; }
  else if (net === "offline") { cls = "bad"; txt = n ? `Offline · ${n} to sync` : "Offline"; }
  else if (net === "error") { cls = "bad"; txt = n ? `${n} waiting to sync` : "Sync problem"; }
  else if (net === "connecting") { txt = "Connecting…"; }
  else { cls = n ? "warn" : "ok"; txt = n ? `${n} to sync` : "Synced"; }
  b.className = "sync " + cls; sp.textContent = txt;
  if (view === "more") renderConn();
}
$("#sync").onclick = () => {
  if (net === "local" || net === "badkey") { go("more"); return; }
  const n = S.pending.length;
  toast(net === "offline" ? `No signal. ${n ? plural(n, "change") + " will upload" : "Changes will upload"} when you're back online.`
    : net === "error" ? `Sync problem: ${syncErr}. Trying again shortly.` : n ? "Uploading changes…" : "Everything is saved in your Google Sheet.");
  sync();
};
function chipsHTML(sel) {
  return CAUSES.map(c => `<button type="button" class="chip${c === sel ? " on" : ""}" data-cause="${esc(c)}" style="--cc:${cc(c)}" aria-pressed="${c === sel}"><i></i>${esc(c)}</button>`).join("");
}
function issuesHTML(list) {
  const one = list.length === 1;
  return list.map((it, i) => `<div class="issue" data-i="${i}">
    <div class="iss-h"><span class="fld-label">${one ? "Robot and cause" : `Robot ${i + 1}${i === 0 ? " · main cause" : ""}`}</span>${one ? "" : `<button type="button" class="link rm" data-act="rm">Remove</button>`}</div>
    <input class="iss-robot" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" enterkeyhint="done" placeholder="Robot number, e.g. 41659" value="${esc(it.robot)}" aria-label="Robot ${i + 1} number">
    <div class="chips">${chipsHTML(it.cause)}</div>
    <textarea class="iss-note" rows="2" placeholder="Notes: what was wrong, what you did" aria-label="Robot ${i + 1} notes">${esc(it.note || "")}</textarea></div>`).join("") + `<button type="button" class="btn add" data-act="add">+ Add another robot</button>`;
}
function readIssues(box) {
  return Array.from(box.querySelectorAll(".issue")).map(el => ({ robot: el.querySelector(".iss-robot").value.trim(), cause: (el.querySelector(".chip.on") || { dataset: {} }).dataset.cause || "", note: el.querySelector(".iss-note").value.trim() }));
}
function issueClick(box, e) {
  const t = e.target, el = t.closest(".issue"), list = readIssues(box);
  if (t.closest("[data-act=add]")) { list.push(blankIssue()); return { list, focus: list.length - 1 }; }
  if (!el) return null;
  const i = Number(el.dataset.i);
  if (t.closest("[data-act=rm]")) { list.splice(i, 1); if (!list.length) list.push(blankIssue()); return { list }; }
  const chip = t.closest(".chip"); if (chip) { buzz(8); const c = chip.dataset.cause; list[i].cause = list[i].cause === c ? "" : c; return { list }; }
  return null;
}
function barBg(x) {
  const cs = [...new Set(x.issues.map(i => i.cause))].filter((c, i, a) => c || a.length === 1);
  if (cs.length <= 1) return cc(cs[0] || "");
  const step = 100 / cs.length; return `linear-gradient(${cs.map((c, i) => `${cc(c)} ${(i * step).toFixed(1)}% ${((i + 1) * step).toFixed(1)}%`).join(",")})`;
}
function metaHTML(x) {
  const parts = x.issues.filter(i => i.robot || i.cause).map(i => `${i.robot ? `<b>${esc(i.robot)}</b> ` : ""}<span class="r-cause${i.cause ? "" : " unset"}">${esc(i.cause || "no cause")}</span>`);
  return parts.length ? parts.join(" · ") : `<span class="r-cause unset">Cause not set</span>`;
}
function rowHTML(x, withDate) {
  const days = Math.round((sod(x.e) - sod(x.s)) / 864e5);
  const end = x.live ? "now" : fmtTime(x.e) + (days > 0 ? ` <em>+${days}d</em>` : "");
  return `<button type="button" class="row${x.live ? " live" : ""}" data-id="${esc(x.id)}">
    <span class="r-bar" style="background:${barBg(x)}"></span>
    <span class="r-main"><span class="r-time">${fmtTime(x.s)} – ${end}${withDate ? ` <em>${df.format(x.s)}</em>` : ""}</span>
    <span class="r-meta">${metaHTML(x)}${x.live ? " · in progress" : ""}</span>
    ${x.notes ? `<span class="r-notes">${esc(x.notes)}</span>` : ""}</span>
    ${durHTML(x)}</button>`;
}
/** Counted (in-shift) duration; when part of it was outside the shift, the full length is shown under it. */
/** Share of shift time (so far) the grid was up, e.g. "97.4%". */
function availText(down, a, b) { const shiftMs = clip({ s: a, e: b }, a, b); return shiftMs > 0 ? (Math.max(0, 1 - down / shiftMs) * 100).toFixed(1) + "%" : "—"; }
function durHTML(x) {
  const full = x.e - x.s, c = clip(x, x.s, x.e);
  if (full - c < 60000) return `<span class="r-dur">${fmtDur(full)}</span>`;
  return `<span class="r-dur">${c ? fmtDur(c) : "0m"}<small>${c ? `of ${fmtDur(full)}` : "off shift"}</small></span>`;
}
function stats(list, a, b) {
  let total = 0, longest = null; const by = {}, robots = {};
  const slot = k => by[k] || (by[k] = { ms: 0, n: 0, issues: 0 });
  list = list.filter(x => x.live || clip(x, a, b) > 0); // stoppages wholly outside the shift don't count
  list.forEach(x => {
    const d = clip(x, a, b); total += d; if (!longest || d > longest.d) longest = { d, x };
    const m = slot(x.cause || ""); m.ms += d; m.n++;
    x.issues.forEach(i => { if (i.cause || x.issues.length === 1) slot(i.cause).issues++; });
    [...new Set(x.robots.map(r => r.toUpperCase()))].forEach(r => { const o = robots[r] || (robots[r] = { name: r, n: 0, ms: 0 }); o.n++; o.ms += d; });
  });
  return { total, n: list.length, avg: list.length ? total / list.length : 0, longest, by, robots: Object.values(robots).sort((p, q) => q.n - p.n || q.ms - p.ms) };
}

/* ---------- views ---------- */
let view = "log";
const VIEWS = ["log", "history", "reports", "more"];
function go(v) { if (location.hash !== "#" + v) location.hash = v; else setView(v); }
function setView(v) {
  if (!VIEWS.includes(v)) v = "log";
  const changed = v !== view; view = v;
  VIEWS.forEach(k => { $("#v-" + k).hidden = k !== v; });
  document.querySelectorAll(".tabs a").forEach(a => { if (a.dataset.v === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $(".tab-ind").style.setProperty("--i", VIEWS.indexOf(v));
  if (changed) { const el = $("#v-" + v); el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter"); window.scrollTo({ top: 0 }); repAnim = true; }
  render();
}
window.addEventListener("hashchange", () => { if (!readConnectHash()) setView(location.hash.slice(1)); });
document.querySelectorAll(".tabs a").forEach(a => a.addEventListener("click", () => buzz(6)));

function render() {
  updateSync();
  $("#hdr-date").textContent = dfy.format(Date.now());
  $("#tab-live").hidden = !S.active;
  if (view === "log") renderLog(); else if (view === "history") renderHistory(); else if (view === "reports") renderReports(); else renderMore();
}

/* Log */
const big = $("#big"), actBox = $("#act-issues");
const lastEnded = () => EV.reduce((m, x) => x.e > m ? x.e : m, 0);
function renderLog() {
  const now = Date.now(), a = S.active;
  $("#big-t").textContent = a ? "Grid ON" : "Grid OFF";
  $("#big-s").textContent = a ? "Tap when the grid is back on" : shiftNow(now).on ? "Tap when you stop the grid" : `Outside shift hours: only time from ${minLabel(SHIFT.start)} counts`;
  tickClock(now);
  $("#stop-details").hidden = !a;
  const over = a && missedShiftEnd(a, now), so = $("#shift-over");
  so.hidden = !over;
  if (over && so.dataset.end !== String(over)) {
    so.dataset.end = over;
    so.innerHTML = `<p><b>Still stopped?</b> This stoppage was still open when the shift ended at ${fmtTime(over)}${sod(over) !== sod(now) ? " on " + df.format(over) : ""}. Time after the shift isn't counted.</p>
      <button type="button" class="btn" data-end="${over}">Grid was back on at ${fmtTime(over)}</button>`;
  }
  if (a) {
    const ae = document.activeElement;
    // Redraw the robot cards only when they differ from what's saved, so a tap on a card's button isn't lost
    // to a redraw caused by the text box losing focus.
    const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && actBox.contains(ae);
    if (!typing && JSON.stringify(readIssues(actBox)) !== JSON.stringify(issuesOf(a))) actBox.innerHTML = issuesHTML(issuesOf(a));
    const st = $("#act-start");
    if (document.activeElement !== st) { const s = Date.parse(a.start); st.value = isFinite(s) ? toInput(s) : ""; }
  }
  renderToday(now);
}
/** The status panel. Time only runs during the shift: outside it the panel says "Off shift". */
function tickClock(now) {
  const a = S.active, c = $("#clock"), sub = $("#st-sub"), sh = shiftNow(now), st = $("#status");
  const label = (t, cls) => { $("#st-label").textContent = t; st.classList.toggle("stopped", cls === "stopped"); st.classList.toggle("offshift", cls === "off"); };
  const nextTxt = () => sh.next ? (sod(sh.next) === sod(now) ? `Shift starts at ${fmtTime(sh.next)}` : `Next shift ${df.format(sh.next)}, ${fmtTime(sh.next)}`) : "";
  if (a) {
    const s = Date.parse(a.start);
    // Only downtime inside the shift counts, so the clock shows the counted time.
    c.textContent = fmtClock(clip({ s, e: now }, s, now));
    label("Grid stopped", "stopped");
    sub.textContent = `Stopped at ${fmtTime(s)}${sod(s) !== sod(now) ? " on " + df.format(s) : ""}` + (sh.on ? "" : sh.ended ? ` · shift ended at ${fmtTime(sh.ended)}, not counting` : " · off shift, not counting yet");
  } else if (sh.on) {
    const from = Math.max(lastEnded(), sh.s);
    c.textContent = fmtClock(now - from); label("Grid running", "run");
    sub.textContent = from === sh.s ? `Shift started at ${fmtTime(sh.s)} · ends ${fmtTime(sh.e)}` : `Running since ${fmtTime(from)} · shift ends ${fmtTime(sh.e)}`;
  } else {
    c.textContent = "--:--:--"; label("Off shift", "off");
    sub.textContent = (sh.ended ? `Shift ended at ${fmtTime(sh.ended)}. ` : "") + nextTxt();
  }
}
function renderToday(now) {
  const a = sod(now), b = addDays(a, 1), list = inRange(a, b, now), st = stats(list, a, b);
  $("#today-stats").innerHTML = `<div class="ts"><span>Downtime</span><b>${fmtDur(st.total)}</b></div><div class="ts"><span>Stoppages</span><b>${st.n}</b></div><div class="ts"><span>Longest</span><b>${st.longest ? fmtDur(st.longest.d) : "—"}</b></div>`;
  $("#today-list").innerHTML = list.length ? list.map(x => rowHTML(x)).join("") : `<div class="empty">No downtime today. Tap <b>Grid OFF</b> when you stop the grid.</div>`;
}
let bigLock = false, actT = null;
big.onclick = () => {
  if (bigLock) return; bigLock = true; big.disabled = true; setTimeout(() => { bigLock = false; big.disabled = false; }, 900);
  buzz(S.active ? [12, 60, 12] : 20);
  const now = Date.now(), iso = new Date(now).toISOString();
  if (!S.active) {
    commit({ t: "act", data: { start: iso, issues: [blankIssue()], notes: "" } });
    toast(`Downtime started at ${fmtTime(now)}`, "Undo", () => commit({ t: "act", data: null }));
  } else closeActive(now);
};
/** Grid back on at `end` (now, or the end of the shift when the stoppage was left open). */
function closeActive(end) {
  clearTimeout(actT);
  const a = S.active, id = newId();
  const data = eventData(a.start, new Date(end).toISOString(), readIssues(actBox));
  commit({ t: "ev", id, data }); commit({ t: "act", data: null });
  const d = end - Date.parse(a.start);
  if (!mainCause(data.issues)) { openEdit(id); setEdMsg(`Logged ${fmtDur(d)} of downtime. Pick a cause and save.`, "info"); }
  else toast(`Logged ${fmtDur(d)} of downtime`, "Undo", () => { commit({ t: "del", id }); commit({ t: "act", data: a }); });
}
/** The end of the shift a stoppage was left open past (10 minutes' grace), or null. */
function missedShiftEnd(a, now) {
  const s = Date.parse(a.start); if (!isFinite(s)) return null;
  const e = atMin(sod(s), SHIFT.end);
  return s < e && now > e + 10 * 60000 ? e : null;
}
$("#shift-over").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || !S.active) return;
  const end = Number(b.dataset.end); if (end > Date.parse(S.active.start)) { buzz([12, 60, 12]); closeActive(end); }
});
function patchActive(p) { if (S.active) commit({ t: "act", data: { ...S.active, ...p } }); }
actBox.addEventListener("click", e => {
  if (!S.active) return; const r = issueClick(actBox, e); if (!r) return;
  clearTimeout(actT); patchActive({ issues: r.list, notes: "" });
  actBox.innerHTML = issuesHTML(r.list); // redraw even if a text box still has focus (iPhone keeps focus on tap)
  if (r.focus != null) { const ins = actBox.querySelectorAll(".iss-robot"); if (ins[r.focus]) ins[r.focus].focus(); }
});
actBox.addEventListener("input", () => { clearTimeout(actT); actT = setTimeout(() => patchActive({ issues: readIssues(actBox), notes: "" }), 800); });
actBox.addEventListener("focusout", e => {
  if (!S.active || !e.target.matches(".iss-robot, .iss-note")) return;
  const list = readIssues(actBox); if (JSON.stringify(list) !== JSON.stringify(issuesOf(S.active))) { clearTimeout(actT); patchActive({ issues: list, notes: "" }); }
});
$("#act-start").addEventListener("change", e => {
  const t = fromInput(e.target.value);
  if (!isFinite(t) || t > Date.now()) { toast("Stop time can't be in the future."); renderLog(); return; }
  patchActive({ start: new Date(t).toISOString() });
});
$("#add-past").onclick = () => openEdit(null);
$("#add-past2").onclick = () => openEdit(null);

/* History */
let histFilter = null, histLimit = 60;
function renderHistory() {
  const now = Date.now();
  const opts = [["All", null], ...CAUSES.map(c => [c, c]), ["Not set", ""]];
  $("#hist-filter").innerHTML = opts.map(([l, v]) => `<button type="button" class="chip${histFilter === v ? " on" : ""}" data-f="${v === null ? "*" : esc(v)}" style="--cc:${v === null ? "var(--fg)" : cc(v)}">${v === null ? "" : "<i></i>"}${esc(l)}</button>`).join("");
  let list = items(now); if (histFilter !== null) list = list.filter(x => histFilter === "" ? !x.cause : x.issues.some(i => i.cause === histFilter));
  if (!list.length) { $("#hist-list").innerHTML = `<div class="empty">${EV.length ? "No entries with this cause." : "Nothing logged yet. Entries appear here after you log downtime."}</div>`; return; }
  const shown = list.slice(0, histLimit); let h = "", day = null;
  const dayTot = {}; list.forEach(x => { const k = sod(x.s); dayTot[k] = (dayTot[k] || 0) + clip(x, x.s, x.e); });
  shown.forEach(x => { const k = sod(x.s); if (k !== day) { day = k; h += `<div class="day-h"><span>${dfy.format(k)}</span><b>${fmtDur(dayTot[k])}</b></div>`; } h += rowHTML(x); });
  if (list.length > histLimit) h += `<button type="button" class="btn" id="hist-more">Show more (${list.length - histLimit} older)</button>`;
  $("#hist-list").innerHTML = h;
}
$("#hist-filter").addEventListener("click", e => { const b = e.target.closest(".chip"); if (!b) return; buzz(6); histFilter = b.dataset.f === "*" ? null : b.dataset.f; histLimit = 60; renderHistory(); });
$("#hist-list").addEventListener("click", e => { if (e.target.id === "hist-more") { histLimit += 100; renderHistory(); } });

/* Reports */
const R = { mode: ["day", "week", "month"].includes(prefs.mode) ? prefs.mode : "week", anchor: Date.now() };
let repAnim = true, repShowAll = false;
function range(mode, t) {
  if (mode === "day") { const a = sod(t); return { a, b: addDays(a, 1), label: dfy.format(a), title: dfy.format(a) }; }
  if (mode === "week") { const a = sow(t), f = addDays(a, 4); return { a, b: addDays(a, 7), label: `${dm.format(a)} – ${dmy.format(f)}`, title: `week of ${dm.format(a)} – ${dmy.format(f)} (Mon–Fri)` }; }
  const a = som(t); return { a, b: addMonths(a, 1), label: mf.format(a), title: mf.format(a) };
}
function workdays(a, b, now) { let n = 0; const end = Math.min(b, addDays(sod(now), 1)); for (let t = a; t < end; t = addDays(t, 1)) if (wdIdx(t) < 5) n++; return n; }
function columns(mode, a, b, list, now) {
  const out = [], WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (let t = a; t < b; t = addDays(t, 1)) {
    const e = addDays(t, 1), w = wdIdx(t), segs = {}; let tot = 0;
    list.forEach(x => { const d = clip(x, t, e); if (d) { const k = x.cause || ""; segs[k] = (segs[k] || 0) + d; tot += d; } });
    if (w >= 5 && !tot) continue;
    out.push({ t, segs, total: tot, today: t === sod(now), label: mode === "week" ? WD[w] : String(new Date(t).getDate()), sub: mode === "week" ? String(new Date(t).getDate()) : "" });
  }
  return out;
}
const tick = m => m < 60 ? m + "m" : (Number.isInteger(m / 60) ? m / 60 : (m / 60).toFixed(1)) + "h";
function barChart(cols, mode) {
  const W = 340, H = 176, L = 36, Rr = 6, T = 10, B = mode === "week" ? 32 : 22;
  const maxMin = Math.max(1, ...cols.map(c => c.total / 60000));
  const steps = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
  const step = steps.find(s => maxMin / s <= 4) || 1440, top = Math.max(step, Math.ceil(maxMin / step) * step);
  const y = m => T + (H - T - B) * (1 - m / top);
  const n = cols.length, bw = (W - L - Rr) / n, barW = Math.min(30, bw * 0.64);
  let g = "";
  for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="gl" x1="${L}" x2="${W - Rr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tk" x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${tick(v)}</text>`;
  cols.forEach((c, i) => {
    const cx = L + bw * i + bw / 2; let acc = 0, segs = "";
    ORDER.forEach(k => { const ms = c.segs[k]; if (!ms) return; const m = ms / 60000, y1 = y(acc + m), y0 = y(acc); segs += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, y0 - y1).toFixed(1)}" style="fill:${cc(k)}"/>`; acc += m; });
    if (segs) g += `<g class="${repAnim ? "bar" : ""}" style="animation-delay:${i * 25}ms">${segs}</g>`;
    g += `<text class="tk${c.today ? " now" : ""}" x="${cx.toFixed(1)}" y="${H - B + 13}" text-anchor="middle"${mode === "month" && n > 16 ? ' style="font-size:8px"' : ""}>${c.label}</text>`;
    if (c.sub) g += `<text class="tk${c.today ? " now" : ""}" x="${cx.toFixed(1)}" y="${H - B + 25}" text-anchor="middle">${c.sub}</text>`;
    g += `<rect class="hit" data-day="${c.t}" x="${(L + bw * i).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T}"><title>${esc(df.format(c.t))}: ${fmtDur(c.total)}</title></rect>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Downtime per day">${g}</svg>`;
}
function dayStrip(list, a, b, now) {
  const W = 340, H = 62, L = 8, Rr = 8, x = t => L + (W - L - Rr) * (t - a) / (b - a);
  let g = `<rect class="track" x="${L}" y="6" width="${W - L - Rr}" height="30" rx="4"/>`;
  list.forEach(it => { const s = Math.max(it.s, a), e = Math.min(it.e, b); if (e <= s) return; const w = Math.max(2, x(e) - x(s)); g += `<rect x="${x(s).toFixed(1)}" y="6" width="${w.toFixed(1)}" height="30" style="fill:${cc(it.cause)}"><title>${fmtTime(it.s)}–${it.live ? "now" : fmtTime(it.e)} · ${esc(causeLabel(it.cause))}</title></rect>`; });
  for (let h = 0; h <= 24; h += 3) { const t = a + (b - a) * h / 24; g += `<line class="gl" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="36" y2="41"/><text class="tk" x="${x(t).toFixed(1)}" y="53" text-anchor="${h === 0 ? "start" : h === 24 ? "end" : "middle"}">${pad(h)}:00</text>`; }
  if (now >= a && now < b) g += `<line class="nowl" x1="${x(now).toFixed(1)}" x2="${x(now).toFixed(1)}" y1="2" y2="40"/>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Timeline of grid stoppages during the day">${g}</svg>`;
}
function renderReports() {
  const now = Date.now(), r = range(R.mode, R.anchor);
  const modes = ["day", "week", "month"];
  $("#rep-mode .seg-pill").style.setProperty("--i", modes.indexOf(R.mode));
  document.querySelectorAll("#rep-mode button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.mode === R.mode)));
  $("#rep-label").textContent = r.label;
  $("#rep-next").disabled = r.b > now;
  const list = inRange(r.a, r.b, now), st = stats(list, r.a, r.b), live = list.some(x => x.live);
  const wd = R.mode === "day" ? 0 : workdays(r.a, r.b, now);
  let sub = R.mode === "day" ? (sod(now) === r.a ? "Today" : wdIdx(r.a) >= 5 ? "Weekend" : "") : R.mode === "week" ? "Mon–Fri working week" : `${plural(wd, "working day")} so far`;
  if (R.mode === "week") { const we = list.reduce((m, x) => m + clip(x, addDays(r.a, 5), r.b), 0); if (we) sub += ` · incl. ${fmtDur(we)} at the weekend`; }
  $("#rep-sub").textContent = sub;

  let h = `<div class="metrics">
    <div class="m-main"><div class="m-k">Total grid downtime</div><div class="m-v">${fmtDur(st.total)}</div><div class="m-x">${plural(st.n, "stoppage")} · grid up ${availText(st.total, r.a, Math.min(r.b, Date.now()))} of shift time${live ? " · includes the stoppage in progress" : ""}</div></div>
    <div><div class="m-k">Average stop</div><div class="m-v">${st.n ? fmtDur(st.avg) : "—"}</div></div>
    <div><div class="m-k">Longest stop</div><div class="m-v">${st.longest ? fmtDur(st.longest.d) : "—"}</div>${st.longest ? `<div class="m-x">${esc(causeLabel(st.longest.x.cause))}</div>` : ""}</div>
    ${R.mode !== "day" ? `<div><div class="m-k">Per working day</div><div class="m-v">${wd ? fmtDur(st.total / wd) : "—"}</div></div><div><div class="m-k">Robots involved</div><div class="m-v">${st.robots.length}</div></div>`
      : `<div><div class="m-k">Robots involved</div><div class="m-v">${st.robots.length}</div></div><div><div class="m-k">Shift time</div><div class="m-v">${fmtDur(clip({ s: r.a, e: Math.min(r.b, Date.now()) }, r.a, Math.min(r.b, Date.now())))}</div></div>`}
  </div>`;
  const used = ORDER.filter(k => st.by[k]);
  const legend = used.length ? `<div class="legend">${used.map(k => `<span><i style="background:${cc(k)}"></i>${esc(causeLabel(k))}</span>`).join("")}</div>` : "";
  if (R.mode === "day") h += `<div class="card"><h3>Timeline</h3>${dayStrip(list, r.a, r.b, now)}${legend}</div>`;
  else h += `<div class="card"><h3>Downtime per day</h3>${barChart(columns(R.mode, r.a, r.b, list, now), R.mode)}${legend}<p class="hint">Tap a day to open its daily report.</p></div>`;
  if (st.n) {
    const multi = list.some(x => x.issues.length > 1);
    const rows = used.sort((x, y) => st.by[y].ms - st.by[x].ms || st.by[y].issues - st.by[x].issues).map(k => {
      const v = st.by[k], pct = st.total ? v.ms / st.total * 100 : 0;
      const cnt = multi ? `${plural(v.n, "main cause")} · ${plural(v.issues, "robot issue")}` : plural(v.n, "stop");
      return `<div class="bc-name"><i style="background:${cc(k)}"></i>${esc(causeLabel(k))}</div><div class="bc-val">${fmtDur(v.ms)} <small>· ${Math.round(pct)}%</small></div><div class="bc-bar"><b style="width:${pct.toFixed(1)}%;background:${cc(k)}"></b></div><div class="hint" style="grid-column:1/-1;margin:0 0 6px">${cnt}</div>`;
    }).join("");
    h += `<div class="card"><h3>By cause</h3><div class="bc">${rows}</div>${multi ? `<p class="hint">When a stoppage involves several robots, its time counts under the main cause (Robot 1). Every robot's issue is still counted.</p>` : ""}</div>`;
    if (st.robots.length) {
      const top = st.robots.slice(0, 8);
      h += `<div class="card"><h3>Robots involved</h3><div class="rob">${top.map(r => `<b>${esc(r.name)}</b><span>${plural(r.n, "stop")} · ${fmtDur(r.ms)}</span>`).join("")}</div>${st.robots.length > 8 ? `<p class="hint">${st.robots.length - 8} more robots are listed in the CSV.</p>` : ""}</div>`;
    }
    const sorted = list.slice().sort((a, b) => a.s - b.s), cap = R.mode === "month" && !repShowAll ? 10 : Infinity;
    h += `<div class="card"><h3>Stoppages</h3><div class="list">${sorted.slice(0, cap).map(x => rowHTML(x, R.mode !== "day")).join("")}</div>${sorted.length > cap ? `<button type="button" class="btn" id="rep-all">Show all ${sorted.length}</button>` : ""}</div>`;
  } else h += `<div class="empty">No downtime logged for this period.</div>`;
  $("#rep-body").innerHTML = h;
  if (!repAnim) $("#rep-body").querySelectorAll(".bc-bar b").forEach(b => { b.style.animation = "none"; });
  repAnim = false;
}
function setMode(m) { R.mode = m; prefs.mode = m; save(LS_PREFS, prefs); repShowAll = false; repAnim = true; renderReports(); }
$("#rep-mode").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { buzz(6); setMode(b.dataset.mode); } });
function shift(dir) {
  const n = R.mode === "day" ? addDays(sod(R.anchor), dir) : R.mode === "week" ? addDays(sow(R.anchor), 7 * dir) : addMonths(som(R.anchor), dir);
  if (dir > 0 && n > Date.now()) return;
  R.anchor = n; repShowAll = false; repAnim = true; renderReports();
}
$("#rep-prev").onclick = () => { buzz(6); shift(-1); };
$("#rep-next").onclick = () => { buzz(6); shift(1); };
// Swipe left/right on the report to change period.
(() => { let x0 = null, y0 = 0; const el = $("#rep-body");
  el.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener("touchend", e => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null; if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1); }, { passive: true });
})();
$("#rep-body").addEventListener("click", e => {
  if (e.target.id === "rep-all") { repShowAll = true; renderReports(); return; }
  const hit = e.target.closest(".hit"); if (hit) { R.anchor = Number(hit.dataset.day); setMode("day"); window.scrollTo({ top: 0, behavior: "smooth" }); }
});
function summaryText() {
  const now = Date.now(), r = range(R.mode, R.anchor), list = inRange(r.a, r.b, now), st = stats(list, r.a, r.b);
  const L = [`Grid downtime – ${r.title}`, "", `Total downtime: ${fmtDur(st.total)} across ${plural(st.n, "stoppage")}`];
  if (st.n) {
    L.push(`Average stoppage: ${fmtDur(st.avg)}`);
    L.push(`Longest stoppage: ${fmtDur(st.longest.d)} on ${df.format(st.longest.x.s)} at ${fmtTime(st.longest.x.s)} (${causeLabel(st.longest.x.cause)})`);
    if (R.mode !== "day") { const wd = workdays(r.a, r.b, now); if (wd) L.push(`Average per working day: ${fmtDur(st.total / wd)} (${plural(wd, "working day")})`); }
    L.push("", "By cause:");
    ORDER.filter(k => st.by[k]).sort((x, y) => st.by[y].ms - st.by[x].ms || st.by[y].issues - st.by[x].issues).forEach(k => { const v = st.by[k]; L.push(`- ${causeLabel(k)}: ${fmtDur(v.ms)} (${plural(v.n, "stoppage")}, ${plural(v.issues, "robot issue")}, ${st.total ? Math.round(v.ms / st.total * 100) : 0}%)`); });
    if (st.robots.length) { L.push("", `Robots involved: ${st.robots.length}`); st.robots.slice(0, 5).forEach(r => L.push(`- ${r.name}: ${plural(r.n, "stoppage")}, ${fmtDur(r.ms)}`)); }
    if (list.some(x => x.live)) L.push("", "Note: includes a stoppage still in progress.");
  }
  return L.join("\n");
}
function csvText(list, a, b) {
  const q = v => { v = String(v ?? ""); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const rows = [["Date", "Grid off", "Grid on", "Duration (min)", "Counted minutes (in shift, this period)", "Main cause", "Robots", "Robot count", "Robots and causes", "Notes"]];
  list.slice().sort((x, y) => x.s - y.s).forEach(x => rows.push([isoDate(x.s), toInput(x.s).replace("T", " "), x.live ? "in progress" : toInput(x.e).replace("T", " "), ((x.e - x.s) / 60000).toFixed(1),
    a == null ? (clip(x, x.s, x.e) / 60000).toFixed(1) : (clip(x, a, b) / 60000).toFixed(1), x.cause || "", x.robots.join(", "), x.robots.length,
    x.issues.filter(i => i.robot || i.cause).map(i => `${i.robot || "?"}: ${i.cause || "not set"}`).join("; "), x.notes]));
  return "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n");
}
$("#rep-copy").onclick = () => copyText(summaryText(), "Summary copied");
$("#rep-csv").onclick = () => {
  const now = Date.now(), r = range(R.mode, R.anchor), list = inRange(r.a, r.b, now);
  const slug = R.mode === "day" ? isoDate(r.a) : R.mode === "week" ? "week-" + isoDate(r.a) : isoDate(r.a).slice(0, 7);
  saveFile(`grid-downtime-${slug}.csv`, csvText(list, r.a, r.b), "text/csv");
};

/* Settings */
function renderConn() {
  const el = $("#conn-card");
  if (!cfg) {
    el.innerHTML = `<h3>Google Sheet</h3>
      <div class="conn-row"><span class="conn-dot warn"></span><b>Not connected</b></div>
      <p class="muted">Entries are kept on this phone only until you connect. In your Google Sheet use <b>Grid Downtime → Email me the phone connect link</b>. On this phone, press and hold the email's button, copy the link, and paste it here.</p>
      <label class="fld"><span>Connect link</span><input id="cf-link" placeholder="Paste the link from the email" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <button type="button" class="btn primary" id="cf-go">Connect</button>`;
  } else {
    const n = S.pending.length;
    const state = net === "online" ? ["ok", "Connected"] : net === "offline" ? ["bad", "Offline"] : net === "badkey" ? ["bad", "The key was rejected"] : net === "error" ? ["bad", "Sync problem"] : ["warn", "Connecting…"];
    el.innerHTML = `<h3>Google Sheet</h3>
      <div class="conn-row"><span class="conn-dot ${state[0]}"></span><b>${state[1]}</b></div>
      <p class="muted">${S.lastSync ? "Last synced " + dfy.format(S.lastSync) + ", " + fmtTime(S.lastSync) : "Not synced yet"}${n ? ` · ${plural(n, "change")} waiting to upload` : ""}${net === "error" && syncErr ? ` · ${esc(syncErr)}` : ""}${net === "badkey" ? ". Send yourself a new connect link from the Sheet." : ""}</p>
      <div class="actions"><button type="button" class="btn" id="cf-sync">Sync now</button><button type="button" class="btn danger" id="cf-off">Disconnect</button></div>`;
  }
}
/* Report schedule: stored in the Google Sheet, edited here. The last copy loaded is kept on the
   phone so the screen (and the Reports tab's note) can show it without signal. */
const SC ={ saved: load(LS_SCHED, null), draft: null, loading: false, saving: false, msg: "", msgCls: "", loadedAt: 0, emailErr: {} };
const RTYPES = ["daily", "weekly", "monthly"], RNAME = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
const WDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const EMAIL_OK = s => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(s);
const hourLabel = h => `${h % 12 || 12}:00 ${h < 12 ? "am" : "pm"}`;
const keyDate = k => new Date(k + "T12:00:00");
const schedCopy = s => s && JSON.parse(JSON.stringify({ shift: s.shift || DEFAULT_SHIFT, reports: s.reports, holidays: s.holidays, saveToDrive: s.saveToDrive }));
/** New settings from Google: remember them and recount everything with the (possibly new) shift hours. */
function schedArrived(st) { SC.saved = st; save(LS_SCHED, st); SHIFT = shiftFrom(st); render(); }
const schedDirty = () => !!(SC.draft && SC.saved && JSON.stringify(schedCopy(SC.draft)) !== JSON.stringify(schedCopy(SC.saved)));
/** Half-hour choices from 4:00 am to 11:30 pm (plus the current value if it's something else). */
function shiftOpts(sel) {
  const v = [...new Set([...Array.from({ length: 40 }, (_, i) => 240 + i * 30), sel])].sort((a, b) => a - b);
  return v.map(m => `<option value="${m}"${m === sel ? " selected" : ""}>${minLabel(m)}</option>`).join("");
}
function ruleText(t, r) {
  if (t === "daily") return "Every working day";
  if (t === "weekly") return r.day === "last" ? "Last working day of the week" : `Every ${WDAYS[r.day - 1]}`;
  return "Last working day of the month";
}
async function loadSched(force) {
  if (!cfg || SC.loading || (!force && Date.now() - SC.loadedAt < 60000)) return;
  SC.loading = true; renderSched();
  try {
    const j = await api({ action: "getSettings" }, 30000);
    if (j && j.ok && j.settings) { schedArrived(j.settings); SC.loadedAt = Date.now(); if (!schedDirty()) SC.draft = schedCopy(j.settings); SC.msg = ""; }
    else SC.msg = j && j.error === "bad_key" ? "The key was rejected. Reconnect from the Sheet." : "Couldn't load the schedule" + (j && j.error === "bad_request" ? "" : ". Update the Google script to the latest version.");
    SC.msgCls = j && j.ok ? "" : "err";
  } catch (e) { SC.msg = SC.saved ? "Offline: showing the schedule from your last connection." : "Connect to the internet to load the schedule."; SC.msgCls = SC.saved ? "" : "err"; }
  SC.loading = false; renderSched(); renderRepHint();
}
function renderRepHint() {
  const s = SC.saved, el = $("#rep-hint"); if (!el || !s) return;
  const on = RTYPES.filter(t => s.reports[t].on);
  el.textContent = on.length ? "PDF reports are emailed automatically: " + on.map(t => `${t} at ${hourLabel(s.reports[t].hour)} (${ruleText(t, s.reports[t]).toLowerCase()})`).join("; ") + ". Change this in Settings → Report schedule."
    : "Automatic PDF reports are switched off. Turn them on in Settings → Report schedule.";
}
function renderSched() {
  const el = $("#sched-card"); if (!el) return;
  if (!cfg) { el.innerHTML = `<h3>Report schedule</h3><p class="muted">Connect to your Google Sheet to set when reports are sent and who gets them.</p>`; return; }
  if (!SC.draft && SC.saved) SC.draft = schedCopy(SC.saved);
  const d = SC.draft;
  if (!d) { el.innerHTML = `<h3>Report schedule</h3><p class="sched-msg ${SC.msgCls}">${SC.loading ? "Loading…" : esc(SC.msg || "Loading…")}</p>${SC.loading ? "" : `<button type="button" class="btn" data-sc="reload">Try again</button>`}`; return; }
  const dirty = schedDirty(), hours = [...new Set([...Array.from({ length: 18 }, (_, i) => i + 6), ...RTYPES.map(t => d.reports[t].hour)])].sort((a, b) => a - b);
  const next = t => { const k = SC.saved && SC.saved.next && SC.saved.next[t]; return !dirty && k ? `<span class="rp-next">Next: ${df.format(keyDate(k))}, ${hourLabel(SC.saved.reports[t].hour)}</span>` : ""; };
  el.innerHTML = `<h3>Report schedule</h3>
    <div class="rp"><div class="rp-h"><div><b>Shift hours</b><small>Downtime and running time only count during the shift, Monday to Friday.</small></div></div>
      <div class="row2">
        <label class="fld"><span>Shift starts</span><select data-k="shift-start">${shiftOpts(d.shift.start)}</select></label>
        <label class="fld"><span>Shift ends</span><select data-k="shift-end">${shiftOpts(d.shift.end)}</select></label></div>
      ${d.shift.end - d.shift.start < 60 ? `<p class="sched-msg err">The shift must end at least an hour after it starts.</p>` : ""}</div>
    <p class="muted">PDF reports are emailed automatically, Melbourne time. They cover up to the send time, and arrive within about 30 minutes of it.</p>
    ${RTYPES.map(t => { const r = d.reports[t]; return `<div class="rp${r.on ? "" : " off"}" data-t="${t}">
      <div class="rp-h"><div><b>${RNAME[t]} report</b><small>${r.on ? `${ruleText(t, r)} at ${hourLabel(r.hour)}` : "Off: not sent"}</small><small>${r.on ? next(t) : ""}</small></div>
        <label class="sw" aria-label="${RNAME[t]} report on or off"><input type="checkbox" data-k="on"${r.on ? " checked" : ""}><span></span></label></div>
      ${r.on ? `<div class="${t === "weekly" ? "row2" : ""}">
        <label class="fld"><span>Send time</span><select data-k="hour">${hours.map(h => `<option value="${h}"${h === r.hour ? " selected" : ""}>${hourLabel(h)}</option>`).join("")}</select></label>
        ${t === "weekly" ? `<label class="fld"><span>Day</span><select data-k="day"><option value="last"${r.day === "last" ? " selected" : ""}>Last working day</option>${WDAYS.map((w, i) => `<option value="${i + 1}"${r.day === i + 1 ? " selected" : ""}>${w}</option>`).join("")}</select></label>` : ""}</div>
      <div class="fld"><span>Recipients</span>
        <div class="tags">${r.to.length ? r.to.map((m, i) => `<span class="tag"><span>${esc(m)}</span><button type="button" data-sc="rm-to" data-i="${i}" aria-label="Remove ${esc(m)}">×</button></span>`).join("") : `<span class="none">No one yet: this report won't be sent until you add someone.</span>`}</div>
        <div class="add-row"><input type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="name@company.com" data-k="new-to"><button type="button" class="btn" data-sc="add-to">Add</button></div>
        ${SC.emailErr[t] ? `<p class="sched-msg err">${esc(SC.emailErr[t])}</p>` : ""}</div>` : ""}
    </div>`; }).join("")}
    <div class="fld"><span>Public holidays (no reports)</span>
      <div class="tags">${d.holidays.length ? d.holidays.map((k, i) => `<span class="tag"><span>${dfy.format(keyDate(k))}</span><button type="button" data-sc="rm-hol" data-i="${i}" aria-label="Remove ${k}">×</button></span>`).join("") : `<span class="none">None. Reports go out every Monday to Friday.</span>`}</div>
      <div class="add-row"><input type="date" data-k="new-hol" aria-label="Holiday date"><button type="button" class="btn" data-sc="add-hol">Add</button></div>
      <p class="hint">If a weekly or monthly report falls on a holiday, it goes out the working day before.</p></div>
    <div class="rp-h"><div><b>Save PDF copies to Google Drive</b><small>In the "Grid Downtime Reports" folder</small></div>
      <label class="sw" aria-label="Save PDF copies to Drive"><input type="checkbox" data-k="drive"${d.saveToDrive ? " checked" : ""}><span></span></label></div>
    <div class="sched-foot">
      <div class="actions"><button type="button" class="btn primary" data-sc="save"${dirty && !SC.saving ? "" : " disabled"}>${SC.saving ? "Saving…" : dirty ? "Save changes" : "Saved"}</button>${dirty && !SC.saving ? `<button type="button" class="btn" data-sc="undo">Undo changes</button>` : ""}</div>
      ${SC.msg ? `<p class="sched-msg ${SC.msgCls}">${esc(SC.msg)}</p>` : ""}
      ${SC.saved && SC.saved.me ? `<p class="hint">Test reports always go to ${esc(SC.saved.me)} only.</p>` : ""}</div>`;
}
function schedAddEmail(t, input) {
  const r = SC.draft.reports[t], vals = String(input.value || "").split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  if (!vals.length) { SC.emailErr[t] = "Type an email address first."; renderSched(); return; }
  const bad = vals.filter(v => !EMAIL_OK(v));
  if (bad.length) { SC.emailErr[t] = `"${bad[0]}" isn't a valid email address.`; renderSched(); const i = $(`#sched-card .rp[data-t="${t}"] [data-k="new-to"]`); if (i) { i.value = input.value; i.focus(); } return; }
  vals.forEach(v => { if (!r.to.some(x => x.toLowerCase() === v.toLowerCase())) r.to.push(v); });
  SC.emailErr[t] = ""; SC.msg = ""; buzz(8); renderSched();
}
$("#sched-card").addEventListener("click", e => {
  const b = e.target.closest("[data-sc]"); if (!b) return;
  const act = b.dataset.sc, box = b.closest(".rp"), t = box && box.dataset.t;
  if (act === "reload") { loadSched(true); return; }
  if (!SC.draft) return;
  if (act === "add-to") { schedAddEmail(t, box.querySelector('[data-k="new-to"]')); return; }
  if (act === "rm-to") { SC.draft.reports[t].to.splice(Number(b.dataset.i), 1); SC.msg = ""; renderSched(); return; }
  if (act === "add-hol") {
    const v = $('#sched-card [data-k="new-hol"]').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { toast("Pick a date first."); return; }
    if (!SC.draft.holidays.includes(v)) { SC.draft.holidays.push(v); SC.draft.holidays.sort(); }
    SC.msg = ""; renderSched(); return;
  }
  if (act === "rm-hol") { SC.draft.holidays.splice(Number(b.dataset.i), 1); SC.msg = ""; renderSched(); return; }
  if (act === "undo") { SC.draft = schedCopy(SC.saved); SC.emailErr = {}; SC.msg = ""; renderSched(); return; }
  if (act === "save") saveSched();
});
$("#sched-card").addEventListener("change", e => {
  const k = e.target.dataset.k, box = e.target.closest(".rp"), t = box && box.dataset.t; if (!SC.draft || !k) return;
  if (k === "on") { SC.draft.reports[t].on = e.target.checked; buzz(8); }
  else if (k === "hour") SC.draft.reports[t].hour = Number(e.target.value);
  else if (k === "day") SC.draft.reports.weekly.day = e.target.value === "last" ? "last" : Number(e.target.value);
  else if (k === "drive") SC.draft.saveToDrive = e.target.checked;
  else if (k === "shift-start") SC.draft.shift.start = Number(e.target.value);
  else if (k === "shift-end") SC.draft.shift.end = Number(e.target.value);
  else return;
  SC.msg = ""; renderSched();
});
$("#sched-card").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.target.dataset.k !== "new-to") return;
  e.preventDefault(); schedAddEmail(e.target.closest(".rp").dataset.t, e.target);
});
async function saveSched() {
  // An address typed but not added yet would be lost: add it first.
  for (const t of RTYPES) { const i = $(`#sched-card .rp[data-t="${t}"] [data-k="new-to"]`); if (i && i.value.trim()) { schedAddEmail(t, i); if (SC.emailErr[t]) return; } }
  if (SC.draft.shift.end - SC.draft.shift.start < 60) { SC.msg = "The shift must end at least an hour after it starts."; SC.msgCls = "err"; renderSched(); return; }
  SC.saving = true; SC.msg = ""; renderSched();
  try {
    const j = await api({ action: "saveSettings", settings: schedCopy(SC.draft) }, 45000);
    if (j && j.ok && j.settings) {
      schedArrived(j.settings); SC.draft = schedCopy(j.settings); SC.loadedAt = Date.now();
      SC.msg = "Saved. Reports will follow this schedule from now on."; SC.msgCls = "ok"; buzz(12); renderRepHint();
    } else { SC.msg = j && j.error === "bad_key" ? "The key was rejected. Reconnect from the Sheet." : "Couldn't save: " + ((j && (j.message || j.error)) || "no answer") + ". Make sure the Google script is up to date."; SC.msgCls = "err"; }
  } catch (e) { SC.msg = "Couldn't reach Google. Your changes are still here; save again when you have signal."; SC.msgCls = "err"; }
  SC.saving = false; renderSched();
}
renderRepHint();

function renderMore() {
  renderConn();
  // Redraw the schedule only when nothing in it is being edited, so a background sync doesn't wipe typing.
  const sc = $("#sched-card"); if (!sc.contains(document.activeElement) || !sc.innerHTML) renderSched();
  loadSched(false);
  document.querySelectorAll("[data-test]").forEach(b => { b.disabled = !cfg; });
  $("#cause-list").innerHTML = CAUSES.map(c => `<span class="chip" style="--cc:${cc(c)}"><i></i>${esc(c)}</span>`).join("");
  $("#ver").textContent = `Version ${VERSION} · ${plural(EV.length, "entry")} on this phone`;
}
let offArmed = false;
$("#conn-card").addEventListener("click", e => {
  const id = e.target.id;
  if (id === "cf-go") { if (!connectFromText($("#cf-link").value)) toast("Paste the whole link from the connect email."); }
  if (id === "cf-sync") { toast("Syncing…"); sync(); }
  if (id === "cf-off") {
    if (!offArmed) { offArmed = true; e.target.textContent = "Tap again to disconnect"; e.target.classList.add("armed"); setTimeout(() => { offArmed = false; renderConn(); }, 4000); return; }
    cfg = null; try { localStorage.removeItem(LS_CFG); localStorage.removeItem(LS_SCHED); } catch (er) {} SC.saved = SC.draft = null; SC.loadedAt = 0; SC.msg = ""; net = "local"; S.synced = false; persist(); remoteEvents = null; remoteActive = undefined; offArmed = false; render(); toast("Disconnected. Your entries stay on this phone.");
  }
});
document.querySelectorAll("[data-test]").forEach(b => b.addEventListener("click", async () => {
  if (!cfg) return; const type = b.dataset.test, label = b.textContent;
  b.disabled = true; b.textContent = "Sending…";
  try {
    if (S.pending.length) await sync();
    const j = await api({ action: "test", type }, 90000);
    if (j && j.ok) toast(`Test ${type} report sent to ${j.sentTo}`, null, null, 5000);
    else toast(j && j.error === "bad_key" ? "The key was rejected. Reconnect from the Sheet." : "Couldn't make the report: " + ((j && (j.message || j.error)) || "unknown error"), null, null, 6000);
  } catch (e) { toast("Couldn't reach Google. Try again when you have signal."); }
  b.disabled = false; b.textContent = label;
}));
$("#bk-save").onclick = () => {
  const data = { app: "grid-downtime-log", version: 2, exported: new Date().toISOString(), events: Object.entries(S.events).map(([id, e]) => ({ id, ...e })) };
  saveFile(`grid-downtime-backup-${isoDate(Date.now())}.json`, JSON.stringify(data, null, 1), "application/json");
};
$("#all-csv").onclick = () => saveFile(`grid-downtime-all-${isoDate(Date.now())}.csv`, csvText(EV, null, null), "text/csv");
let restoreSet = null;
$("#bk-file").addEventListener("change", e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    let arr; try { const p = JSON.parse(rd.result); arr = Array.isArray(p) ? p : p && p.events; } catch (err) {}
    const box = $("#bk-confirm");
    if (!Array.isArray(arr)) { box.innerHTML = `<p class="ed-msg err">That file isn't a backup from this app.</p>`; return; }
    restoreSet = arr.filter(x => x && isFinite(Date.parse(x.start)) && isFinite(Date.parse(x.end)) && Date.parse(x.end) >= Date.parse(x.start))
      .map(x => ({ id: typeof x.id === "string" && /^[A-Za-z0-9_\-.~:@+]{1,100}$/.test(x.id) ? x.id : newId(),
        data: eventData(new Date(Date.parse(x.start)).toISOString(), new Date(Date.parse(x.end)).toISOString(), issuesOf(x).slice(0, 30).map(i => ({ robot: i.robot.slice(0, 80), cause: i.cause, note: i.note.slice(0, 2000) }))) }));
    const fresh = restoreSet.filter(x => !S.events[x.id]).length;
    box.innerHTML = restoreSet.length ? `<p>Restore ${plural(restoreSet.length, "entry")} (${fresh} new, ${restoreSet.length - fresh} updated)?</p><div class="actions" style="margin-top:8px"><button type="button" class="btn primary" id="bk-go">Restore</button><button type="button" class="btn" id="bk-no">Cancel</button></div>` : `<p class="ed-msg err">No valid entries found in that file.</p>`;
  };
  rd.readAsText(f);
});
$("#bk-confirm").addEventListener("click", e => {
  if (e.target.id === "bk-no") { restoreSet = null; $("#bk-confirm").innerHTML = ""; }
  if (e.target.id === "bk-go" && restoreSet) {
    const n = restoreSet.length;
    restoreSet.forEach(x => { applyOp({ t: "ev", id: x.id, data: x.data }); const op = { t: "ev", id: x.id, data: x.data, seq: ++S.seq }; S.pending = S.pending.filter(p => opKey(p) !== opKey(op)); S.pending.push(op); });
    persist(); derive(); render(); scheduleSync(200);
    restoreSet = null; $("#bk-confirm").innerHTML = ""; toast(`Restored ${plural(n, "entry")}`);
  }
});

/* Row taps anywhere */
document.addEventListener("click", e => {
  const r = e.target.closest(".row[data-id]"); if (!r) return;
  if (r.dataset.id === "live") { go("log"); return; }
  openEdit(r.dataset.id);
});

/* ---------- edit sheet ---------- */
const ED = { id: null, issues: [blankIssue()], orig: null, armed: false };
const edS = $("#ed-start"), edE = $("#ed-end"), edBox = $("#ed-issues"), sheet = $("#sheet");
function setEdMsg(t, cls) { const m = $("#ed-msg"); m.textContent = t || ""; m.className = "ed-msg" + (cls ? " " + cls : ""); }
function openEdit(id) {
  const e = id && S.events[id];
  ED.id = e ? id : null; ED.orig = e || null; ED.issues = e ? cleanIssues(issuesOf(e)) : [blankIssue()]; ED.armed = false;
  $("#ed-title").textContent = e ? "Edit downtime" : "Add past downtime";
  const now = Date.now(), s = e ? Date.parse(e.start) : now - 15 * 60000, en = e ? Date.parse(e.end) : now;
  edS.value = toInput(s); edE.value = toInput(en);
  const del = $("#ed-del"); del.hidden = !e; del.classList.remove("armed"); del.textContent = "Delete";
  setEdMsg(""); edBox.innerHTML = issuesHTML(ED.issues); edCheck();
  openSheet(sheet);
}
const closeEdit = () => closeSheet(sheet);
function edTimes() {
  let s = fromInput(edS.value), e = fromInput(edE.value);
  if (ED.orig) { const os = Date.parse(ED.orig.start), oe = Date.parse(ED.orig.end); if (edS.value === toInput(os)) s = os; if (edE.value === toInput(oe)) e = oe; }
  return { s, e };
}
function edCheck() {
  const { s, e } = edTimes(), d = $("#ed-dur");
  if (!isFinite(s) || !isFinite(e)) { d.textContent = ""; return "Enter both times."; }
  if (e <= s) { d.textContent = ""; return "Grid on must be after grid off."; }
  d.textContent = `Downtime: ${fmtDur(e - s)}`;
  if (e > Date.now() + 60000) return "Grid on can't be in the future.";
  return "";
}
function edWarn() {
  const { s, e } = edTimes(); if (!isFinite(s) || !isFinite(e)) return "";
  const o = EV.find(x => x.id !== ED.id && x.s < e && x.e > s);
  let w = o ? `Overlaps another entry (${fmtTime(o.s)}–${fmtTime(o.e)}, ${df.format(o.s)}). Both will count in totals.` : "";
  if (e - s > 12 * 3600000) w = (w ? w + " " : "") + "This is over 12 hours. Check the dates.";
  return w;
}
[edS, edE].forEach(el => el.addEventListener("input", () => { const err = edCheck(); if (err) setEdMsg(err, "err"); else { const w = edWarn(); setEdMsg(w, w ? "warn" : ""); } }));
edBox.addEventListener("click", e => {
  const r = issueClick(edBox, e); if (!r) return; ED.issues = r.list; edBox.innerHTML = issuesHTML(ED.issues);
  if (r.focus != null) { const ins = edBox.querySelectorAll(".iss-robot"); if (ins[r.focus]) ins[r.focus].focus(); }
});
edBox.addEventListener("input", () => { ED.issues = readIssues(edBox); });
$("#ed-close").onclick = closeEdit; $("#ed-cancel").onclick = closeEdit;
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeEdit(); closeSheet($("#txt-sheet")); } });
$("#ed-form").addEventListener("submit", e => {
  e.preventDefault();
  const err = edCheck(); if (err) { setEdMsg(err, "err"); buzz([20, 40, 20]); return; }
  const { s, e: en } = edTimes(), id = ED.id || newId();
  commit({ t: "ev", id, data: eventData(new Date(s).toISOString(), new Date(en).toISOString(), readIssues(edBox)) });
  buzz(10); closeEdit(); toast(ED.orig ? "Changes saved" : "Downtime added");
});
$("#ed-del").onclick = () => {
  const b = $("#ed-del");
  if (!ED.armed) { ED.armed = true; b.classList.add("armed"); b.textContent = "Tap again to delete"; buzz(15); return; }
  const id = ED.id, old = ED.orig; commit({ t: "del", id }); closeEdit();
  toast("Entry deleted", "Undo", () => commit({ t: "ev", id, data: old }));
};

/* ---------- clock ---------- */
let lastRep = 0;
setInterval(() => {
  const now = Date.now();
  if (document.hidden) return;
  if (view === "log") { tickClock(now); if (S.active) renderToday(now); }
  if (view === "reports" && S.active && now - lastRep > 30000) { lastRep = now; renderReports(); }
}, 1000);

/* ---------- offline support ---------- */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").then(reg => {
    reg.addEventListener("updatefound", () => {
      const w = reg.installing; if (!w) return;
      w.addEventListener("statechange", () => { if (w.state === "activated" && navigator.serviceWorker.controller) toast("A new version is ready", "Reload", () => location.reload(), 10000); });
    });
  }).catch(() => {});
}

/* ---------- start ---------- */
derive();
const started = readConnectHash();
setView(started ? "more" : (location.hash.slice(1) || "log"));
updateSync();
if (cfg) sync();
})();

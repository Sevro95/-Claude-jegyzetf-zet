/* Tervezői jegyzetfüzet – PWA
 * Lap: A4 álló, logikai egység 1000 × 1414 (1 mm = 4,762 egység).
 * Tárolás: IndexedDB (offline), szinkron: Google Drive (drive.file hatókör).
 */
(() => {
"use strict";
const APP_VERSION = "1.1.0";
const W = 1000, H = Math.round(1000 * 297 / 210), MM = W / 210;
const BOX = 6 * MM;            // jelölőnégyzet oldala
const QR = 3.2 * MM;           // kérdésjelölő sugara
const INK = "#1b1f24";
const PAPER_LIGHT = "#fdfdfb";
const NB_COLORS = ["#0b6e79", "#1f4fd1", "#c25a00", "#2e7d32", "#8e24aa", "#b3261e", "#5e6a75"];
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const $ = id => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtDate = ts => new Date(ts).toLocaleDateString("hu-HU");
const fmtTime = ts => new Date(ts).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
const clone = o => JSON.parse(JSON.stringify(o));

/* ================= IndexedDB ================= */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("tervezoi-jegyzetfuzet", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("kv");
        d.createObjectStore("pages", { keyPath: "id" });
        d.createObjectStore("blobs");
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), s = t.objectStore(store);
      let out; const req = fn(s);
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(store, key) { return this.tx(store, "readonly", s => s.get(key)); },
  put(store, val, key) { return this.tx(store, "readwrite", s => key === undefined ? s.put(val) : s.put(val, key)); },
  del(store, key) { return this.tx(store, "readwrite", s => s.delete(key)); },
};

/* ================= Állapot ================= */
const DEF_SET = {
  penColor: INK, penW: 2.6, hiColor: "#f2c200", hiW: 3, erMode: "stroke", erR: 12,
  recentPen: ["#1f4fd1", "#c62828", "#2e7d32"], recentHi: ["#7fd36b", "#5ec8f0", "#f59ab5"],
  recentW: { pen: [], hi: [] }, favW: { pen: null, hi: null },
  rail: "right", lastNb: null, lastPage: {}, clientId: "", driveOn: false,
};
const S = {
  set: { ...DEF_SET }, notebooks: [], nb: null, page: null, pages: new Map(),
  tool: "pen", sel: null, undo: new Map(), redo: new Map(), deleted: { pages: {}, notebooks: {} },
};
const nbOf = id => S.notebooks.find(n => n.id === id);
const saveSettings = () => DB.put("kv", S.set, "settings").catch(console.error);
const saveNotebooks = () => DB.put("kv", S.notebooks, "notebooks").catch(console.error);
const saveDeleted = () => DB.put("kv", S.deleted, "deleted").catch(console.error);

function newPage(nb, opts = {}) {
  const now = Date.now();
  return { id: uid(), nb: nb.id, created: now, updated: now, paper: opts.paper || nb.paper || "grid",
    bg: opts.bg || null, strokes: [], marks: [] };
}
function newNotebook(name, color, paper) {
  const now = Date.now();
  return { id: uid(), name, color, paper: paper || "grid", created: now, updated: now, pages: [] };
}
function bbox(s) {
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const q of s.p) { if (q[0] < a) a = q[0]; if (q[1] < b) b = q[1]; if (q[0] > c) c = q[0]; if (q[1] > d) d = q[1]; }
  s.bb = [a, b, c, d]; return s;
}

/* Tárolási formátum: pontok delta-kódolva (x,y ×10, nyomás ×100) */
function packPts(p) { const o = []; let px = 0, py = 0, pp = 0;
  for (const q of p) { const x = Math.round(q[0] * 10), y = Math.round(q[1] * 10), z = Math.round(q[2] * 100); o.push(x - px, y - py, z - pp); px = x; py = y; pp = z; }
  return o.join(","); }
function unpackPts(s) { const a = s ? s.split(",").map(Number) : [], o = []; let x = 0, y = 0, z = 0;
  for (let i = 0; i + 2 < a.length; i += 3) { x += a[i]; y += a[i + 1]; z += a[i + 2]; o.push([x / 10, y / 10, z / 100]); }
  return o; }
function serializePage(pg) {
  return { v: 1, id: pg.id, nb: pg.nb, created: pg.created, updated: pg.updated, paper: pg.paper, bg: pg.bg,
    strokes: pg.strokes.map(s => ({ id: s.id, t: s.t, c: s.c, w: s.w, ts: s.ts, mt: s.mt || s.ts, p: packPts(s.p) })),
    marks: pg.marks.map(m => ({ ...m })) };
}
function deserializePage(o) {
  return { id: o.id, nb: o.nb, created: o.created, updated: o.updated, paper: o.paper || "grid", bg: o.bg || null,
    strokes: (o.strokes || []).map(s => bbox({ id: s.id, t: s.t, c: s.c, w: s.w, ts: s.ts, mt: s.mt, p: unpackPts(s.p) })),
    marks: (o.marks || []).map(m => ({ ...m })) };
}
const pageTimers = {};
function persistPage(pg, now) {
  clearTimeout(pageTimers[pg.id]);
  const run = () => DB.put("pages", serializePage(pg)).catch(e => { console.error(e); toast("Mentési hiba: " + e.message); });
  if (now) return run();
  pageTimers[pg.id] = setTimeout(run, 600);
}
function touchPage(pg) {
  pg.updated = Date.now();
  persistPage(pg);
  updateOpenBadge(); renderPageList();
  Sync.schedule(8000);
}
async function loadPage(id) {
  if (S.pages.has(id)) return S.pages.get(id);
  const o = await DB.get("pages", id);
  if (!o) return null;
  const pg = deserializePage(o); S.pages.set(id, pg); return pg;
}
async function loadNotebookPages(nb) { for (const id of nb.pages) await loadPage(id); }

/* ================= Rajzolás ================= */
const cP = $("cPaper"), cI = $("cInk"), cL = $("cLive");
const xP = cP.getContext("2d"), xI = cI.getContext("2d"), xL = cL.getContext("2d");
let SC = 1, DPR = 1; // SC: CSS px / egység
const bgCache = new Map();

function layout() {
  const desk = $("desk"), cs = getComputedStyle(desk);
  const cw = Math.max(280, Math.floor(desk.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
  const ch = Math.round(cw * H / W);
  const sheet = $("sheet"); sheet.style.width = cw + "px"; sheet.style.height = ch + "px";
  SC = cw / W;
  DPR = Math.min(window.devicePixelRatio || 1, 2000 / cw); // memóriakorlát: max. 2000 px széles vászon
  for (const c of [cP, cI, cL]) { c.width = Math.round(cw * DPR); c.height = Math.round(ch * DPR); }
  for (const x of [xP, xI, xL]) x.setTransform(DPR * SC, 0, 0, DPR * SC, 0, 0);
  drawPaper(); drawInk(); placeSel();
}

async function ensureBg(pg) {
  if (!pg || !pg.bg || bgCache.has(pg.bg.id)) return;
  const blob = await DB.get("blobs", pg.bg.id);
  if (!blob) return;
  try { bgCache.set(pg.bg.id, await createImageBitmap(blob)); } catch (e) { console.error(e); }
}
function bgRect(pg) {
  const r = pg.bg.w / pg.bg.h; let w = W, h = W / r;
  if (h > H) { h = H; w = H * r; }
  return [(W - w) / 2, 0, w, h];
}
/* Papír, háttér, dátum (jobb felül), oldalszám (alul középen) */
function paintPaper(x, pg, px, paperColor, pageNo) {
  x.fillStyle = paperColor; x.fillRect(0, 0, W, H);
  if (!pg) return;
  if (pg.bg && bgCache.has(pg.bg.id)) { const [a, b, c, d] = bgRect(pg); x.drawImage(bgCache.get(pg.bg.id), a, b, c, d); }
  const rule = "#c9d9e6", strong = "#9fbad0";
  const line = (a, b, c, d, col, w) => { x.strokeStyle = col; x.lineWidth = w * px; x.beginPath(); x.moveTo(a, b); x.lineTo(c, d); x.stroke(); };
  if (pg.paper === "grid") {
    for (let v = 0; v <= W + .1; v += 5 * MM) line(v, 0, v, H, rule, .8);
    for (let v = 0; v <= H + .1; v += 5 * MM) line(0, v, W, v, rule, .8);
  } else if (pg.paper === "mm") {
    for (let i = 0; i * MM <= W + .1; i++) line(i * MM, 0, i * MM, H, i % 10 ? rule : strong, i % 10 === 0 ? 1.2 : i % 5 === 0 ? .9 : .4);
    for (let i = 0; i * MM <= H + .1; i++) line(0, i * MM, W, i * MM, i % 10 ? rule : strong, i % 10 === 0 ? 1.2 : i % 5 === 0 ? .9 : .4);
  } else if (pg.paper === "lined") {
    for (let v = 25 * MM; v < H - 15 * MM; v += 8 * MM) line(0, v, W, v, rule, .8);
    line(20 * MM, 0, 20 * MM, H, "#e3a3a3", 1);
  } else if (pg.paper === "dots") {
    x.fillStyle = strong; const r = Math.max(.9 * px, .5);
    for (let a = 5 * MM; a < W; a += 5 * MM) for (let b = 5 * MM; b < H; b += 5 * MM) { x.beginPath(); x.arc(a, b, r, 0, 7); x.fill(); }
  }
  // fejléc / lábléc – a lap tartalmához tartozik, exportban is látszik
  const fs = 3.3 * MM;
  x.font = `500 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  x.textBaseline = "alphabetic";
  const date = fmtDate(pg.created);
  x.textAlign = "right"; const tw = x.measureText(date).width;
  x.fillStyle = paperColor; x.fillRect(W - 8 * MM - tw - 1.5 * MM, 5 * MM, tw + 3 * MM, fs + 2 * MM);
  x.fillStyle = "#4f5b66"; x.fillText(date, W - 8 * MM, 5 * MM + fs + .6 * MM);
  if (pageNo) {
    x.textAlign = "center"; const t = String(pageNo), w2 = x.measureText(t).width;
    x.fillStyle = paperColor; x.fillRect(W / 2 - w2 / 2 - 2 * MM, H - 11 * MM, w2 + 4 * MM, fs + 2.5 * MM);
    x.fillStyle = "#4f5b66"; x.fillText(t, W / 2, H - 11 * MM + fs + .6 * MM);
  }
  x.textAlign = "left";
}
const pageNoOf = pg => { const nb = nbOf(pg.nb); return nb ? nb.pages.indexOf(pg.id) + 1 : 0; };
function drawPaper() {
  xP.clearRect(0, 0, W, H);
  const paperColor = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || PAPER_LIGHT;
  paintPaper(xP, S.page, 1 / (SC * DPR), paperColor, S.page ? pageNoOf(S.page) : 0);
}

const wOf = (s, pr) => s.t === "h" ? s.w * 6 : s.w * (0.35 + 0.95 * pr);
function drawStroke(x, s) {
  const p = s.p; if (!p.length) return;
  x.lineCap = "round"; x.lineJoin = "round";
  if (s.t === "h") {
    x.save(); x.globalAlpha = .36; x.globalCompositeOperation = "multiply"; x.strokeStyle = s.c; x.lineWidth = s.w * 6; x.lineCap = "butt";
    x.beginPath(); x.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) x.lineTo(p[i][0], p[i][1]);
    if (p.length === 1) x.lineTo(p[0][0] + .1, p[0][1]); x.stroke(); x.restore(); return;
  }
  x.strokeStyle = s.c; x.fillStyle = s.c;
  if (p.length === 1) { x.beginPath(); x.arc(p[0][0], p[0][1], wOf(s, p[0][2]) / 2, 0, 7); x.fill(); return; }
  for (let i = 1; i < p.length; i++) seg(x, s, i);
}
function seg(x, s, i) {
  const p = s.p, a = p[i - 1], b = p[i];
  const m0 = i === 1 ? a : [(p[i - 2][0] + a[0]) / 2, (p[i - 2][1] + a[1]) / 2];
  const m1 = i === p.length - 1 ? b : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  x.lineWidth = wOf(s, (a[2] + b[2]) / 2); x.beginPath(); x.moveTo(m0[0], m0[1]);
  x.quadraticCurveTo(a[0], a[1], m1[0], m1[1]); x.stroke();
}
/* Kész feladat kihúzása: a négyzettől jobbra, ugyanabban a sorban lévő kézírás */
function strikeFor(pg, m) {
  const top = m.y - .35 * BOX, bot = m.y + 1.35 * BOX;
  const cand = pg.strokes.filter(s => {
    if (s.t !== "p" || s.bb[0] < m.x + BOX * .6) return false;
    const cy = (s.bb[1] + s.bb[3]) / 2; return cy >= top && cy <= bot && (s.bb[3] - s.bb[1]) < 2.4 * BOX;
  }).sort((a, b) => a.bb[0] - b.bb[0]);
  let right = m.x + BOX, any = false;
  for (const s of cand) { if (s.bb[0] - right > 22 * MM) break; right = Math.max(right, s.bb[2]); any = true; }
  return any ? [m.x + BOX + 1.5 * MM, m.y + BOX / 2, right + 1 * MM] : null;
}
const QFS = 3.4 * MM, QPAD = 1.8 * MM, QMAXW = 75 * MM;
const measureCtx = document.createElement("canvas").getContext("2d");
/* Kérdés szövegbuborék elrendezése (a kör mellett jobbra, ha nem fér el: alatta) */
function qLayout(m) {
  if (!m.text || !m.text.trim()) return null;
  const c = measureCtx; c.font = `500 ${QFS}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const lines = [];
  for (const para of m.text.trim().split(/\n/)) {
    let cur = "";
    for (const w of para.split(/\s+/)) { const t = cur ? cur + " " + w : w;
      if (cur && c.measureText(t).width > QMAXW) { lines.push(cur); cur = w; } else cur = t; }
    lines.push(cur);
  }
  const tw = Math.max(...lines.map(l => c.measureText(l).width));
  const w = Math.min(QMAXW, tw) + 2 * QPAD, h = lines.length * QFS * 1.3 - QFS * .3 + 2 * QPAD;
  let x = m.x + QR + 3 * MM, y = m.y - Math.min(h / 2, QR + QPAD), below = false;
  if (x + w > W - 3 * MM) { x = Math.max(3 * MM, Math.min(m.x - w / 2, W - 3 * MM - w)); y = m.y + QR + 2.5 * MM; below = true; }
  return { x, y, w, h, lines, below };
}
function drawBubble(x, m, L) {
  const col = m.done ? "#2e7d32" : "#c25a00";
  x.save(); x.lineWidth = 1.8; x.strokeStyle = col; x.fillStyle = m.done ? "#eef7ee" : "#fff4e8";
  x.beginPath(); if (x.roundRect) x.roundRect(L.x, L.y, L.w, L.h, 2 * MM); else x.rect(L.x, L.y, L.w, L.h);
  x.fill(); x.stroke();
  // csőr a kör felé
  x.beginPath();
  if (L.below) { const cx = Math.min(Math.max(m.x, L.x + 3 * MM), L.x + L.w - 3 * MM); x.moveTo(cx - 1.6 * MM, L.y + .5); x.lineTo(m.x, m.y + QR + .5); x.lineTo(cx + 1.6 * MM, L.y + .5); }
  else { const cy = Math.min(Math.max(m.y, L.y + 2.5 * MM), L.y + L.h - 2.5 * MM); x.moveTo(L.x + .5, cy - 1.6 * MM); x.lineTo(m.x + QR + .5, m.y); x.lineTo(L.x + .5, cy + 1.6 * MM); }
  x.fill(); x.stroke();
  x.fillStyle = m.done ? "#5e6a75" : INK; x.font = `500 ${QFS}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  x.textAlign = "left"; x.textBaseline = "top";
  L.lines.forEach((t, i) => x.fillText(t, L.x + QPAD, L.y + QPAD + i * QFS * 1.3));
  x.restore();
}
function drawMark(x, m) {
  x.save(); x.lineCap = "round"; x.lineJoin = "round";
  if (m.k === "box") {
    x.strokeStyle = INK; x.lineWidth = 2.2; x.strokeRect(m.x, m.y, BOX, BOX);
    if (m.done) { x.strokeStyle = "#2e7d32"; x.lineWidth = 3.2; x.beginPath();
      x.moveTo(m.x + BOX * .2, m.y + BOX * .52); x.lineTo(m.x + BOX * .42, m.y + BOX * .76); x.lineTo(m.x + BOX * .84, m.y + BOX * .22); x.stroke(); }
  } else {
    const col = m.done ? "#2e7d32" : "#c25a00";
    x.strokeStyle = col; x.fillStyle = col; x.lineWidth = 2.2;
    x.beginPath(); x.arc(m.x, m.y, QR, 0, 7); x.stroke();
    if (m.done) { x.lineWidth = 3; x.beginPath(); x.moveTo(m.x - QR * .45, m.y + QR * .02); x.lineTo(m.x - QR * .1, m.y + QR * .38); x.lineTo(m.x + QR * .5, m.y - QR * .38); x.stroke(); }
    else { x.font = `700 ${QR * 1.35}px system-ui, sans-serif`; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("?", m.x, m.y + QR * .06); }
    const L = qLayout(m); if (L) { x.restore(); drawBubble(x, m, L); return; }
  }
  x.restore();
}
function paintInk(x, pg) {
  for (const s of pg.strokes) drawStroke(x, s);
  for (const m of pg.marks) {
    drawMark(x, m);
    if (m.k === "box" && m.done) {
      const st = strikeFor(pg, m);
      if (st) { x.save(); x.strokeStyle = "rgba(27,31,36,.8)"; x.lineWidth = 2.2; x.lineCap = "round"; x.beginPath(); x.moveTo(st[0], st[1]); x.lineTo(st[2], st[1]); x.stroke(); x.restore(); }
    }
  }
}
function drawInk() { xI.clearRect(0, 0, W, H); if (S.page) paintInk(xI, S.page); }
let inkRaf = 0;
function drawInkSoon() { if (!inkRaf) inkRaf = requestAnimationFrame(() => { inkRaf = 0; drawInk(); }); }

/* Teljes lap képe (export, Drive) */
async function renderPageCanvas(pg, widthPx) {
  await ensureBg(pg);
  const c = document.createElement("canvas"); c.width = widthPx; c.height = Math.round(widthPx * H / W);
  const x = c.getContext("2d"), k = widthPx / W; x.setTransform(k, 0, 0, k, 0, 0);
  paintPaper(x, pg, 1 / k, "#ffffff", pageNoOf(pg)); paintInk(x, pg);
  return c;
}

/* ================= Bevitel ================= */
let act = null, pan = null, penUntil = 0;
const ptOf = e => { const r = cL.getBoundingClientRect(); return [(e.clientX - r.left) / SC, (e.clientY - r.top) / SC]; };
const pressureOf = e => e.pointerType === "pen" ? Math.max(.05, Math.min(1, e.pressure || .5)) : .5;
const isEraserEvt = e => !!((e.buttons & 32) || (e.buttons & 2) || e.button === 5 || e.button === 2);
const snapshot = pg => ({ strokes: pg.strokes.slice(), marks: pg.marks.map(m => ({ ...m })) });
function pushUndo(pg, snap) {
  if (!S.undo.has(pg.id)) S.undo.set(pg.id, []);
  const u = S.undo.get(pg.id); u.push(snap); if (u.length > 80) u.shift();
  S.redo.set(pg.id, []); updUR();
}
function updUR() { const id = S.page && S.page.id;
  $("bUndo").disabled = !(S.undo.get(id) || []).length; $("bRedo").disabled = !(S.redo.get(id) || []).length; }
function restore(pg, snap) { pg.strokes = snap.strokes.slice(); pg.marks = snap.marks.map(m => ({ ...m })); clearSel(); drawInk(); touchPage(pg); }
$("bUndo").onclick = () => { const pg = S.page, u = S.undo.get(pg.id) || []; if (!u.length) return;
  (S.redo.get(pg.id) || S.redo.set(pg.id, []).get(pg.id)).push(snapshot(pg)); restore(pg, u.pop()); updUR(); };
$("bRedo").onclick = () => { const pg = S.page, r = S.redo.get(pg.id) || []; if (!r.length) return;
  (S.undo.get(pg.id) || S.undo.set(pg.id, []).get(pg.id)).push(snapshot(pg)); restore(pg, r.pop()); updUR(); };

function markAt(pg, x, y, k) {
  for (let i = pg.marks.length - 1; i >= 0; i--) { const m = pg.marks[i]; if (k && m.k !== k) continue;
    if (m.k === "box" ? (x >= m.x - 2 * MM && x <= m.x + BOX + 2 * MM && y >= m.y - 2 * MM && y <= m.y + BOX + 2 * MM)
      : (Math.hypot(x - m.x, y - m.y) <= QR + 2 * MM || (() => { const L = qLayout(m); return L && x >= L.x && x <= L.x + L.w && y >= L.y && y <= L.y + L.h; })())) return m; }
  return null;
}
function questionDialog(pg, m, x, y) {
  const isNew = !m;
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `<label for="qText">Kérdés</label><textarea id="qText" rows="4" maxlength="400" placeholder="Mi a kérdés?"></textarea>` +
    (isNew ? "" : `<p>${m.done ? "Lezárt kérdés" : "Nyitott kérdés"} · ${fmtDate(m.ts)}</p>`);
  const ta = body.querySelector("#qText"); ta.value = isNew ? "" : (m.text || "");
  const save = done => {
    const text = ta.value.trim(); pushUndo(pg, snapshot(pg));
    if (isNew) pg.marks.push({ id: uid(), k: "q", x, y, done: false, ts: Date.now(), text });
    else { const t = pg.marks.find(q => q.id === m.id); if (t) { t.text = text; t.mt = Date.now(); if (done !== undefined) { t.done = done; t.dt = Date.now(); } } }
    drawInk(); touchPage(pg);
  };
  const btns = [];
  if (!isNew) btns.push(["Törlés", "dan", () => { pushUndo(pg, snapshot(pg)); pg.marks = pg.marks.filter(q => q.id !== m.id); drawInk(); touchPage(pg); toast("Kérdés törölve"); }]);
  btns.push(["Mégse"]);
  if (!isNew) { const wasDone = !!m.done; btns.push([wasDone ? "Újranyitás" : "Lezárás", "", () => { save(!wasDone); toast(wasDone ? "Kérdés újra nyitott" : "Kérdés lezárva"); }]); }
  btns.push(["Mentés", "pri", () => save()]);
  dialog(isNew ? "Új kérdés" : "Kérdés", body, btns);
  setTimeout(() => ta.focus(), 60);
}
function toggleMark(pg, m) { pushUndo(pg, snapshot(pg)); m.done = !m.done; m.dt = Date.now(); drawInk(); touchPage(pg);
  toast(m.k === "box" ? (m.done ? "Feladat kész" : "Feladat újra nyitott") : (m.done ? "Kérdés lezárva" : "Kérdés újra nyitott")); }

const capture = e => { try { cL.setPointerCapture(e.pointerId); } catch (err) {} };
cL.addEventListener("contextmenu", e => e.preventDefault());
let penDbg = false;
const dbgShow = (e, kind) => { if (!penDbg) return; const d = $("penDbg"); d.hidden = false;
  d.textContent = `${kind}  típus: ${e.pointerType}  button: ${e.button}  buttons: ${e.buttons}  nyomás: ${(e.pressure || 0).toFixed(2)}  → radír: ${isEraserEvt(e) ? "IGEN" : "nem"}`; };
for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) cL.addEventListener(t, e => dbgShow(e, t.replace("pointer", "")), true);
cL.addEventListener("pointerdown", e => {
  if (e.pointerType === "touch") {
    if (act || Date.now() < penUntil) return; // tenyérfelismerés
    pan = { id: e.pointerId, y: e.clientY, st: $("desk").scrollTop }; capture(e); return;
  }
  if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2 && e.button !== 5) return;
  if (act) return;
  pan = null; e.preventDefault(); capture(e); closePops();
  if (e.pointerType === "pen") penUntil = Date.now() + 800;
  const pg = S.page; if (!pg) return;
  const [x, y] = ptOf(e), id = e.pointerId;
  if (S.tool === "er" || isEraserEvt(e)) { clearSel(); act = { kind: "erase", id, snap: snapshot(pg), changed: false }; eraseAt(x, y); return; }
  if (S.sel) {
    if (S.tool === "lasso" && inBB(S.sel.bb, x, y, 2 * MM)) { act = { kind: "move", id, lx: x, ly: y, snap: snapshot(pg), cloned: false, moved: false }; return; }
    clearSel();
  }
  if (S.tool === "lasso") { act = { kind: "lasso", id, pts: [[x, y]] }; return; }
  if (S.tool === "box" || S.tool === "q") { act = { kind: "place", id, x, y }; return; }
  const p0 = [x, y, pressureOf(e)];
  if (S.tool === "pen") { const m = markAt(pg, x, y); if (m) { act = { kind: "tap", id, m, sx: e.clientX, sy: e.clientY, p0 }; return; } }
  startStroke(id, p0);
});
function startStroke(id, p0) {
  const t = S.tool === "hi" ? "h" : "p";
  const s = { id: uid(), t, c: t === "h" ? S.set.hiColor : S.set.penColor, w: t === "h" ? S.set.hiW : S.set.penW, p: [p0], ts: Date.now() };
  act = { kind: "draw", id, s };
  if (t === "p") drawStroke(xL, s);
}
cL.addEventListener("pointermove", e => {
  if (pan && e.pointerId === pan.id) { $("desk").scrollTop = pan.st - (e.clientY - pan.y); return; }
  if (!act || e.pointerId !== act.id) return;
  if (e.pointerType === "pen") penUntil = Date.now() + 800;
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
  // ha írás közben nyomja le az S Pen gombot: radírra váltunk
  if ((act.kind === "draw" || act.kind === "tap") && isEraserEvt(e)) {
    xL.clearRect(0, 0, W, H); act = { kind: "erase", id: act.id, snap: snapshot(S.page), changed: false };
  }
  if (act.kind === "tap") {
    if (Math.hypot(e.clientX - act.sx, e.clientY - act.sy) > 6) { const p0 = act.p0; startStroke(act.id, p0); } else return;
  }
  if (act.kind === "erase") { for (const ev of evs) { const [x, y] = ptOf(ev); eraseAt(x, y); } return; }
  if (act.kind === "lasso") { const L = act.pts; for (const ev of evs) L.push(ptOf(ev));
    xL.clearRect(0, 0, W, H); xL.save(); xL.setLineDash([6, 5]); xL.strokeStyle = "#0b6e79"; xL.lineWidth = 2; xL.beginPath();
    xL.moveTo(L[0][0], L[0][1]); for (const q of L) xL.lineTo(q[0], q[1]); xL.stroke(); xL.restore(); return; }
  if (act.kind === "move") { const [x, y] = ptOf(e); moveSel(x - act.lx, y - act.ly); act.lx = x; act.ly = y; return; }
  if (act.kind === "draw") {
    const s = act.s;
    for (const ev of evs) { const [x, y] = ptOf(ev), l = s.p[s.p.length - 1];
      if (Math.hypot(x - l[0], y - l[1]) < .5 / SC) continue;
      s.p.push([x, y, pressureOf(ev)]); if (s.t === "p" && s.p.length > 2) seg(xL, s, s.p.length - 2); }
    if (s.t === "h") { xL.clearRect(0, 0, W, H); drawStroke(xL, s); }
  }
});
function endPointer(e) {
  if (pan && e.pointerId === pan.id) { pan = null; return; }
  if (!act || e.pointerId !== act.id) return;
  const a = act; act = null; const pg = S.page;
  if (a.kind === "tap") { if (a.m.k === "q") questionDialog(pg, a.m); else toggleMark(pg, a.m); return; }
  if (a.kind === "erase") { if (a.changed) { pushUndo(pg, a.snap); touchPage(pg); } return; }
  if (a.kind === "place") {
    const k = S.tool, m = markAt(pg, a.x, a.y, k);
    if (m) { if (k === "q") questionDialog(pg, m); else toggleMark(pg, m); return; }
    if (k === "q") { questionDialog(pg, null, a.x, a.y); return; }
    pushUndo(pg, snapshot(pg));
    const nm = k === "box" ? { id: uid(), k, x: a.x - BOX / 2, y: a.y - BOX / 2, done: false, ts: Date.now() }
      : { id: uid(), k, x: a.x, y: a.y, done: false, ts: Date.now() };
    pg.marks.push(nm); drawInk(); touchPage(pg); return;
  }
  if (a.kind === "lasso") { xL.clearRect(0, 0, W, H); selectPoly(a.pts); return; }
  if (a.kind === "move") { if (a.moved) { pushUndo(pg, a.snap); touchPage(pg); } return; }
  if (a.kind === "draw") {
    const s = a.s; xL.clearRect(0, 0, W, H); bbox(s); s.mt = s.ts;
    const snap = snapshot(pg); pg.strokes.push(s); pushUndo(pg, snap);
    if (pg.marks.some(m => m.done && m.k === "box")) drawInk(); else drawStroke(xI, s);
    if (s.t === "p") rememberColor("pen", s.c);
    rememberWidth(s.t === "h" ? "hi" : "pen", s.w);
    touchPage(pg);
  }
}
cL.addEventListener("pointerup", endPointer);
cL.addEventListener("pointercancel", e => { if (act && act.kind === "draw" && e.pointerId === act.id) { endPointer(e); } else if (act && e.pointerId === act.id) { act = null; xL.clearRect(0, 0, W, H); } else if (pan && pan.id === e.pointerId) pan = null; });

/* Radír: egész vonal vagy csak a radír alatti rész */
function nearSeg(ax, ay, bx, by, x, y, r) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy; let t = L ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t)); return Math.hypot(ax + t * dx - x, ay + t * dy - y) < r;
}
function eraseAt(x, y) {
  const pg = S.page, R = S.set.erR; let hit = false; const out = [];
  for (const s of pg.strokes) {
    const r = R + (s.t === "h" ? s.w * 3 : s.w * .6);
    if (x < s.bb[0] - r || x > s.bb[2] + r || y < s.bb[1] - r || y > s.bb[3] + r) { out.push(s); continue; }
    const p = s.p;
    const touched = p.length === 1 ? Math.hypot(p[0][0] - x, p[0][1] - y) < r
      : p.some((q, i) => i > 0 && nearSeg(p[i - 1][0], p[i - 1][1], q[0], q[1], x, y, r));
    if (!touched) { out.push(s); continue; }
    hit = true;
    if (S.set.erMode === "part") {
      let cur = [];
      const flush = () => { if (cur.length >= 2) out.push(bbox({ ...s, id: uid(), p: cur, mt: Date.now() })); cur = []; };
      // ritka pontú (gyors) vonalnál sűrítünk, hogy a radír a pontok között is vágjon
      const dense = [p[0]], stepMax = Math.max(1.5, r / 3);
      for (let i = 1; i < p.length; i++) { const a = p[i - 1], b = p[i], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / stepMax);
        for (let j = 1; j <= n; j++) { const t = j / n; dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); } }
      for (const q of dense) { if (Math.hypot(q[0] - x, q[1] - y) < r) flush(); else cur.push(q); }
      flush();
    }
  }
  const mk = pg.marks.filter(m => !(m.k === "box" ? (x > m.x - R && x < m.x + BOX + R && y > m.y - R && y < m.y + BOX + R) : Math.hypot(x - m.x, y - m.y) < QR + R));
  if (mk.length !== pg.marks.length) { pg.marks = mk; hit = true; }
  if (hit) { pg.strokes = out; act.changed = true; drawInkSoon(); }
}

/* Lasszó */
function inPoly(x, y, P) { let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; }
  return c; }
const inBB = (bb, x, y, pad) => x >= bb[0] - pad && x <= bb[2] + pad && y >= bb[1] - pad && y <= bb[3] + pad;
function selectPoly(P) {
  const pg = S.page; if (P.length < 4) return;
  const ids = new Set(), mids = new Set();
  for (const s of pg.strokes) { let n = 0; for (const q of s.p) if (inPoly(q[0], q[1], P)) n++; if (n / s.p.length >= .5) ids.add(s.id); }
  for (const m of pg.marks) { const cx = m.k === "box" ? m.x + BOX / 2 : m.x, cy = m.k === "box" ? m.y + BOX / 2 : m.y; if (inPoly(cx, cy, P)) mids.add(m.id); }
  if (!ids.size && !mids.size) { toast("Nincs kijelölt elem"); return; }
  S.sel = { ids, mids }; selBounds(); placeSel();
}
function selBounds() {
  const pg = S.page, bb = [1e9, 1e9, -1e9, -1e9];
  for (const s of pg.strokes) if (S.sel.ids.has(s.id)) { bb[0] = Math.min(bb[0], s.bb[0]); bb[1] = Math.min(bb[1], s.bb[1]); bb[2] = Math.max(bb[2], s.bb[2]); bb[3] = Math.max(bb[3], s.bb[3]); }
  for (const m of pg.marks) if (S.sel.mids.has(m.id)) { const r = m.k === "box" ? [m.x, m.y, m.x + BOX, m.y + BOX] : [m.x - QR, m.y - QR, m.x + QR, m.y + QR];
    bb[0] = Math.min(bb[0], r[0]); bb[1] = Math.min(bb[1], r[1]); bb[2] = Math.max(bb[2], r[2]); bb[3] = Math.max(bb[3], r[3]); }
  const pad = 2 * MM; S.sel.bb = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad];
}
function placeSel() {
  const box = $("selBox"), bar = $("selBar");
  if (!S.sel) { box.hidden = true; bar.hidden = true; return; }
  const [a, b, c, d] = S.sel.bb;
  Object.assign(box.style, { left: a * SC + "px", top: b * SC + "px", width: (c - a) * SC + "px", height: (d - b) * SC + "px" });
  box.hidden = false; bar.hidden = false;
  const r = $("sheet").getBoundingClientRect(), br = bar.getBoundingClientRect(), dr = $("desk").getBoundingClientRect();
  let top = r.top + b * SC - br.height - 10; if (top < dr.top + 6) top = r.top + d * SC + 10;
  top = Math.min(Math.max(top, dr.top + 6), dr.bottom - br.height - 6);
  let left = r.left + ((a + c) / 2) * SC - br.width / 2; left = Math.max(dr.left + 6, Math.min(left, dr.right - br.width - 6));
  bar.style.top = top + "px"; bar.style.left = left + "px";
}
function clearSel() { if (!S.sel) return; S.sel = null; placeSel(); }
function moveSel(dx, dy) {
  const pg = S.page;
  if (!act.cloned) { // az áthelyezett vonalak új objektumok, hogy a visszavonás az eredetit őrizze
    pg.strokes = pg.strokes.map(s => S.sel.ids.has(s.id) ? { ...s, p: s.p.map(q => q.slice()), bb: s.bb.slice() } : s);
    act.cloned = true;
  }
  const now = Date.now();
  for (const s of pg.strokes) if (S.sel.ids.has(s.id)) { for (const q of s.p) { q[0] += dx; q[1] += dy; } s.bb[0] += dx; s.bb[2] += dx; s.bb[1] += dy; s.bb[3] += dy; s.mt = now; }
  for (const m of pg.marks) if (S.sel.mids.has(m.id)) { m.x += dx; m.y += dy; }
  S.sel.bb = [S.sel.bb[0] + dx, S.sel.bb[1] + dy, S.sel.bb[2] + dx, S.sel.bb[3] + dy];
  act.moved = true; drawInkSoon(); placeSel();
}
$("sDel").onclick = () => { const pg = S.page; pushUndo(pg, snapshot(pg));
  pg.strokes = pg.strokes.filter(s => !S.sel.ids.has(s.id)); pg.marks = pg.marks.filter(m => !S.sel.mids.has(m.id));
  clearSel(); drawInk(); touchPage(pg); };
$("sCopy").onclick = () => { const pg = S.page; pushUndo(pg, snapshot(pg)); const off = 8 * MM, now = Date.now(), ids = new Set(), mids = new Set();
  for (const s of pg.strokes.filter(s => S.sel.ids.has(s.id))) { const n = bbox({ ...s, id: uid(), ts: now, mt: now, p: s.p.map(q => [q[0] + off, q[1] + off, q[2]]) }); pg.strokes.push(n); ids.add(n.id); }
  for (const m of pg.marks.filter(m => S.sel.mids.has(m.id))) { const n = { ...m, id: uid(), x: m.x + off, y: m.y + off, ts: now, done: false }; delete n.dt; pg.marks.push(n); mids.add(n.id); }
  S.sel = { ids, mids }; selBounds(); placeSel(); drawInk(); touchPage(pg); };
$("sColor").onclick = () => pickColorDialog("Kijelölés átszínezése", S.set.penColor, "pen", c => {
  const pg = S.page; pushUndo(pg, snapshot(pg)); const now = Date.now();
  pg.strokes = pg.strokes.map(s => S.sel.ids.has(s.id) ? { ...s, c, mt: now } : s);
  rememberColor("pen", c); drawInk(); touchPage(pg); });
$("desk").addEventListener("scroll", () => { if (S.sel) placeSel(); }, { passive: true });

/* ================= Eszközök, színek ================= */
function setTool(t) {
  if (t !== "lasso") clearSel();
  S.tool = t;
  document.querySelectorAll(".tool").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
  renderColors();
}
document.querySelectorAll(".tool").forEach(b => b.addEventListener("click", () => {
  const t = b.dataset.tool;
  if (S.tool === t && (t === "pen" || t === "hi" || t === "er")) { openToolPop(b); return; }
  setTool(t); closePops();
}));
function colorKind() { return S.tool === "hi" ? "hi" : "pen"; }
function rememberColor(kind, c) {
  const key = kind === "hi" ? "recentHi" : "recentPen", curKey = kind === "hi" ? "hiColor" : "penColor";
  const prev = S.set[curKey];
  if (prev && prev.toLowerCase() !== c.toLowerCase()) S.set[key] = [prev, ...S.set[key].filter(x => x.toLowerCase() !== prev.toLowerCase() && x.toLowerCase() !== c.toLowerCase())].slice(0, 3);
  else S.set[key] = S.set[key].filter(x => x.toLowerCase() !== c.toLowerCase()).slice(0, 3);
  S.set[curKey] = c; saveSettings(); renderColors();
}
function renderColors() {
  const k = colorKind(), cur = k === "hi" ? S.set.hiColor : S.set.penColor, rec = k === "hi" ? S.set.recentHi : S.set.recentPen;
  $("curColor").querySelector("span").style.background = cur;
  if ($("favW")) renderWidthUI();
  $("curColor").title = (k === "hi" ? "Kiemelő" : "Toll") + " színe – koppints a keverőhöz";
  const box = $("recent"); box.textContent = "";
  rec.slice(0, 3).forEach(c => { const b = document.createElement("button"); b.className = "swatch"; b.title = "Előző szín " + c; b.setAttribute("aria-label", "Előző szín " + c);
    const sp = document.createElement("span"); sp.style.background = c; b.append(sp);
    b.onclick = () => { rememberColor(k, c); if (S.tool !== "pen" && S.tool !== "hi") setTool("pen"); };
    box.append(b); });
}
$("curColor").onclick = () => { if (S.tool !== "pen" && S.tool !== "hi") setTool("pen"); openToolPop($("curColor")); };

function openToolPop(anchor) {
  closePops();
  const pop = $("toolPop"), t = S.tool, isEr = t === "er";
  $("popColorRow").hidden = isEr; $("popWidthRow").hidden = isEr; $("popEraseRow").hidden = !isEr; $("popEraseSize").hidden = !isEr;
  if (!isEr) {
    const k = t === "hi" ? "hi" : "pen";
    $("colorInput").value = k === "hi" ? S.set.hiColor : S.set.penColor;
    $("widthInput").value = k === "hi" ? S.set.hiW : S.set.penW; showWidth();
  } else { markErMode(); $("erSize").value = S.set.erR; $("erOut").textContent = mmTxt(S.set.erR * 2); }
  pop.hidden = false; renderWidthUI(); positionPop(pop, anchor);
}
const mmTxt = u => (u / MM).toFixed(u / MM < 1 ? 2 : 1).replace(".", ",") + " mm";
/* Vastagság: mm-ben is beírható, utolsó 3 megjegyezve, 1 kedvenc */
const wKind = () => S.tool === "hi" ? "hi" : "pen";
const mmOfW = (k, w) => k === "hi" ? w * 6 / MM : w * .95 / MM;
const wOfMm = (k, mm) => k === "hi" ? mm * MM / 6 : mm * MM / .95;
const fmtMm = v => v.toFixed(2).replace(/0$/, "").replace(".", ",") + " mm";
const sameW = (a, b) => a != null && b != null && Math.abs(a - b) < .01;
function curW(k) { return S.set[k === "hi" ? "hiW" : "penW"]; }
function setWidth(k, w) { S.set[k === "hi" ? "hiW" : "penW"] = Math.max(.2, Math.min(40, w)); saveSettings(); renderWidthUI(); }
function rememberWidth(k, w) {
  if (!S.set.recentW) S.set.recentW = { pen: [], hi: [] };
  const r = S.set.recentW[k] || []; if (sameW(r[0], w)) return;
  S.set.recentW[k] = [w, ...r.filter(x => !sameW(x, w))].slice(0, 3); saveSettings(); renderWidthUI();
}
function showWidth() { renderWidthUI(); }
function renderWidthUI() {
  const k = wKind(), w = curW(k), fav = (S.set.favW || {})[k];
  if (!$("toolPop").hidden && !$("popWidthRow").hidden) {
    $("widthInput").value = Math.min(+$("widthInput").max, w);
    if (document.activeElement !== $("widthMm")) $("widthMm").value = mmOfW(k, w).toFixed(2).replace(".", ",");
    const box = $("wChips"); box.textContent = "";
    const chip = (val, star) => { const b = document.createElement("button"); b.className = "tb small chip"; b.textContent = (star ? "★ " : "") + fmtMm(mmOfW(k, val));
      b.setAttribute("aria-pressed", String(sameW(val, w))); b.onclick = () => setWidth(k, val); box.append(b); };
    if (fav != null) chip(fav, true);
    ((S.set.recentW || {})[k] || []).filter(x => !sameW(x, fav)).slice(0, 3).forEach(v => chip(v, false));
    $("wFav").textContent = sameW(fav, w) ? "★ Ez a kedvenc" : "☆ Legyen kedvenc";
  }
  const fb = $("favW"), show = (S.tool === "pen" || S.tool === "hi") && fav != null;
  fb.hidden = !show;
  if (show) { fb.querySelector("span").textContent = fmtMm(mmOfW(k, fav)).replace(" mm", ""); fb.setAttribute("aria-pressed", String(sameW(fav, w)));
    fb.title = "Kedvenc vastagság: " + fmtMm(mmOfW(k, fav)); }
}
$("widthInput").addEventListener("input", () => setWidth(wKind(), +$("widthInput").value));
$("widthMm").addEventListener("change", () => { const v = parseFloat(String($("widthMm").value).replace(",", "."));
  if (!(v > 0)) { renderWidthUI(); return; } setWidth(wKind(), wOfMm(wKind(), v)); $("widthMm").value = mmOfW(wKind(), curW(wKind())).toFixed(2).replace(".", ","); });
$("wFav").onclick = () => { const k = wKind(); if (!S.set.favW) S.set.favW = { pen: null, hi: null };
  S.set.favW[k] = sameW(S.set.favW[k], curW(k)) ? null : curW(k); saveSettings(); renderWidthUI(); };
$("favW").onclick = () => { const k = wKind(), f = (S.set.favW || {})[k]; if (f != null) { setWidth(k, f); toast("Kedvenc vastagság: " + fmtMm(mmOfW(k, f))); } };
$("colorInput").addEventListener("change", () => { rememberColor(S.tool === "hi" ? "hi" : "pen", $("colorInput").value); });
function markErMode() { $("erStroke").setAttribute("aria-pressed", String(S.set.erMode === "stroke")); $("erPart").setAttribute("aria-pressed", String(S.set.erMode === "part")); }
$("erStroke").onclick = () => { S.set.erMode = "stroke"; markErMode(); saveSettings(); };
$("erPart").onclick = () => { S.set.erMode = "part"; markErMode(); saveSettings(); };
$("erSize").addEventListener("input", () => { S.set.erR = +$("erSize").value; $("erOut").textContent = mmTxt(S.set.erR * 2); saveSettings(); });

function positionPop(pop, anchor) {
  const r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  let left = S.set.rail === "right" && anchor.closest(".rail") ? r.left - pr.width - 10 : r.left;
  if (anchor.closest(".rail") && S.set.rail === "left") left = r.right + 10;
  if (!anchor.closest(".rail")) left = r.right - pr.width;
  left = Math.max(12, Math.min(left, vw - pr.width - 12));
  let top = anchor.closest(".rail") ? r.top : r.bottom + 6; top = Math.max(12, Math.min(top, vh - pr.height - 12));
  pop.style.left = left + "px"; pop.style.top = top + "px";
}
function closePops() { $("toolPop").hidden = true; $("morePop").hidden = true; }
document.addEventListener("pointerdown", e => {
  if (!e.target.closest(".pop") && !e.target.closest(".tool") && !e.target.closest("#curColor") && !e.target.closest("#bMore")) closePops();
}, true);

/* ================= Füzetek és lapok ================= */
async function openNotebook(id, pageId) {
  const nb = nbOf(id); if (!nb) return;
  S.nb = nb; S.set.lastNb = id; saveSettings();
  await loadNotebookPages(nb);
  if (!nb.pages.some(p => S.pages.has(p))) { const pg = newPage(nb); nb.pages.push(pg.id); S.pages.set(pg.id, pg); await persistPage(pg, true); nb.updated = Date.now(); saveNotebooks(); }
  const avail = nb.pages.filter(p => S.pages.has(p));
  const target = pageId && avail.includes(pageId) ? pageId : (S.set.lastPage[id] && avail.includes(S.set.lastPage[id]) ? S.set.lastPage[id] : avail[0]);
  $("nbName").innerHTML = ""; const dot = document.createElement("i"); dot.style.background = nb.color; const t = document.createElement("span"); t.textContent = nb.name;
  $("nbName").append(dot, t);
  renderNbList(); await openPage(target);
}
async function openPage(id) {
  const pg = await loadPage(id); if (!pg) return;
  if (S.page && S.page !== pg) persistPage(S.page, true);
  clearSel(); S.page = pg; S.set.lastPage[pg.nb] = id; saveSettings();
  await ensureBg(pg);
  const n = pageNoOf(pg), tot = S.nb.pages.length;
  $("pageNo").textContent = n; $("bPrev").disabled = n <= 1; $("bNext").disabled = n >= tot;
  drawPaper(); drawInk(); updUR(); renderPageList(); updateOpenBadge();
  $("desk").scrollTop = 0;
}
const go = d => { const i = S.nb.pages.indexOf(S.page.id) + d; if (i >= 0 && i < S.nb.pages.length) openPage(S.nb.pages[i]); };
$("bPrev").onclick = () => go(-1); $("bNext").onclick = () => go(1);
async function addPage(after, opts) {
  const nb = S.nb, pg = newPage(nb, opts);
  const i = after ? nb.pages.indexOf(S.page.id) + 1 : nb.pages.length;
  nb.pages.splice(i, 0, pg.id); nb.updated = Date.now();
  S.pages.set(pg.id, pg); await persistPage(pg, true); saveNotebooks();
  // az utána következő lapok száma változott: a Drive-on is frissüljenek
  for (const id of nb.pages.slice(i + 1)) { const p = S.pages.get(id); if (p) { p.updated = Date.now(); persistPage(p); } }
  Sync.schedule(8000);
  return pg;
}
$("bAddPage").onclick = async () => { const pg = await addPage(false); await openPage(pg.id); toast("Új lap: " + pageNoOf(pg) + "."); };
$("mInsert").onclick = async () => { closePops(); const pg = await addPage(true); await openPage(pg.id); toast("Beszúrva: " + pageNoOf(pg) + ". lap"); };
$("mDelPage").onclick = () => { closePops(); const pg = S.page, n = pageNoOf(pg);
  dialog("Lap törlése", `<p>A(z) ${n}. lap minden tartalma törlődik, a Drive-ról is. Ez nem vonható vissza.</p>`,
    [["Mégse"], ["Törlés", "dan", async () => {
      const nb = S.nb, i = nb.pages.indexOf(pg.id); nb.pages.splice(i, 1); nb.updated = Date.now();
      S.deleted.pages[pg.id] = Date.now(); saveDeleted(); S.pages.delete(pg.id); await DB.del("pages", pg.id); saveNotebooks();
      for (const id of nb.pages.slice(i)) { const p = S.pages.get(id); if (p) { p.updated = Date.now(); persistPage(p); } }
      if (!nb.pages.length) { const np = newPage(nb); nb.pages.push(np.id); S.pages.set(np.id, np); await persistPage(np, true); saveNotebooks(); }
      await openPage(nb.pages[Math.max(0, i - 1)]); toast("Lap törölve"); Sync.schedule(3000);
    }]]); };

function renderNbList() {
  const ul = $("nbList"); ul.textContent = "";
  for (const nb of S.notebooks) {
    const li = document.createElement("li"), b = document.createElement("button"); b.className = "it tb";
    b.setAttribute("aria-current", String(S.nb && nb.id === S.nb.id));
    const d = document.createElement("i"); d.className = "dot"; d.style.background = nb.color;
    const t = document.createElement("span"); t.className = "t"; t.textContent = nb.name;
    const n = document.createElement("span"); n.className = "sub"; n.textContent = nb.pages.length + " lap";
    b.append(d, t, n); b.onclick = () => { openNotebook(nb.id); if (innerWidth <= 720) $("drawer").hidden = true; };
    const e = document.createElement("button"); e.className = "ib"; e.title = "Füzet szerkesztése"; e.setAttribute("aria-label", "Füzet szerkesztése: " + nb.name);
    e.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>'; e.onclick = () => notebookDialog(nb);
    li.append(b, e); ul.append(li);
  }
}
function openCountOf(pg) { return pg.marks.filter(m => !m.done).length; }
function renderPageList() {
  const ul = $("pgList"); if (!S.nb) return; ul.textContent = "";
  S.nb.pages.forEach((id, i) => {
    const pg = S.pages.get(id); if (!pg) return;
    const li = document.createElement("li"), b = document.createElement("button"); b.className = "it tb";
    b.setAttribute("aria-current", String(S.page && S.page.id === id));
    const no = document.createElement("span"); no.className = "sub"; no.textContent = String(i + 1).padStart(2, "0");
    const t = document.createElement("span"); t.className = "t"; t.textContent = fmtDate(pg.created) + (pg.bg ? " · import" : "");
    b.append(no, t);
    const oc = openCountOf(pg); if (oc) { const bd = document.createElement("b"); bd.className = "badge"; bd.textContent = oc; b.append(bd); }
    b.onclick = () => { openPage(id); if (innerWidth <= 720) $("drawer").hidden = true; };
    li.append(b); ul.append(li);
  });
}
function updateOpenBadge() {
  if (!S.nb) return; let n = 0;
  for (const id of S.nb.pages) { const pg = S.pages.get(id); if (pg) n += openCountOf(pg); }
  const b = $("openCount"); b.textContent = n; b.hidden = !n;
}
$("bNav").onclick = () => { $("drawer").hidden = !$("drawer").hidden; layout(); };
$("bNewNb").onclick = () => notebookDialog(null);

function notebookDialog(nb) {
  const isNew = !nb; let color = nb ? nb.color : NB_COLORS[S.notebooks.length % NB_COLORS.length];
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `<label for="nbIn">Füzet (projekt) neve</label><input type="text" id="nbIn" maxlength="60" placeholder="pl. Givaudan – hőszivattyú">
    <span>Szín</span><div class="colors" id="nbCols"></div>
    <label for="nbPaper">Új lapok alapja</label><select id="nbPaper">${paperOpts(nb ? nb.paper : "grid")}</select>`;
  const inp = body.querySelector("#nbIn"); inp.value = nb ? nb.name : "";
  const cols = body.querySelector("#nbCols");
  NB_COLORS.forEach(c => { const b = document.createElement("button"); b.style.background = c; b.setAttribute("aria-label", "Szín " + c); b.setAttribute("aria-pressed", String(c === color));
    b.onclick = () => { color = c; cols.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); }; cols.append(b); });
  const btns = [["Mégse"]];
  if (!isNew) btns.push(["Füzet törlése", "dan", () => setTimeout(() => deleteNotebookDialog(nb), 0)]);
  btns.push([isNew ? "Létrehozás" : "Mentés", "pri", async () => {
    const name = inp.value.trim() || "Névtelen füzet", paper = body.querySelector("#nbPaper").value;
    if (isNew) { const n = newNotebook(name, color, paper); S.notebooks.push(n); saveNotebooks(); await openNotebook(n.id); }
    else { nb.name = name; nb.color = color; nb.paper = paper; nb.updated = Date.now(); saveNotebooks(); if (S.nb === nb) await openNotebook(nb.id, S.page.id); else renderNbList();
      for (const id of nb.pages) { const p = S.pages.get(id) || await loadPage(id); if (p) { p.updated = Date.now(); persistPage(p); } } }
    Sync.schedule(3000);
  }]);
  dialog(isNew ? "Új füzet" : "Füzet szerkesztése", body, btns); setTimeout(() => inp.focus(), 50);
}
function deleteNotebookDialog(nb) {
  dialog("Füzet törlése", `<p>„${esc(nb.name)}” és mind a ${nb.pages.length} lapja törlődik, a Drive-ról is. Ez nem vonható vissza.</p>`,
    [["Mégse"], ["Végleges törlés", "dan", async () => {
      const now = Date.now();
      for (const id of nb.pages) { S.deleted.pages[id] = now; S.pages.delete(id); await DB.del("pages", id); }
      S.deleted.notebooks[nb.id] = now; saveDeleted();
      S.notebooks = S.notebooks.filter(n => n !== nb);
      if (!S.notebooks.length) S.notebooks.push(newNotebook("Jegyzetek", NB_COLORS[0], "grid"));
      saveNotebooks(); await openNotebook(S.notebooks[0].id); toast("Füzet törölve"); Sync.schedule(3000);
    }]]);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PAPERS = [["grid", "Kockás 5 mm"], ["mm", "Milliméterpapír"], ["lined", "Vonalas"], ["dots", "Pontrács"], ["blank", "Üres"]];
const paperOpts = sel => PAPERS.map(([v, n]) => `<option value="${v}"${v === sel ? " selected" : ""}>${n}</option>`).join("");
$("mPaper").onclick = () => { closePops(); const pg = S.page;
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `<label for="pp">Ennek a lapnak az alapja</label><select id="pp">${paperOpts(pg.paper)}</select>
    <label><input type="checkbox" id="ppDef"> Legyen a füzet új lapjainak alapja is</label>`;
  dialog("Lap alapja", body, [["Mégse"], ["Alkalmaz", "pri", () => {
    pg.paper = body.querySelector("#pp").value; drawPaper(); touchPage(pg);
    if (body.querySelector("#ppDef").checked) { S.nb.paper = pg.paper; S.nb.updated = Date.now(); saveNotebooks(); }
  }]]); };

/* ================= Feladatok és kérdések ================= */
let tkKind = "box", tkScope = "this";
function markSeg() { $("tkTasks").setAttribute("aria-pressed", String(tkKind === "box")); $("tkQs").setAttribute("aria-pressed", String(tkKind === "q"));
  $("tkThis").setAttribute("aria-pressed", String(tkScope === "this")); $("tkAll").setAttribute("aria-pressed", String(tkScope === "all")); }
$("bTasks").onclick = () => { $("taskPanel").hidden = false; markSeg(); renderTasks(); };
$("tkClose").onclick = () => { $("taskPanel").hidden = true; };
$("taskPanel").addEventListener("click", e => { if (e.target === $("taskPanel")) $("taskPanel").hidden = true; });
$("tkTasks").onclick = () => { tkKind = "box"; markSeg(); renderTasks(); }; $("tkQs").onclick = () => { tkKind = "q"; markSeg(); renderTasks(); };
$("tkThis").onclick = () => { tkScope = "this"; markSeg(); renderTasks(); }; $("tkAll").onclick = () => { tkScope = "all"; markSeg(); renderTasks(); };
function itemRegion(pg, m) {
  if (m.k === "box") { const st = strikeFor({ ...pg, marks: [] }, m); const x1 = Math.min(W, st ? st[2] + 4 * MM : m.x + 120 * MM);
    return [Math.max(0, m.x - 3 * MM), Math.max(0, m.y - 4 * MM), x1, Math.min(H, m.y + BOX + 4 * MM)]; }
  const cand = pg.strokes.filter(s => s.t === "p" && s.bb[0] > m.x && Math.abs((s.bb[1] + s.bb[3]) / 2 - m.y) < QR * 2.4).sort((a, b) => a.bb[0] - b.bb[0]);
  let right = m.x + QR; for (const s of cand) { if (s.bb[0] - right > 22 * MM) break; right = Math.max(right, s.bb[2]); }
  const L = qLayout(m);
  if (L) return [Math.max(0, Math.min(m.x - QR, L.x) - 3 * MM), Math.max(0, Math.min(m.y - QR, L.y) - 3 * MM), Math.min(W, Math.max(m.x + QR, L.x + L.w) + 3 * MM), Math.min(H, Math.max(m.y + QR, L.y + L.h) + 3 * MM)];
  return [Math.max(0, m.x - QR - 3 * MM), Math.max(0, m.y - QR - 4 * MM), Math.min(W, Math.max(right + 4 * MM, m.x + 60 * MM)), Math.min(H, m.y + QR + 4 * MM)];
}
function cropCanvas(pg, r, cssW) {
  const [a, b, c, d] = r, wu = c - a, hu = d - b, dpr = Math.min(2, devicePixelRatio || 1);
  const cv = document.createElement("canvas"), k = cssW / wu; cv.width = Math.round(cssW * dpr); cv.height = Math.round(hu * k * dpr);
  const x = cv.getContext("2d"); x.fillStyle = "#fdfdfb"; x.fillRect(0, 0, cv.width, cv.height);
  x.setTransform(k * dpr, 0, 0, k * dpr, -a * k * dpr, -b * k * dpr); paintInk(x, pg); return cv;
}
async function renderTasks() {
  const ul = $("tkList"); ul.textContent = "";
  const nbs = tkScope === "this" ? [S.nb] : S.notebooks;
  let count = 0;
  for (const nb of nbs) {
    await loadNotebookPages(nb);
    nb.pages.forEach((id, i) => {
      const pg = S.pages.get(id); if (!pg) return;
      pg.marks.filter(m => m.k === tkKind && !m.done).sort((a, b) => a.y - b.y).forEach(m => {
        count++;
        const li = document.createElement("li"), b = document.createElement("button");
        const cv = cropCanvas(pg, itemRegion(pg, m), Math.min(520, innerWidth - 120));
        const meta = document.createElement("span"); meta.className = "meta";
        meta.textContent = (tkScope === "all" ? nb.name + " · " : "") + (i + 1) + ". lap · " + fmtDate(m.ts);
        b.append(cv, meta);
        b.onclick = async () => { $("taskPanel").hidden = true; if (S.nb !== nb) await openNotebook(nb.id, id); else await openPage(id); flashAt(m); };
        li.append(b); ul.append(li);
      });
    });
  }
  if (!count) { const li = document.createElement("li"); li.className = "empty"; li.textContent = tkKind === "box" ? "Nincs nyitott feladat." : "Nincs nyitott kérdés."; ul.append(li); }
}
function flashAt(m) {
  const y = (m.k === "box" ? m.y : m.y - QR) * SC; $("desk").scrollTop = Math.max(0, y - 120);
  xL.clearRect(0, 0, W, H); xL.save(); xL.strokeStyle = "#c25a00"; xL.lineWidth = 3;
  const r = m.k === "box" ? [m.x - 3 * MM, m.y - 3 * MM, BOX + 6 * MM, BOX + 6 * MM] : [m.x - QR - 3 * MM, m.y - QR - 3 * MM, 2 * QR + 6 * MM, 2 * QR + 6 * MM];
  xL.strokeRect(...r); xL.restore(); setTimeout(() => { if (!act) xL.clearRect(0, 0, W, H); }, 1600);
}

/* ================= Import / export ================= */
const loaded = {};
function loadScript(src) {
  if (loaded[src]) return loaded[src];
  loaded[src] = new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.async = true;
    s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error("Nem tölthető be: " + src)); }; document.head.append(s); });
  return loaded[src];
}
$("mImport").onclick = () => { closePops(); $("fileIn").click(); };
$("fileIn").addEventListener("change", async () => {
  const files = [...$("fileIn").files]; $("fileIn").value = ""; if (!files.length) return;
  let made = 0, first = null;
  try {
    for (const f of files) {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        busy("PDF betöltése…"); await loadScript(PDFJS);
        const pdfjsLib = window.pdfjsLib; pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        const doc = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
        for (let i = 1; i <= doc.numPages; i++) {
          busy(`PDF: ${i}. / ${doc.numPages} oldal…`);
          const p = await doc.getPage(i), v1 = p.getViewport({ scale: 1 }), sc = Math.min(1800 / v1.width, 2600 / v1.height);
          const vp = p.getViewport({ scale: sc }), c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
          const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
          await p.render({ canvasContext: cx, viewport: vp }).promise;
          const blob = await new Promise(r => c.toBlob(r, "image/jpeg", .86));
          const pg = await importBg(blob, c.width, c.height); first = first || pg; made++;
        }
      } else if (/^image\/(png|jpeg)$/.test(f.type) || /\.(png|jpe?g)$/i.test(f.name)) {
        busy("Kép betöltése…");
        const bmp = await createImageBitmap(f); let w = bmp.width, h = bmp.height, blob = f;
        if (w > 2400 || h > 3400 || f.type === "image/png" && f.size > 3e6) {
          const k = Math.min(2400 / w, 3400 / h, 1); const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
          const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(bmp, 0, 0, c.width, c.height);
          blob = await new Promise(r => c.toBlob(r, "image/jpeg", .88)); w = c.width; h = c.height;
        }
        const pg = await importBg(blob, w, h); first = first || pg; made++;
      } else toast("Nem támogatott fájl: " + f.name);
    }
  } catch (e) { console.error(e); unbusy(); toast(navigator.onLine ? "Az importálás nem sikerült: " + e.message : "A PDF-import első használatához internet kell."); return; }
  unbusy(); if (first) { await openPage(first.id); toast(made + " lap importálva"); }
});
async function importBg(blob, w, h) {
  const bgId = uid(); await DB.put("blobs", blob, bgId);
  const pg = await addPage(true, { bg: { id: bgId, w, h, type: blob.type || "image/jpeg" }, paper: "blank" });
  S.page = pg; // a következő import ez után kerüljön
  return pg;
}
async function exportPdf(pageIds, name) {
  try {
    busy("PDF készítése…"); await loadScript(JSPDF);
    const { jsPDF } = window.jspdf; const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    for (let i = 0; i < pageIds.length; i++) {
      busy(`PDF: ${i + 1}. / ${pageIds.length} lap…`);
      const pg = await loadPage(pageIds[i]); const c = await renderPageCanvas(pg, 1654); // ≈ 200 dpi
      if (i) doc.addPage("a4", "portrait");
      doc.addImage(c.toDataURL("image/jpeg", .86), "JPEG", 0, 0, 210, 297, undefined, "FAST");
    }
    const blob = doc.output("blob"); unbusy();
    const file = new File([blob], name, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      dialog("PDF elkészült", `<p>${esc(name)} – ${(blob.size / 1048576).toFixed(1).replace(".", ",")} MB</p>`,
        [["Mentés a Letöltésekbe", "", () => downloadBlob(blob, name)], ["Megosztás…", "pri", () => navigator.share({ files: [file], title: name }).catch(() => {})]]);
    } else downloadBlob(blob, name);
  } catch (e) { console.error(e); unbusy(); toast(navigator.onLine ? "A PDF-export nem sikerült: " + e.message : "A PDF-export első használatához internet kell."); }
}
function downloadBlob(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast("Mentve: " + name); }
const safeName = s => s.replace(/[\\/:*?"<>|]+/g, "_").trim();
$("mExportNb").onclick = () => { closePops(); exportPdf(S.nb.pages.slice(), safeName(S.nb.name) + " – " + new Date().toISOString().slice(0, 10) + ".pdf"); };
$("mExportPg").onclick = () => { closePops(); exportPdf([S.page.id], safeName(S.nb.name) + " – " + pageNoOf(S.page) + ". lap.pdf"); };

/* ================= Google Drive szinkron ================= */
const Sync = {
  token: null, exp: 0, timer: 0, running: false, needAuth: false, ids: null, lastOk: 0, err: "",
  async init() {
    this.ids = (await DB.get("kv", "drive")) || { root: null, lapok: null, index: null, open: null, summary: null, files: {}, bgs: {}, pushed: {} };
    try { const t = JSON.parse(localStorage.getItem("jf_tok") || "null"); if (t && t.exp > Date.now() + 60000) { this.token = t.tok; this.exp = t.exp; } } catch (e) {}
    this.status();
    addEventListener("online", () => this.schedule(1000));
    addEventListener("offline", () => this.status());
    setInterval(() => this.schedule(0), 180000);
    document.addEventListener("visibilitychange", () => { if (document.hidden) { if (S.page) persistPage(S.page, true); if (this.token) this.run(); } });
    if (S.set.driveOn && S.set.clientId) { this.gis().catch(() => {}); this.schedule(1500); }
  },
  saveIds() { return DB.put("kv", this.ids, "drive"); },
  status(text) {
    const el = $("sync"); el.classList.remove("warn");
    if (!S.set.driveOn || !S.set.clientId) { el.textContent = "Csak helyben"; el.title = "Google Drive szinkron nincs beállítva – Beállítások"; return; }
    if (text) { el.textContent = text; return; }
    if (!navigator.onLine) { el.textContent = "Offline · helyben mentve"; return; }
    if (this.needAuth) { el.textContent = "Drive: koppints a bejelentkezéshez"; el.classList.add("warn"); return; }
    if (this.err) { el.textContent = "Szinkron hiba"; el.title = this.err; el.classList.add("warn"); return; }
    el.textContent = this.lastOk ? "Drive ✓ " + fmtTime(this.lastOk) : "Drive"; el.title = "Szinkron állapota";
  },
  schedule(ms) { if (!S.set.driveOn || !S.set.clientId) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms); },
  async gis() { if (!(window.google && google.accounts && google.accounts.oauth2)) await loadScript("https://accounts.google.com/gsi/client"); },
  async auth(interactive) {
    if (this.token && Date.now() < this.exp - 60000) return this.token;
    await this.gis();
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: S.set.clientId, scope: "https://www.googleapis.com/auth/drive.file",
        callback: r => { if (r.error) return rej(new Error(r.error)); this.token = r.access_token; this.exp = Date.now() + (r.expires_in || 3600) * 1000;
          try { localStorage.setItem("jf_tok", JSON.stringify({ tok: this.token, exp: this.exp })); } catch (e) {} this.needAuth = false; res(this.token); },
        error_callback: e => rej(new Error(e && e.type || "auth")),
      });
      tc.requestAccessToken({ prompt: interactive ? "consent" : "" });
    });
  },
  async api(method, path, body, headers = {}, raw) {
    const url = path.startsWith("http") ? path : "https://www.googleapis.com/drive/v3/" + path;
    const r = await fetch(url, { method, headers: { Authorization: "Bearer " + this.token, ...headers }, body });
    if (r.status === 401) { this.token = null; localStorage.removeItem("jf_tok"); throw Object.assign(new Error("Lejárt bejelentkezés"), { auth: true }); }
    if (!r.ok) { const t = await r.text(); throw Object.assign(new Error("Drive " + r.status + ": " + t.slice(0, 160)), { status: r.status }); }
    return raw ? r : (r.status === 204 ? null : r.json());
  },
  async find(name, parent, folder) {
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parent}' in parents and trashed=false` + (folder ? " and mimeType='application/vnd.google-apps.folder'" : "");
    const r = await this.api("GET", "files?fields=files(id,name,modifiedTime)&spaces=drive&q=" + encodeURIComponent(q));
    return r.files[0] || null;
  },
  async folder(name, parent) {
    const f = await this.find(name, parent, true); if (f) return f.id;
    const r = await this.api("POST", "files?fields=id", JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parent] }), { "Content-Type": "application/json" });
    return r.id;
  },
  async upload(id, name, mime, data, parent, props) {
    const meta = id ? { name } : { name, parents: [parent], appProperties: props || {} };
    const bnd = "jf" + Math.random().toString(36).slice(2);
    const body = new Blob([`--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${bnd}\r\nContent-Type: ${mime}\r\n\r\n`, data, `\r\n--${bnd}--`]);
    const url = "https://www.googleapis.com/upload/drive/v3/files" + (id ? "/" + id : "") + "?uploadType=multipart&fields=id";
    try { return (await this.api(id ? "PATCH" : "POST", url, body, { "Content-Type": "multipart/related; boundary=" + bnd })).id; }
    catch (e) { if (id && e.status === 404) return this.upload(null, name, mime, data, parent, props); throw e; }
  },
  async download(id, asBlob) { const r = await this.api("GET", "files/" + id + "?alt=media", undefined, {}, true); return asBlob ? r.blob() : r.text(); },
  async trash(id) { try { await this.api("PATCH", "files/" + id, JSON.stringify({ trashed: true }), { "Content-Type": "application/json" }); } catch (e) { if (e.status !== 404) throw e; } },
  async ensureFolders() {
    if (this.ids.root) { try { const f = await this.api("GET", "files/" + this.ids.root + "?fields=id,trashed"); if (f.trashed) this.ids.root = null; } catch (e) { if (e.status === 404) this.ids.root = null; else throw e; } }
    if (!this.ids.root) { this.ids = { root: null, lapok: null, index: null, open: null, summary: null, files: {}, bgs: {}, pushed: {} };
      this.ids.root = await this.folder("Tervezői jegyzetfüzet", "root"); }
    if (!this.ids.lapok) this.ids.lapok = await this.folder("Lapok", this.ids.root);
    await this.saveIds();
  },
  async run(interactive) {
    if (!S.set.driveOn || !S.set.clientId || this.running) return;
    if (!navigator.onLine) { this.status(); return; }
    this.running = true; this.status("Szinkron…");
    try {
      try { await this.auth(!!interactive && !this.token); }
      catch (e) { this.needAuth = true; this.running = false; this.status(); return; }
      await this.ensureFolders();
      // 1) távoli index letöltése és összefésülése
      let remote = null;
      if (!this.ids.index) { const f = await this.find("index.json", this.ids.root); if (f) this.ids.index = f.id; }
      if (this.ids.index) { try { remote = JSON.parse(await this.download(this.ids.index)); } catch (e) { if (e.status === 404) this.ids.index = null; else if (e.auth) throw e; } }
      if (remote) await this.merge(remote);
      // 2) helyi változások feltöltése
      await this.push();
      // 3) index és nyitott tételek írása
      const idx = this.buildIndex();
      this.ids.index = await this.upload(this.ids.index, "index.json", "application/json", JSON.stringify(idx), this.ids.root, { jf: "index" });
      const open = this.buildOpen();
      if (!this.ids.open) { const f = await this.find("nyitott.json", this.ids.root); if (f) this.ids.open = f.id; }
      this.ids.open = await this.upload(this.ids.open, "nyitott.json", "application/json", JSON.stringify(open, null, 1), this.ids.root, { jf: "open" });
      await this.saveIds();
      this.err = ""; this.lastOk = Date.now();
    } catch (e) {
      console.error(e);
      if (e.auth) this.needAuth = true; else this.err = e.message;
    }
    this.running = false; this.status();
  },
  async merge(remote) {
    const del = remote.deleted || { pages: {}, notebooks: {} };
    for (const [id, ts] of Object.entries(del.pages || {})) if (!S.deleted.pages[id]) {
      S.deleted.pages[id] = ts; const pg = S.pages.get(id) || await loadPage(id);
      if (pg && pg.updated <= ts) { S.pages.delete(id); await DB.del("pages", id); for (const nb of S.notebooks) nb.pages = nb.pages.filter(x => x !== id); }
    }
    for (const [id, ts] of Object.entries(del.notebooks || {})) if (!S.deleted.notebooks[id]) {
      S.deleted.notebooks[id] = ts; const nb = nbOf(id); if (nb && nb.updated <= ts) S.notebooks = S.notebooks.filter(n => n.id !== id);
    }
    let changedCur = false;
    if ((remote.notebooks || []).length) {
      const remoteIds = new Set(remote.notebooks.map(n => n.id));
      S.notebooks = S.notebooks.filter(nb => { if (remoteIds.has(nb.id) || nb.name !== "Jegyzetek" || nb.pages.length !== 1) return true;
        const pg = S.pages.get(nb.pages[0]); const empty = pg && !pg.strokes.length && !pg.marks.length && !pg.bg;
        if (empty) { S.pages.delete(pg.id); DB.del("pages", pg.id); } return !empty; });
    }
    for (const rn of remote.notebooks || []) {
      if (S.deleted.notebooks[rn.id]) continue;
      const ln = nbOf(rn.id);
      if (!ln) S.notebooks.push({ ...rn, pages: rn.pages.filter(p => !S.deleted.pages[p]) });
      else if (rn.updated > ln.updated) { Object.assign(ln, rn, { pages: rn.pages.filter(p => !S.deleted.pages[p]) }); if (S.nb === ln) changedCur = true; }
    }
    for (const [id, rp] of Object.entries(remote.pages || {})) {
      if (S.deleted.pages[id]) continue;
      const lp = S.pages.get(id) || await loadPage(id);
      if (lp && lp.updated >= rp.updated) continue;
      if (!rp.json) continue;
      const o = JSON.parse(await this.download(rp.json));
      if (o.bg && !(await DB.get("blobs", o.bg.id)) && rp.bgFile) { try { await DB.put("blobs", await this.download(rp.bgFile, true), o.bg.id); this.ids.bgs[o.bg.id] = rp.bgFile; } catch (e) { console.error(e); } }
      const pg = deserializePage(o); S.pages.set(id, pg); await DB.put("pages", serializePage(pg));
      this.ids.files[id] = { json: rp.json, img: rp.img }; this.ids.pushed[id] = pg.updated;
      if (S.page && S.page.id === id) changedCur = true;
    }
    // ha egy lap távol létezik, de egyik füzet sem hivatkozik rá, a helyi füzetlisták a mérvadók
    saveDeleted(); saveNotebooks();
    if (!S.notebooks.length) { S.notebooks.push(newNotebook("Jegyzetek", NB_COLORS[0], "grid")); saveNotebooks(); }
    if (!nbOf(S.nb && S.nb.id)) await openNotebook(S.notebooks[0].id);
    else if (changedCur || !S.nb.pages.includes(S.page && S.page.id)) await openNotebook(S.nb.id, S.page && S.page.id);
    else { renderNbList(); renderPageList(); updateOpenBadge(); }
  },
  async push() {
    for (const nb of S.notebooks) {
      for (const id of nb.pages) {
        const pg = S.pages.get(id) || await loadPage(id); if (!pg) continue;
        if ((this.ids.pushed[id] || 0) >= pg.updated && this.ids.files[id]) continue;
        const n = nb.pages.indexOf(id) + 1, base = `${safeName(nb.name)} – ${String(n).padStart(3, "0")}`;
        if (pg.bg && !this.ids.bgs[pg.bg.id]) { const blob = await DB.get("blobs", pg.bg.id);
          if (blob) this.ids.bgs[pg.bg.id] = await this.upload(null, "hatter-" + pg.bg.id + (pg.bg.type === "image/png" ? ".png" : ".jpg"), pg.bg.type || "image/jpeg", blob, this.ids.lapok, { jf: "bg", bgId: pg.bg.id }); }
        const f = this.ids.files[id] || {};
        const data = { ...serializePage(pg), notebookName: nb.name, pageNo: n };
        f.json = await this.upload(f.json, base + ".json", "application/json", JSON.stringify(data), this.ids.lapok, { jf: "page", pageId: id });
        const c = await renderPageCanvas(pg, 1240); const img = await new Promise(r => c.toBlob(r, "image/jpeg", .82));
        f.img = await this.upload(f.img, base + ".jpg", "image/jpeg", img, this.ids.lapok, { jf: "pageimg", pageId: id });
        this.ids.files[id] = f; this.ids.pushed[id] = pg.updated; await this.saveIds();
      }
    }
    for (const id of Object.keys(S.deleted.pages)) { const f = this.ids.files[id]; if (f) { if (f.json) await this.trash(f.json); if (f.img) await this.trash(f.img); delete this.ids.files[id]; delete this.ids.pushed[id]; } }
  },
  buildIndex() {
    const pages = {};
    for (const nb of S.notebooks) nb.pages.forEach((id, i) => { const pg = S.pages.get(id), f = this.ids.files[id] || {};
      if (!pg) return;
      const lastInk = Math.max(pg.created, ...pg.strokes.map(s => s.mt || s.ts || 0), ...pg.marks.map(m => Math.max(m.ts || 0, m.dt || 0)));
      pages[id] = { nb: nb.id, notebookName: nb.name, pageNo: i + 1, created: pg.created, updated: pg.updated, lastInk, json: f.json, img: f.img, bgFile: pg.bg ? this.ids.bgs[pg.bg.id] : undefined }; });
    return { v: 1, app: "Tervezői jegyzetfüzet " + APP_VERSION, updated: Date.now(), timezone: "Europe/Budapest",
      notebooks: S.notebooks.map(n => ({ id: n.id, name: n.name, color: n.color, paper: n.paper, created: n.created, updated: n.updated, pages: n.pages })),
      pages, deleted: S.deleted };
  },
  buildOpen() {
    const items = [];
    for (const nb of S.notebooks) nb.pages.forEach((id, i) => { const pg = S.pages.get(id); if (!pg) return; const f = this.ids.files[id] || {};
      for (const m of pg.marks) if (!m.done) { const r = itemRegion(pg, m);
        items.push({ tipus: m.k === "box" ? "feladat" : "kérdés", szoveg: m.text || null, fuzet: nb.name, lapszam: i + 1, letrehozva: new Date(m.ts).toISOString(),
          kepFajlId: f.img, kivagas_szazalek: { x0: +(r[0] / W * 100).toFixed(1), y0: +(r[1] / H * 100).toFixed(1), x1: +(r[2] / W * 100).toFixed(1), y1: +(r[3] / H * 100).toFixed(1) } }); } });
    return { leiras: "Nyitott feladatok és kérdések. Ha van szoveg, az a begépelt kérdés; egyébként a kézírás a lap képén (kepFajlId) a kivagas_szazalek téglalapban olvasható.", frissitve: new Date().toISOString(), tetelek: items };
  },
};
/* A Google-token óránként lejár; a frissítéshez felhasználói koppintás kell (felugró ablak), ezért eszköztár-koppintáskor frissítünk */
let authing = false;
document.addEventListener("click", e => {
  if (!S.set.driveOn || !S.set.clientId || !navigator.onLine || authing) return;
  if (!e.target.closest(".top, .rail, .drawer")) return;
  if (Sync.token && Sync.exp - Date.now() > 5 * 60000) return;
  authing = true;
  Sync.auth(false).then(() => { Sync.needAuth = false; Sync.schedule(500); }).catch(() => { Sync.needAuth = true; Sync.status(); }).finally(() => { authing = false; });
}, true);
$("sync").onclick = () => { if (!S.set.driveOn || !S.set.clientId) settingsDialog(); else Sync.run(true); };
$("mSummary").onclick = () => {
  closePops();
  if (!S.set.driveOn || !S.set.clientId || !Sync.ids || !Sync.ids.root) {
    dialog("Napi összefoglalók", "<p>Az összefoglalók a Google Drive „Tervezői jegyzetfüzet / Napi összefoglalók” mappájába érkeznek. Ehhez előbb kapcsold be a szinkront a Beállításokban.</p>", [["Rendben", "pri"]]); return;
  }
  // Az összefoglalókat az ütemezett feladat hozza létre, az app ezeket nem látja (drive.file), ezért a Drive-mappát nyitjuk meg
  const url = "https://drive.google.com/drive/folders/" + Sync.ids.root;
  const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.append(a); a.click(); a.remove();
};

/* ================= Beállítások ================= */
function settingsDialog() {
  closePops(); Sync.gis().catch(() => {});
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `
    <strong>Eszköztár helye</strong>
    <div class="seg"><button class="tb small" id="stR">Jobb oldalt (balkezes)</button><button class="tb small" id="stL">Bal oldalt</button></div>
    <strong>Google Drive szinkron</strong>
    <p>A lapok a Drive „Tervezői jegyzetfüzet” mappájába kerülnek. Ebből készül a napi összefoglaló, és így a lapok más eszközön is elérhetők.</p>
    <label for="cid">OAuth kliensazonosító (Client ID)</label>
    <input type="text" id="cid" placeholder="….apps.googleusercontent.com" autocomplete="off" spellcheck="false">
    <p>Engedélyezett JavaScript-forrásnak ezt add meg a Google Cloudban: <code>${esc(location.origin)}</code></p>
    <div class="seg"><button class="btn pri" id="dOn"></button><button class="btn" id="dNow">Szinkronizálás most</button></div>
    <p id="dState"></p>
    <strong>S Pen gomb teszt</strong>
    <p>Bekapcsolva a képernyő alján kiírja, mit jelez a toll. Írj a lapra lenyomott oldalsó gombbal, és küldd el a kiírt sort.</p>
    <div class="seg"><button class="tb small" id="dbgBtn"></button></div>
    <p style="font-size:12px">Verzió: ${APP_VERSION}</p>`;
  const cid = body.querySelector("#cid"); cid.value = S.set.clientId || "";
  const markRail = () => { body.querySelector("#stR").setAttribute("aria-pressed", String(S.set.rail === "right")); body.querySelector("#stL").setAttribute("aria-pressed", String(S.set.rail === "left")); };
  body.querySelector("#stR").onclick = () => { S.set.rail = "right"; applyRail(); markRail(); saveSettings(); };
  body.querySelector("#stL").onclick = () => { S.set.rail = "left"; applyRail(); markRail(); saveSettings(); };
  const dOn = body.querySelector("#dOn"), st = body.querySelector("#dState");
  const markDrive = () => { dOn.textContent = S.set.driveOn ? "Szinkron kikapcsolása" : "Bejelentkezés és bekapcsolás";
    st.textContent = S.set.driveOn ? (Sync.lastOk ? "Bekapcsolva · utolsó szinkron: " + fmtTime(Sync.lastOk) : "Bekapcsolva") : "Kikapcsolva – a lapok csak ezen az eszközön vannak."; };
  dOn.onclick = async () => {
    if (S.set.driveOn) { S.set.driveOn = false; Sync.token = null; localStorage.removeItem("jf_tok"); saveSettings(); markDrive(); Sync.status(); return; }
    const v = cid.value.trim(); if (!/\.apps\.googleusercontent\.com$/.test(v)) { st.textContent = "Ez nem tűnik kliensazonosítónak (….apps.googleusercontent.com)."; return; }
    S.set.clientId = v; saveSettings();
    try { st.textContent = "Bejelentkezés…"; Sync.token = null; await Sync.auth(true); S.set.driveOn = true; saveSettings(); markDrive(); Sync.run(); }
    catch (e) { st.textContent = "A bejelentkezés nem sikerült: " + e.message; }
  };
  body.querySelector("#dNow").onclick = () => { Sync.run(true); st.textContent = "Szinkron elindítva…"; };
  const dbgBtn = body.querySelector("#dbgBtn");
  const markDbg = () => { dbgBtn.textContent = penDbg ? "Tolladatok kijelzése: BE" : "Tolladatok kijelzése: KI"; dbgBtn.setAttribute("aria-pressed", String(penDbg)); };
  dbgBtn.onclick = () => { penDbg = !penDbg; if (!penDbg) $("penDbg").hidden = true; markDbg(); };
  markRail(); markDrive(); markDbg();
  dialog("Beállítások és szinkron", body, [["Kész", "pri"]]);
}
$("mSettings").onclick = settingsDialog;
function applyRail() { document.body.classList.toggle("rail-left", S.set.rail === "left"); requestAnimationFrame(layout); }
$("bMore").onclick = () => { const p = $("morePop"); if (!p.hidden) { closePops(); return; } closePops(); p.hidden = false; positionPop(p, $("bMore")); };

/* ================= Párbeszéd, értesítés ================= */
function dialog(title, body, buttons) {
  $("dlgTitle").textContent = title; const b = $("dlgBody"); b.textContent = "";
  if (typeof body === "string") b.innerHTML = body; else b.append(body);
  const row = $("dlgBtns"); row.textContent = "";
  for (const [label, kind, fn] of buttons) { const btn = document.createElement("button"); btn.className = "btn" + (kind === "pri" ? " pri" : kind === "dan" ? " dan" : ""); btn.textContent = label;
    btn.onclick = () => { $("dlg").hidden = true; if (fn) fn(); }; row.append(btn); }
  $("dlg").hidden = false;
}
function pickColorDialog(title, cur, kind, fn) {
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `<div class="colors" id="pcRec"></div><label for="pcIn">Színkeverő</label><input type="color" id="pcIn">`;
  const inp = body.querySelector("#pcIn"); inp.value = cur;
  const rec = body.querySelector("#pcRec");
  [cur, ...(kind === "hi" ? S.set.recentHi : S.set.recentPen)].slice(0, 4).forEach(c => { const b = document.createElement("button"); b.style.background = c; b.setAttribute("aria-label", c);
    b.onclick = () => { inp.value = c; rec.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); }; rec.append(b); });
  dialog(title, body, [["Mégse"], ["Alkalmaz", "pri", () => fn(inp.value)]]);
}
let tt; function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2400); }
function busy(m) { $("busyText").textContent = m; $("busy").hidden = false; }
function unbusy() { $("busy").hidden = true; }

/* ================= Billentyűk, átméretezés ================= */
document.addEventListener("keydown", e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? $("bRedo") : $("bUndo")).click(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); $("bRedo").click(); }
  else if (e.key === "PageDown" || e.key === "ArrowRight" && e.altKey) go(1);
  else if (e.key === "PageUp" || e.key === "ArrowLeft" && e.altKey) go(-1);
  else if (e.key === "Escape") { closePops(); clearSel(); }
});
let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(layout, 120); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawPaper);
addEventListener("pagehide", () => { if (S.page) persistPage(S.page, true); });

/* ================= Indulás ================= */
async function start() {
  try { await DB.open(); } catch (e) { toast("A tároló nem nyitható meg: " + e.message); return; }
  S.set = { ...DEF_SET, ...((await DB.get("kv", "settings")) || {}) };
  S.notebooks = (await DB.get("kv", "notebooks")) || [];
  S.deleted = (await DB.get("kv", "deleted")) || { pages: {}, notebooks: {} };
  if (!S.notebooks.length) { S.notebooks.push(newNotebook("Jegyzetek", NB_COLORS[0], "grid")); await saveNotebooks(); }
  if (innerWidth > 1100) $("drawer").hidden = false;
  applyRail(); setTool("pen"); layout();
  await openNotebook(nbOf(S.set.lastNb) ? S.set.lastNb : S.notebooks[0].id);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await Sync.init();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
      reg.addEventListener("updatefound", () => { const w = reg.installing; if (!w) return;
        w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) toast("Új verzió letöltve – a következő indításkor él."); }); });
    }).catch(console.error);
  }
}
start();
window.__jf = { S, Sync, W, H, MM }; // hibakereséshez
})();

/* CyberNote 3 – PWA (korábban: Tervezői jegyzetfüzet)
 * Lap: szélesség 1000 logikai egység; A4-nél 1 mm = 4,762 egység. A lap magassága laponként (importált PDF-nél az oldal arányához igazodik).
 * Felépítés: füzet (projekt) → szakasz → lap. Tárolás: IndexedDB (offline), szinkron: Google Drive (drive.file hatókör).
 * Rétegek: papír + háttér (PDF/kép) → lap írása és jelölők → öntapadós jegyzetcetlik (saját írásréteggel) → élő vonal.
 */
(() => {
"use strict";
const APP_VERSION = "3.2.0";
/* Hibanapló: minden el nem kapott hibát megjegyez (Beállítások › Hibanapló), hogy utólag kideríthető legyen */
const ERRLOG = "jf_errlog";
function logError(kind, msg) {
  try { const l = JSON.parse(localStorage.getItem(ERRLOG) || "[]"); l.unshift({ t: new Date().toISOString(), v: APP_VERSION, k: kind, m: String(msg).slice(0, 600) });
    localStorage.setItem(ERRLOG, JSON.stringify(l.slice(0, 30))); } catch (_) {}
}
addEventListener("error", e => { logError("hiba", (e.message || "") + " @ " + (e.filename || "").split("/").pop() + ":" + e.lineno + (e.error && e.error.stack ? "\n" + e.error.stack : "")); });
addEventListener("unhandledrejection", e => { const r = e.reason; logError("ígéret", r && (r.stack || r.message) || r); });
/* Verzióellenőrzés: ha az oldal (index.html) és a program (app.js) különböző változatból jött, egyszer frissen újratölt */
(() => {
  const want = document.querySelector('meta[name="app-version"]'), v = want && want.content;
  if (v && v !== APP_VERSION) {
    let tried = false; try { tried = sessionStorage.getItem("jf_vfix") === v + "/" + APP_VERSION; sessionStorage.setItem("jf_vfix", v + "/" + APP_VERSION); } catch (_) {}
    logError("verzió", "index.html " + v + " ≠ app.js " + APP_VERSION);
    if (!tried) { (window.caches ? caches.keys().then(k => Promise.all(k.map(n => caches.delete(n)))) : Promise.resolve()).finally(() => location.reload()); throw new Error("verzióeltérés – újratöltés"); }
  }
})();
const W = 1000, H0 = Math.round(1000 * 297 / 210), MM = W / 210;
const BOX = 6 * MM;            // jelölőnégyzet oldala
const QR = 3.2 * MM;           // kérdésjelölő sugara
const NH = 7 * MM;             // jegyzetcetli fogófelülete (felső sáv)
const GRIP = 7 * MM;           // jegyzetcetli átméretező sarka
const INK = "#1b1f24";
const PAPER_LIGHT = "#fdfdfb";
const NB_COLORS = ["#6B2FA0", "#0b6e79", "#1f4fd1", "#c25a00", "#2e7d32", "#b3261e", "#5e6a75", "#a8326f"];
const NOTE_COLORS = ["#FFE97A", "#FFC4DC", "#C8F0B4", "#BFE3FF", "#FFD3A1"];
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const $ = id => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtDate = ts => new Date(ts).toLocaleDateString("hu-HU");
const fmtTime = ts => new Date(ts).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
const clone = o => JSON.parse(JSON.stringify(o));
const pgH = pg => (pg && pg.h) || H0;
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
  penColor: "#1F4FA3", penW: 2.6, hiColor: "#F2C200", hiW: 3, erMode: "stroke", erR: 12,
  penSlot: 0, hiSlot: 0,
  recentW: { pen: [], hi: [], pc: [] }, favW: { pen: null, hi: null, pc: null }, pcW: 2.2, pcHard: "HB",
  lastNb: null, lastSec: {}, lastPage: {}, clientId: "", driveOn: false,
  tab: "draw", ribbonOff: false, navOn: true, pagesOn: true, notesOn: true, navOpen: {}, noteColor: NOTE_COLORS[0],
};
const S = {
  set: { ...DEF_SET }, notebooks: [], nb: null, sec: null, page: null, pages: new Map(),
  tool: "pen", sel: null, note: null, undo: new Map(), redo: new Map(), deleted: { pages: {}, notebooks: {} },
};
const nbOf = id => S.notebooks.find(n => n.id === id);
const saveSettings = () => DB.put("kv", S.set, "settings").catch(console.error);
const saveNotebooks = () => DB.put("kv", S.notebooks, "notebooks").catch(console.error);
const saveDeleted = () => DB.put("kv", S.deleted, "deleted").catch(console.error);

function newSection(name, color) { return { id: uid(), name, color, created: Date.now(), pages: [] }; }
/* Képtár: projektenként egy külön „szakasz” a képernyőképeknek; azonosítója a füzetből képzett, így minden eszközön ugyanaz */
const galSection = nb => ({ id: "g-" + nb.id, name: "Képtár", gal: true, color: nb.color, created: nb.created || Date.now(), pages: [] });
const pdfSection = nb => ({ id: "p-" + nb.id, name: "PDF-ek", pdf: true, color: nb.color, created: nb.created || Date.now(), pages: [] });
const galOf = nb => nb && nb.sections.find(s => s.gal);
const pdfOf = nb => nb && nb.sections.find(s => s.pdf);
const special = s => !!(s && (s.gal || s.pdf)); // Képtár és PDF-ek: a jegyzetlapoktól külön
const isGalPage = pg => { const r = pg && secOf(pg.id); return !!(r && special(r.sec)); };
function newNotebook(name, color, paper) {
  const now = Date.now();
  const nb = { id: uid(), name, color, paper: paper || "grid", created: now, updated: now, sections: [newSection("Jegyzetek", color)] };
  nb.sections.push(galSection(nb), pdfSection(nb)); return nb;
}
/* Régi (2.x) füzet: egyetlen lapsor → egy „Jegyzetek” szakasz. Az azonosító a füzetből képzett, így két eszköz ugyanazt kapja. */
function normNb(nb) {
  if (!Array.isArray(nb.sections)) nb.sections = [{ id: "s-" + nb.id, name: "Jegyzetek", color: nb.color, created: nb.created || Date.now(), pages: (nb.pages || []).slice() }];
  delete nb.pages;
  if (!nb.sections.length) nb.sections.push({ id: "s-" + nb.id + "-" + Date.now().toString(36), name: "Jegyzetek", color: nb.color, created: Date.now(), pages: [] });
  for (const s of nb.sections) { s.pages = Array.isArray(s.pages) ? s.pages : []; s.color = s.color || nb.color; s.name = s.name || "Szakasz"; if (s.id === "g-" + nb.id) s.gal = true; if (s.id === "p-" + nb.id) s.pdf = true; }
  if (!nb.sections.some(s => !special(s))) nb.sections.unshift({ id: "s-" + nb.id + "-" + Date.now().toString(36), name: "Jegyzetek", color: nb.color, created: Date.now(), pages: [] });
  const gals = nb.sections.filter(s => s.gal), g = gals[0] || galSection(nb);
  for (const x of gals.slice(1)) for (const id of x.pages) if (!g.pages.includes(id)) g.pages.push(id);
  g.name = "Képtár";
  const pdfs = nb.sections.filter(s => s.pdf), pd = pdfs[0] || pdfSection(nb);
  for (const x of pdfs.slice(1)) for (const id of x.pages) if (!pd.pages.includes(id)) pd.pages.push(id);
  pd.name = "PDF-ek"; nb.sections = [...nb.sections.filter(s => !special(s)), g, pd];
  return nb;
}
const nbPages = nb => nb.sections.flatMap(s => s.pages);
function secOf(id) { for (const nb of S.notebooks) for (const s of nb.sections) if (s.pages.includes(id)) return { nb, sec: s }; return null; }
const pageNoOf = pg => { const r = secOf(pg.id); return r ? r.sec.pages.indexOf(pg.id) + 1 : 0; };

function newPage(nb, opts = {}) {
  const now = Date.now();
  return { id: uid(), nb: nb.id, created: now, updated: now, paper: opts.paper || nb.paper || "grid",
    bg: opts.bg || null, h: opts.h || H0, mmW: opts.mmW || 210, title: opts.title || "", strokes: [], marks: [], notes: [] };
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
const serStroke = s => ({ id: s.id, t: s.t, c: s.c, w: s.w, a: s.a, ts: s.ts, mt: s.mt || s.ts, p: packPts(s.p) });
const deserStroke = s => bbox({ id: s.id, t: s.t, c: s.c, w: s.w, a: s.a, ts: s.ts, mt: s.mt, p: unpackPts(s.p) });
function serializePage(pg) {
  return { v: 2, id: pg.id, nb: pg.nb, created: pg.created, updated: pg.updated, paper: pg.paper, bg: pg.bg, h: pgH(pg), mmW: pg.mmW || 210, title: pg.title || "",
    strokes: pg.strokes.map(serStroke), marks: pg.marks.map(m => ({ ...m })),
    notes: (pg.notes || []).map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, c: n.c, ts: n.ts, mt: n.mt, strokes: n.strokes.map(serStroke) })) };
}
function deserializePage(o) {
  return { id: o.id, nb: o.nb, created: o.created, updated: o.updated, paper: o.paper || "grid", bg: o.bg || null, h: o.h || H0, mmW: o.mmW || 210, title: o.title || "",
    strokes: (o.strokes || []).map(deserStroke), marks: (o.marks || []).map(m => ({ ...m })),
    notes: (o.notes || []).map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, c: n.c, ts: n.ts, mt: n.mt, strokes: (n.strokes || []).map(deserStroke) })) };
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
  updateOpenBadge(); renderListsSoon();
  Sync.schedule(8000);
}
async function loadPage(id) {
  if (S.pages.has(id)) return S.pages.get(id);
  const o = await DB.get("pages", id);
  if (!o) return null;
  const pg = deserializePage(o); S.pages.set(id, pg); return pg;
}
async function loadNotebookPages(nb) { for (const id of nbPages(nb)) await loadPage(id); }

/* ================= Nézet: nagyítás és görgetés ================= */
const stage = $("stage");
const cP = $("cPaper"), cI = $("cInk"), cL = $("cLive");
const xP = cP.getContext("2d"), xI = cI.getContext("2d"), xL = cL.getContext("2d");
let DPR = 1, SR = { left: 0, top: 0 };
const V = { z: 1, K: 1, tx: 0, ty: 0, cw: 0, ch: 0, fitK: 1 };   // K: CSS px / egység; tx, ty: a lap bal felső sarka a lapterületen
const PAD = 14, ZMIN = .3, ZMAX = 8;
const R = { K: 1, tx: 0, ty: 0 };                                  // a legutóbb kirajzolt nézet (gesztus közben CSS-transzformmal követjük)
const bgCache = new Map();

function layout() {
  const keep = V.cw ? [(-V.tx) / V.K, (-V.ty) / V.K] : null;
  V.cw = Math.max(50, stage.clientWidth); V.ch = Math.max(50, stage.clientHeight);
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  if (V.cw * V.ch * DPR * DPR > 12e6) DPR = Math.sqrt(12e6 / (V.cw * V.ch)); // memóriakorlát
  for (const c of [cP, cI, cL]) { c.width = Math.round(V.cw * DPR); c.height = Math.round(V.ch * DPR); c.style.width = V.cw + "px"; c.style.height = V.ch + "px"; }
  const r = stage.getBoundingClientRect(); SR = { left: r.left, top: r.top };
  V.fitK = Math.max(.05, (V.cw - 2 * PAD) / W); V.K = V.fitK * V.z;
  if (keep) { V.tx = -keep[0] * V.K; V.ty = -keep[1] * V.K; } else { V.tx = PAD; V.ty = PAD; }
  clampView(); render();
}
function clampView() {
  const pw = W * V.K, ph = pgH(S.page) * V.K;
  V.tx = pw + 2 * PAD <= V.cw ? (V.cw - pw) / 2 : clampN(V.tx, V.cw - pw - PAD, PAD);
  V.ty = ph + 2 * PAD + 30 <= V.ch ? PAD : clampN(V.ty, V.ch - ph - PAD - 30, PAD);
}
function zoomAt(z, sx, sy) {
  z = clampN(z, ZMIN, ZMAX);
  const px = (sx - V.tx) / V.K, py = (sy - V.ty) / V.K;
  V.z = z; V.K = V.fitK * z; V.tx = sx - px * V.K; V.ty = sy - py * V.K; clampView();
}
const setViewT = x => x.setTransform(DPR * V.K, 0, 0, DPR * V.K, DPR * V.tx, DPR * V.ty);
function clearCtx(x, c) { x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); setViewT(x); }
const clearLive = () => clearCtx(xL, cL);
const visRect = () => [(-V.tx) / V.K, (-V.ty) / V.K, (V.cw - V.tx) / V.K, (V.ch - V.ty) / V.K];
const viewKey = () => [V.K.toFixed(5), V.tx.toFixed(1), V.ty.toFixed(1), V.cw, V.ch, DPR.toFixed(3), S.page && S.page.id].join("|");
function cssApply() {
  const k = V.K / R.K, dx = V.tx - R.tx * k, dy = V.ty - R.ty * k, t = `translate(${dx}px,${dy}px) scale(${k})`;
  cP.style.transform = t; cI.style.transform = t; placeSel(); placeNoteBar(); updZoomUI();
}
let renderT = 0, renderRaf = 0;
function render() {
  clearTimeout(renderT); if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0; }
  R.K = V.K; R.tx = V.tx; R.ty = V.ty; cP.style.transform = ""; cI.style.transform = "";
  drawPaper(); drawInk(); if (!act) clearLive(); else setViewT(xL);
  placeSel(); placeNoteBar(); updZoomUI(); hiResSoon();
}
const renderSoon = () => { if (!renderRaf) renderRaf = requestAnimationFrame(() => { renderRaf = 0; render(); }); };
const renderLater = ms => { clearTimeout(renderT); renderT = setTimeout(render, ms || 160); };
function updZoomUI() {
  const t = Math.round(V.z * 100) + "%"; $("zTxt").textContent = t;
  const zb = $("zoomBadge"); zb.textContent = t; zb.hidden = Math.abs(V.z - 1) < .01;
}
function fitPage() { const z = Math.min(1, (V.ch - 2 * PAD - 30) / (pgH(S.page) * V.fitK)); zoomAt(z, V.cw / 2, 0); V.ty = PAD; clampView(); render(); }
$("zIn").onclick = () => { zoomAt(V.z * 1.25, V.cw / 2, V.ch / 2); render(); };
$("zOut").onclick = () => { zoomAt(V.z / 1.25, V.cw / 2, V.ch / 2); render(); };
$("zPct").onclick = $("zFitW").onclick = () => { zoomAt(1, V.cw / 2, V.ch / 2); render(); };
$("zFitP").onclick = fitPage;
stage.addEventListener("wheel", e => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? V.ch : 1;
  if (e.ctrlKey || e.metaKey) zoomAt(V.z * Math.exp(-e.deltaY * k * .0022), e.clientX - SR.left, e.clientY - SR.top);
  else { V.tx -= (e.shiftKey ? e.deltaY : e.deltaX) * k; if (!e.shiftKey) V.ty -= e.deltaY * k; clampView(); }
  renderSoon();
}, { passive: false });

/* ================= Rajzolás ================= */
async function ensureBg(pg) {
  if (!pg || !pg.bg) return;
  if (bgCache.has(pg.bg.id)) { const b = bgCache.get(pg.bg.id); bgCache.delete(pg.bg.id); bgCache.set(pg.bg.id, b); return; }
  const blob = await DB.get("blobs", pg.bg.id);
  if (!blob) return;
  try { bgCache.set(pg.bg.id, await createImageBitmap(blob)); } catch (e) { console.error(e); }
  while (bgCache.size > 3) { const [k, b] = bgCache.entries().next().value; if (S.page && S.page.bg && S.page.bg.id === k) { bgCache.delete(k); bgCache.set(k, b); continue; } try { b.close(); } catch (_) {} bgCache.delete(k); }
}
function bgRect(pg) {
  const ph = pgH(pg), r = pg.bg.w / pg.bg.h; let w = W, h = W / r;
  if (h > ph) { h = ph; w = ph * r; }
  return [(W - w) / 2, 0, w, h];
}
function gridLines(x, segs, col, w) { if (!segs.length) return; x.strokeStyle = col; x.lineWidth = w; x.beginPath(); for (const s of segs) { x.moveTo(s[0], s[1]); x.lineTo(s[2], s[3]); } x.stroke(); }
/* Papír, háttér, dátum (jobb felül), oldalszám (alul középen). vr: látható terület (csak ott rajzol rácsot); tl: éles PDF-csempe */
function paintPaper(x, pg, px, paperColor, pageNo, vr, tl) {
  const ph = pgH(pg);
  x.fillStyle = paperColor; x.fillRect(0, 0, W, ph);
  if (!pg) return;
  const gal = isGalPage(pg); if (gal) pageNo = 0;
  if (pg.bg && bgCache.has(pg.bg.id)) { const [a, b, c, d] = bgRect(pg); x.drawImage(bgCache.get(pg.bg.id), a, b, c, d); }
  if (tl) x.drawImage(tl.cv, tl.r[0], tl.r[1], tl.r[2] - tl.r[0], tl.r[3] - tl.r[1]);
  const v = vr ? [Math.max(0, vr[0]), Math.max(0, vr[1]), Math.min(W, vr[2]), Math.min(ph, vr[3])] : [0, 0, W, ph];
  const rule = "#c9d9e6", strong = "#9fbad0";
  const range = (step, a, b, from = 0) => { const o = []; for (let i = Math.max(0, Math.floor((a - from) / step)); from + i * step <= b + .1; i++) o.push(i); return o; };
  if (pg.paper === "grid") {
    const st = 5 * MM;
    gridLines(x, [...range(st, v[0], v[2]).map(i => [i * st, v[1], i * st, v[3]]), ...range(st, v[1], v[3]).map(i => [v[0], i * st, v[2], i * st])], rule, .8 * px);
  } else if (pg.paper === "mm") {
    const xs = range(MM, v[0], v[2]), ys = range(MM, v[1], v[3]);
    for (const [test, col, w] of [[i => i % 5 !== 0, rule, .4], [i => i % 5 === 0 && i % 10 !== 0, rule, .9], [i => i % 10 === 0, strong, 1.2]])
      gridLines(x, [...xs.filter(test).map(i => [i * MM, v[1], i * MM, v[3]]), ...ys.filter(test).map(i => [v[0], i * MM, v[2], i * MM])], col, w * px);
  } else if (pg.paper === "lined") {
    gridLines(x, range(8 * MM, v[1], Math.min(v[3], ph - 15 * MM), 25 * MM).map(i => [v[0], 25 * MM + i * 8 * MM, v[2], 25 * MM + i * 8 * MM]), rule, .8 * px);
    gridLines(x, [[20 * MM, v[1], 20 * MM, v[3]]], "#e3a3a3", 1 * px);
  } else if (pg.paper === "dots") {
    x.fillStyle = strong; const r = Math.max(.9 * px, .5), st = 5 * MM;
    x.beginPath();
    for (const i of range(st, v[0], v[2])) for (const j of range(st, v[1], v[3])) { if (!i || !j) continue; x.moveTo(i * st + r, j * st); x.arc(i * st, j * st, r, 0, 7); }
    x.fill();
  }
  // fejléc / lábléc – a lap tartalmához tartozik, exportban is látszik
  const fs = 3.3 * MM;
  x.font = `500 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  x.textBaseline = "alphabetic";
  if (!gal) {
    const date = fmtDate(pg.created);
    x.textAlign = "right"; const tw = x.measureText(date).width;
    x.fillStyle = paperColor; x.fillRect(W - 8 * MM - tw - 1.5 * MM, 5 * MM, tw + 3 * MM, fs + 2 * MM);
    x.fillStyle = "#4f5b66"; x.fillText(date, W - 8 * MM, 5 * MM + fs + .6 * MM);
  }
  if (pageNo) {
    x.textAlign = "center"; const t = String(pageNo), w2 = x.measureText(t).width;
    x.fillStyle = paperColor; x.fillRect(W / 2 - w2 / 2 - 2 * MM, ph - 11 * MM, w2 + 4 * MM, fs + 2.5 * MM);
    x.fillStyle = "#4f5b66"; x.fillText(t, W / 2, ph - 11 * MM + fs + .6 * MM);
  }
  x.textAlign = "left";
}
let tile = null; // éles PDF-részlet a jelenlegi nézethez
const paperColor = () => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || PAPER_LIGHT;
function drawPaper() {
  const x = xP; x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cP.width, cP.height);
  const pg = S.page; if (!pg) return;
  setViewT(x); const ph = pgH(pg), pc = paperColor();
  x.save(); x.shadowColor = "rgba(200,107,255,.45)"; x.shadowBlur = 22 * DPR; x.shadowOffsetY = 0; x.fillStyle = pc; x.fillRect(0, 0, W, ph); x.restore();
  x.save(); x.beginPath(); x.rect(0, 0, W, ph); x.clip();
  paintPaper(x, pg, 1 / (V.K * DPR), pc, pageNoOf(pg), visRect(), tile && tile.key === viewKey() ? tile : null);
  x.restore();
}

const wOf = (s, pr) => s.t === "h" ? s.w * 6 : s.w * (0.35 + 0.95 * pr);
/* Grafitceruza: szemcsés textúra, a nyomás az erősséget (feketeséget) adja */
const GRAPHITE = "#33363B", HARD = { H: .5, HB: .7, B: .85, "2B": 1 };
function pencilPattern(x, c) {
  x.__pc = x.__pc || {}; if (x.__pc[c]) return x.__pc[c];
  const cv = document.createElement("canvas"); cv.width = cv.height = 128;
  const g = cv.getContext("2d"), img = g.createImageData(128, 128), [r, gg, b] = hexToRgb(c);
  let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < img.data.length; i += 4) { const v = rnd(); img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = v < .22 ? 0 : Math.round(255 * Math.min(1, .45 + v * .8)); }
  g.putImageData(img, 0, 0);
  const pat = x.createPattern(cv, "repeat"); if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(.5));
  return (x.__pc[c] = pat);
}
/* Egész vonal kirajzolása kötegelve: az azonos vastagságú (és ceruzánál azonos erősségű) szakaszok egy útvonalba kerülnek */
function strokeBatched(x, s, alphaFn) {
  const p = s.p, base = x.globalAlpha; let curW = -1, curA = -1, open = false;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], pr = (a[2] + b[2]) / 2;
    const w = Math.round(wOf(s, pr) * 4) / 4, al = alphaFn ? Math.round(alphaFn(pr) * 12) / 12 : 1;
    const m0 = i === 1 ? a : [(p[i - 2][0] + a[0]) / 2, (p[i - 2][1] + a[1]) / 2];
    const m1 = i === p.length - 1 ? b : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (w !== curW || al !== curA) {
      if (open) x.stroke();
      x.lineWidth = w; if (alphaFn) x.globalAlpha = base * al;
      x.beginPath(); x.moveTo(m0[0], m0[1]); open = true; curW = w; curA = al;
    }
    x.quadraticCurveTo(a[0], a[1], m1[0], m1[1]);
  }
  if (open) x.stroke();
  x.globalAlpha = base;
}
function pencilSeg(x, s, i) {
  const p = s.p; x.save(); x.strokeStyle = pencilPattern(x, s.c); x.lineCap = "round"; x.lineJoin = "round";
  x.globalAlpha = (s.a || .6) * (.4 + .6 * (p[i - 1][2] + p[i][2]) / 2); seg(x, s, i); x.restore();
}
function drawStroke(x, s) {
  const p = s.p; if (!p.length) return;
  x.lineCap = "round"; x.lineJoin = "round";
  if (s.t === "g") {
    if (p.length === 1) { x.save(); x.fillStyle = pencilPattern(x, s.c); x.globalAlpha = s.a || .6; x.beginPath(); x.arc(p[0][0], p[0][1], wOf(s, p[0][2]) / 2, 0, 7); x.fill(); x.restore(); return; }
    x.save(); x.strokeStyle = pencilPattern(x, s.c); const A = s.a || .6;
    strokeBatched(x, s, pr => A * (.4 + .6 * pr)); x.restore(); return;
  }
  if (s.t === "h") {
    x.save(); x.globalAlpha = .36; x.globalCompositeOperation = "multiply"; x.strokeStyle = s.c; x.lineWidth = s.w * 6; x.lineCap = "butt";
    x.beginPath(); x.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) x.lineTo(p[i][0], p[i][1]);
    if (p.length === 1) x.lineTo(p[0][0] + .1, p[0][1]); x.stroke(); x.restore(); return;
  }
  x.strokeStyle = s.c; x.fillStyle = s.c;
  if (p.length === 1) { x.beginPath(); x.arc(p[0][0], p[0][1], wOf(s, p[0][2]) / 2, 0, 7); x.fill(); return; }
  strokeBatched(x, s, null);
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
    if ((s.t !== "p" && s.t !== "g") || s.bb[0] < m.x + BOX * .6) return false;
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
/* Öntapadós jegyzetcetli: sárga jegyzettömblap, saját írásréteggel (a vonalak a cetli bal felső sarkához viszonyítva) */
const noteRect = n => [n.x - 14, n.y - 14, n.x + n.w + 18, n.y + n.h + 24];
const overlap = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
function drawNote(x, n, clip) {
  x.save();
  x.shadowColor = "rgba(0,0,0,.24)"; x.shadowBlur = 10; x.shadowOffsetY = 3;
  x.fillStyle = n.c; x.fillRect(n.x, n.y, n.w, n.h);
  x.restore();
  x.save(); x.beginPath(); x.rect(n.x, n.y, n.w, n.h); x.clip();
  x.fillStyle = "rgba(0,0,0,.055)"; x.fillRect(n.x, n.y, n.w, NH);                       // ragasztós sáv
  const g = x.createLinearGradient(0, n.y + n.h - 10 * MM, 0, n.y + n.h); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.07)");
  x.fillStyle = g; x.fillRect(n.x, n.y + n.h - 10 * MM, n.w, 10 * MM);                 // enyhe pöndörödés
  x.fillStyle = "rgba(0,0,0,.28)";
  for (let i = -1; i <= 1; i++) { x.beginPath(); x.arc(n.x + n.w / 2 + i * 2.2 * MM, n.y + NH / 2, .55 * MM, 0, 7); x.fill(); }
  x.strokeStyle = "rgba(0,0,0,.3)"; x.lineWidth = 1.6; x.lineCap = "round"; x.beginPath();
  for (let k = 1; k <= 3; k++) { x.moveTo(n.x + n.w - k * 1.7 * MM, n.y + n.h - .9 * MM); x.lineTo(n.x + n.w - .9 * MM, n.y + n.h - k * 1.7 * MM); }
  x.stroke();
  x.translate(n.x, n.y);
  const lc = clip ? [clip[0] - n.x, clip[1] - n.y, clip[2] - n.x, clip[3] - n.y] : null;
  for (const s of n.strokes) { if (lc && s.bb && !hitsRect(s.bb, lc, reach(s))) continue; try { drawStroke(x, s); } catch (e) { logError("rajz", e && e.message); } }
  x.restore();
}
const reach = s => s.t === "h" ? s.w * 3 + 2 : s.w * 1.4 + 2;
const hitsRect = (bb, r, pad) => !(bb[2] + pad < r[0] || bb[0] - pad > r[2] || bb[3] + pad < r[1] || bb[1] - pad > r[3]);
function paintInk(x, pg, clip, notes = true) {
  for (const s of pg.strokes) {
    if (clip && s.bb && !hitsRect(s.bb, clip, reach(s))) continue;
    try { drawStroke(x, s); } catch (e) { logError("rajz", e && e.message); }
  }
  for (const m of pg.marks) {
    drawMark(x, m);
    if (m.k === "box" && m.done) {
      const st = strikeFor(pg, m);
      if (st) { x.save(); x.strokeStyle = "rgba(27,31,36,.8)"; x.lineWidth = 2.2; x.lineCap = "round"; x.beginPath(); x.moveTo(st[0], st[1]); x.lineTo(st[2], st[1]); x.stroke(); x.restore(); }
    }
  }
  if (notes) for (const n of pg.notes || []) { if (clip && !overlap(noteRect(n), clip)) continue; drawNote(x, n, clip); }
}
const clipPage = (x, pg) => { x.beginPath(); x.rect(0, 0, W, pgH(pg)); x.clip(); };
function drawInk() { dirty = null; clearCtx(xI, cI); const pg = S.page; if (!pg) return; xI.save(); clipPage(xI, pg); paintInk(xI, pg, visRect(), S.set.notesOn); xI.restore(); }
/* Csak a megváltozott terület újrarajzolása (radír, lasszós mozgatás, kész feladat kihúzása, cetli) */
let dirty = null, dirtyRaf = 0;
function markDirty(r) {
  dirty = dirty ? [Math.min(dirty[0], r[0]), Math.min(dirty[1], r[1]), Math.max(dirty[2], r[2]), Math.max(dirty[3], r[3])] : r.slice();
  if (!dirtyRaf) dirtyRaf = requestAnimationFrame(() => { dirtyRaf = 0; const d = dirty; dirty = null; if (d) redrawRegion(d); });
}
function redrawRegion(r) {
  const pg = S.page; if (!pg) return;
  const vr = visRect();
  const a = Math.max(0, vr[0], r[0] - 6), b = Math.max(0, vr[1], r[1] - 6), c = Math.min(W, vr[2], r[2] + 6), d = Math.min(pgH(pg), vr[3], r[3] + 6);
  if (c <= a || d <= b) return;
  setViewT(xI); xI.save(); xI.beginPath(); xI.rect(a, b, c - a, d - b); xI.clip(); xI.clearRect(a, b, c - a, d - b);
  paintInk(xI, pg, [a, b, c, d], S.set.notesOn); xI.restore();
}
const strokeRect = s => { const k = reach(s); return [s.bb[0] - k, s.bb[1] - k, s.bb[2] + k, s.bb[3] + k]; };
function doneRowsTouching(pg, bb) {
  return pg.marks.filter(m => m.k === "box" && m.done && bb[2] > m.x + BOX && bb[3] > m.y - .5 * BOX && bb[1] < m.y + 1.5 * BOX);
}

/* Teljes lap képe (export, Drive). hi: importált PDF-nél a háttér a PDF-ből, a kimenet felbontásán */
async function renderPageCanvas(pg, widthPx, hi) {
  await ensureBg(pg);
  const ph = pgH(pg), c = document.createElement("canvas"); c.width = widthPx; c.height = Math.round(widthPx * ph / W);
  const x = c.getContext("2d"), k = widthPx / W; x.setTransform(k, 0, 0, k, 0, 0);
  let tl = null;
  if (hi && pg.bg && pg.bg.pdf && bgCache.has(pg.bg.id) && bgRect(pg)[2] * k > pg.bg.w * 1.05) {
    try { const [bx, by, bw, bh] = bgRect(pg); tl = await pdfRect(pg, [bx, by, bx + bw, by + bh], k); } catch (e) { logError("export-pdf-háttér", e && e.message); }
  }
  x.save(); clipPage(x, pg); paintPaper(x, pg, 1 / k, "#ffffff", pageNoOf(pg), null, tl); paintInk(x, pg, null, true); x.restore();
  return c;
}

/* ================= Éles PDF nagyításkor ================= */
const loaded = {};
function loadScript(src) {
  if (loaded[src]) return loaded[src];
  loaded[src] = new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.async = true;
    s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error("Nem tölthető be: " + src)); }; document.head.append(s); });
  return loaded[src];
}
async function getPdfJs() {
  if (!window.pdfjsLib) await loadScript(PDFJS);
  const lib = window.pdfjsLib; if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; return lib;
}
const pdfDocs = new Map();
function pdfDoc(pdfId) {
  if (pdfDocs.has(pdfId)) { const p = pdfDocs.get(pdfId); pdfDocs.delete(pdfId); pdfDocs.set(pdfId, p); return p; }
  const p = (async () => { const blob = await DB.get("blobs", pdfId); if (!blob) return null; const lib = await getPdfJs();
    return lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise; })();
  p.catch(() => pdfDocs.delete(pdfId));
  pdfDocs.set(pdfId, p);
  while (pdfDocs.size > 2) { const [k, old] = pdfDocs.entries().next().value; pdfDocs.delete(k); old.then(d => d && d.loadingTask && d.loadingTask.destroy()).catch(() => {}); }
  return p;
}
let pdfTask = null;
/* a lap r téglalapjának (egységben) képe a PDF-ből, s képpont/egység felbontásban */
async function pdfRect(pg, r, s, track) {
  const doc = await pdfDoc(pg.bg.pdf); if (!doc) return null;
  const page = await doc.getPage(pg.bg.pn || 1), [bx, by, bw] = bgRect(pg);
  const v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: bw * s / v1.width });
  const cw = Math.ceil((r[2] - r[0]) * s), ch = Math.ceil((r[3] - r[1]) * s);
  if (cw < 2 || ch < 2 || cw * ch > 24e6) return null;
  const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
  const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cw, ch);
  const task = page.render({ canvasContext: cx, viewport: vp, transform: [1, 0, 0, 1, -(r[0] - bx) * s, -(r[1] - by) * s] });
  if (track) pdfTask = task;
  await task.promise;
  return { r: [r[0], r[1], r[0] + cw / s, r[1] + ch / s], cv };
}
let hiTimer = 0, hiTok = 0;
function hiResSoon() {
  clearTimeout(hiTimer); hiTok++;
  if (pdfTask) { try { pdfTask.cancel(); } catch (_) {} pdfTask = null; }
  const pg = S.page; if (!pg || !pg.bg || !pg.bg.pdf || !bgCache.has(pg.bg.id)) return;
  if (bgRect(pg)[2] * V.K * DPR <= pg.bg.w * 1.1) return;     // a tárolt kép elég éles ehhez a nagyításhoz
  const tok = hiTok, key = viewKey();
  hiTimer = setTimeout(async () => {
    try {
      const [bx, by, bw, bh] = bgRect(pg), vr = visRect();
      const r = [Math.max(bx, vr[0]), Math.max(by, vr[1]), Math.min(bx + bw, vr[2]), Math.min(by + bh, vr[3])];
      if (r[2] <= r[0] || r[3] <= r[1]) return;
      const t = await pdfRect(pg, r, V.K * DPR, true);
      if (!t || tok !== hiTok || key !== viewKey()) return;
      tile = { key, ...t }; drawPaper();
    } catch (e) { if (!e || e.name !== "RenderingCancelledException") logError("pdf-nagyítás", e && (e.message || e)); }
  }, 260);
}

/* ================= Bevitel ================= */
let act = null, penUntil = 0;
const touches = new Map(); let gest = null;
const stagePt = e => [e.clientX - SR.left, e.clientY - SR.top];
const ptOf = e => [(e.clientX - SR.left - V.tx) / V.K, (e.clientY - SR.top - V.ty) / V.K];
const pressureOf = e => e.pointerType === "pen" ? Math.max(.05, Math.min(1, e.pressure || .5)) : .5;
const isEraserEvt = e => !!((e.buttons & 32) || (e.buttons & 2) || e.button === 5 || e.button === 2);
const snapshot = pg => ({ strokes: pg.strokes.slice(), marks: pg.marks.map(m => ({ ...m })), notes: (pg.notes || []).map(n => ({ ...n, strokes: n.strokes.slice() })) });
function pushUndo(pg, snap) {
  if (!S.undo.has(pg.id)) S.undo.set(pg.id, []);
  const u = S.undo.get(pg.id); u.push(snap); if (u.length > 80) u.shift();
  S.redo.set(pg.id, []); updUR();
}
function updUR() { const id = S.page && S.page.id;
  $("bUndo").disabled = !(S.undo.get(id) || []).length; $("bRedo").disabled = !(S.redo.get(id) || []).length; }
/* Visszavonás/újra: csak a ténylegesen megváltozott területet rajzolja újra */
const noteSig = n => [n.x, n.y, n.w, n.h, n.c, n.strokes.map(s => s.id).join(".")].join("|");
function restore(pg, snap) {
  const oldS = new Set(pg.strokes), newS = new Set(snap.strokes); let reg = null, n = 0;
  const add = r => { reg = reg ? [Math.min(reg[0], r[0]), Math.min(reg[1], r[1]), Math.max(reg[2], r[2]), Math.max(reg[3], r[3])] : r.slice(); n++; };
  for (const s of pg.strokes) if (!newS.has(s)) add(strokeRect(s));
  for (const s of snap.strokes) if (!oldS.has(s)) add(strokeRect(s));
  const om = new Map(pg.marks.map(m => [m.id, JSON.stringify(m)])), nm = new Map(snap.marks.map(m => [m.id, JSON.stringify(m)]));
  for (const m of pg.marks) if (nm.get(m.id) !== om.get(m.id)) add(markRect(m));
  for (const m of snap.marks) if (om.get(m.id) !== nm.get(m.id)) add(markRect(m));
  const on = pg.notes || [], nn = snap.notes || [];
  if (on.map(q => q.id).join() !== nn.map(q => q.id).join() && on.length === nn.length) n += 1000;
  const os = new Map(on.map(q => [q.id, noteSig(q)])), ns = new Map(nn.map(q => [q.id, noteSig(q)]));
  for (const q of on) if (ns.get(q.id) !== os.get(q.id)) add(noteRect(q));
  for (const q of nn) if (os.get(q.id) !== ns.get(q.id)) add(noteRect(q));
  pg.strokes = snap.strokes.slice(); pg.marks = snap.marks.map(m => ({ ...m })); pg.notes = nn.map(q => ({ ...q, strokes: q.strokes.slice() }));
  clearSel(); if (S.note && !pg.notes.some(q => q.id === S.note)) hideNoteBar(); else placeNoteBar();
  if (reg || n) { if (n > 400 || !reg) drawInk(); else { for (const m of doneRowsTouching(pg, reg)) add([m.x - 4, m.y - BOX, W, m.y + 2 * BOX]); markDirty(reg); } }
  touchPage(pg);
}
function undo() { const pg = S.page, u = S.undo.get(pg.id) || []; if (!u.length) return;
  (S.redo.get(pg.id) || S.redo.set(pg.id, []).get(pg.id)).push(snapshot(pg)); restore(pg, u.pop()); updUR(); }
function redo() { const pg = S.page, r = S.redo.get(pg.id) || []; if (!r.length) return;
  (S.undo.get(pg.id) || S.undo.set(pg.id, []).get(pg.id)).push(snapshot(pg)); restore(pg, r.pop()); updUR(); }
$("bUndo").onclick = undo; $("bRedo").onclick = redo;

/* Feladat-négyzet helye: mindig a bal margónál, sorba igazítva; ha a sor foglalt, a következő szabad sorba kerül */
function boxRows(pg) { return pg.paper === "lined" ? { base: 21 * MM, step: 8 * MM } : { base: 10 * MM, step: 10 * MM }; }
function boxSlot(pg, y) {
  const { base, step } = boxRows(pg), x = 15 * MM - BOX / 2;
  let k = Math.max(0, Math.round((y - base) / step));
  const taken = cy => pg.marks.some(m => m.k === "box" && Math.abs(m.x - x) < BOX * 1.5 && Math.abs(m.y + BOX / 2 - cy) < step * .6);
  while (taken(base + k * step) && base + (k + 1) * step < pgH(pg) - 15 * MM) k++;
  return { x, y: base + k * step - BOX / 2 };
}
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
function markRect(m) {
  if (m.k === "box") return [m.x - 4, m.y - BOX, W, m.y + 2 * BOX];
  const L = qLayout(m); let r = [m.x - QR - 4, m.y - QR - 4, m.x + QR + 4, m.y + QR + 4];
  if (L) r = [Math.min(r[0], L.x - 4), Math.min(r[1], L.y - 4), Math.max(r[2], L.x + L.w + 4), Math.max(r[3], L.y + L.h + 4)];
  return r;
}
function toggleMark(pg, m) { pushUndo(pg, snapshot(pg)); m.done = !m.done; m.dt = Date.now(); if (pg === S.page) markDirty(markRect(m)); touchPage(pg);
  toast(m.k === "box" ? (m.done ? "Feladat kész" : "Feladat újra nyitott") : (m.done ? "Kérdés lezárva" : "Kérdés újra nyitott")); }

/* cetli találat: melyik cetli és melyik része (fogósáv / átméretező sarok / írófelület) */
function noteHit(pg, x, y) {
  const L = pg.notes || [];
  for (let i = L.length - 1; i >= 0; i--) { const n = L[i];
    if (x < n.x || x > n.x + n.w || y < n.y || y > n.y + n.h) continue;
    if (x > n.x + n.w - GRIP && y > n.y + n.h - GRIP) return { n, part: "grip" };
    return { n, part: y < n.y + NH ? "head" : "body" };
  }
  return null;
}
function liveIn(n, fn) { if (!n) { fn(); return; } xL.save(); xL.beginPath(); xL.rect(n.x, n.y, n.w, n.h); xL.clip(); xL.translate(n.x, n.y); fn(); xL.restore(); }

const capture = e => { try { cL.setPointerCapture(e.pointerId); } catch (err) {} };
cL.addEventListener("contextmenu", e => e.preventDefault());
let penDbg = false;
const dbgShow = (e, kind) => { if (!penDbg) return; const d = $("penDbg"); d.hidden = false;
  d.textContent = `${kind}  típus: ${e.pointerType}  button: ${e.button}  buttons: ${e.buttons}  nyomás: ${(e.pressure || 0).toFixed(2)}  → radír: ${isEraserEvt(e) ? "IGEN" : "nem"}`; };
for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) cL.addEventListener(t, e => dbgShow(e, t.replace("pointer", "")), true);

/* Ujj: egy ujjal görgetés, két ujjal csípő-nagyítás. Toll/egér: írás. */
function gestStart() {
  const pts = [...touches.values()];
  if (!pts.length) { gest = null; return; }
  if (pts.length === 1) gest = { k: "pan", x0: pts[0][0], y0: pts[0][1], tx0: V.tx, ty0: V.ty };
  else { const [a, b] = pts; gest = { k: "pinch", d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, px: ((a[0] + b[0]) / 2 - V.tx) / V.K, py: ((a[1] + b[1]) / 2 - V.ty) / V.K, z0: V.z }; }
}
function gestMove() {
  const pts = [...touches.values()];
  if (gest.k === "pan" && pts.length === 1) { V.tx = gest.tx0 + pts[0][0] - gest.x0; V.ty = gest.ty0 + pts[0][1] - gest.y0; }
  else if (gest.k === "pinch" && pts.length >= 2) {
    const [a, b] = pts, d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    V.z = clampN(gest.z0 * d / gest.d0, ZMIN, ZMAX); V.K = V.fitK * V.z; V.tx = mx - gest.px * V.K; V.ty = my - gest.py * V.K;
  }
  clampView(); cssApply(); renderLater(180);
}
function gestEnd(e) {
  touches.delete(e.pointerId);
  if (touches.size) { gestStart(); return; }
  gest = null; if (R.K !== V.K || R.tx !== V.tx || R.ty !== V.ty) render();
}
cL.addEventListener("pointerdown", e => {
  if (e.pointerType === "touch") {
    if (act || Date.now() < penUntil) return; // tenyérfelismerés
    touches.set(e.pointerId, stagePt(e)); capture(e); gestStart(); return;
  }
  if (e.pointerType === "mouse" && e.button === 1) { e.preventDefault(); touches.clear(); touches.set(e.pointerId, stagePt(e)); capture(e); gestStart(); gest.mouse = true; return; }
  if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2 && e.button !== 5) return;
  // tollal/egérrel egyszerre csak egy érintés lehet: ha még fut az előző, annak a vége elveszett (pl. alkalmazásváltás) – lezárjuk, hogy ne ragadjon be az írás
  if (act) recoverAct("új érintés");
  if (gest) { touches.clear(); gest = null; render(); }
  e.preventDefault(); capture(e); closePops();
  if (e.pointerType === "pen") penUntil = Date.now() + 800;
  const pg = S.page; if (!pg) return;
  const [x, y] = ptOf(e), id = e.pointerId, er = S.tool === "er" || isEraserEvt(e);
  const nh = S.set.notesOn ? noteHit(pg, x, y) : null;
  if (S.note && (!nh || nh.n.id !== S.note)) hideNoteBar();
  if (nh && !er && nh.part !== "body") { clearSel(); act = { kind: nh.part === "head" ? "nmove" : "nsize", id, nid: nh.n.id, lx: x, ly: y, sx: e.clientX, sy: e.clientY, snap: snapshot(pg), moved: false }; return; }
  if (er) { clearSel(); act = { kind: "erase", id, snap: snapshot(pg), changed: false }; eraseAt(x, y); return; }
  const p0 = [x, y, pressureOf(e)];
  if (nh) {
    if (S.tool === "pen" || S.tool === "hi" || S.tool === "pc") { clearSel(); startStroke(id, [x - nh.n.x, y - nh.n.y, p0[2]], nh.n); return; }
    if (S.tool === "box" || S.tool === "q") { toast("Feladatot és kérdést a lapra tehetsz, a jegyzetcetlire nem."); return; }
  }
  if (S.sel) {
    if (S.tool === "lasso" && inBB(S.sel.bb, x, y, 2 * MM)) { act = { kind: "move", id, lx: x, ly: y, snap: snapshot(pg), cloned: false, moved: false }; return; }
    clearSel();
  }
  if (S.tool === "lasso") { act = { kind: "lasso", id, pts: [[x, y]] }; return; }
  if (x < 0 || y < 0 || x > W || y > pgH(pg)) return; // a lapon kívül nem írunk
  if (S.tool === "box" || S.tool === "q") { act = { kind: "place", id, x, y }; return; }
  if (S.tool === "pen") { const m = markAt(pg, x, y); if (m) { act = { kind: "tap", id, m, sx: e.clientX, sy: e.clientY, p0 }; return; } }
  startStroke(id, p0, null);
});
function startStroke(id, p0, note) {
  const t = S.tool === "hi" ? "h" : S.tool === "pc" ? "g" : "p";
  const s = { id: uid(), t, c: t === "h" ? S.set.hiColor : t === "g" ? GRAPHITE : S.set.penColor, w: t === "h" ? S.set.hiW : t === "g" ? S.set.pcW : S.set.penW, p: [p0], ts: Date.now() };
  if (t === "g") s.a = HARD[S.set.pcHard] || .6;
  act = { kind: "draw", id, s, note };
  setViewT(xL); if (t !== "h") liveIn(note, () => drawStroke(xL, s));
}
cL.addEventListener("pointermove", e => {
  if (touches.has(e.pointerId)) { touches.set(e.pointerId, stagePt(e)); if (gest) gestMove(); return; }
  if (!act || e.pointerId !== act.id) return;
  if (e.pointerType === "pen") penUntil = Date.now() + 800;
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
  // ha írás közben nyomja le az S Pen gombot: radírra váltunk
  if ((act.kind === "draw" || act.kind === "tap") && isEraserEvt(e)) {
    clearLive(); act = { kind: "erase", id: act.id, snap: snapshot(S.page), changed: false };
  }
  if (act.kind === "tap") {
    if (Math.hypot(e.clientX - act.sx, e.clientY - act.sy) > 6) { const p0 = act.p0; startStroke(act.id, p0, null); } else return;
  }
  if (act.kind === "erase") { for (const ev of evs) { const [x, y] = ptOf(ev); eraseAt(x, y); } return; }
  if (act.kind === "lasso") { const L = act.pts; for (const ev of evs) L.push(ptOf(ev));
    clearLive(); xL.save(); xL.setLineDash([6, 5]); xL.strokeStyle = "#00B8D4"; xL.lineWidth = 2 / V.K; xL.beginPath();
    xL.moveTo(L[0][0], L[0][1]); for (const q of L) xL.lineTo(q[0], q[1]); xL.stroke(); xL.restore(); return; }
  if (act.kind === "move") { const [x, y] = ptOf(e); moveSel(x - act.lx, y - act.ly); act.lx = x; act.ly = y; return; }
  if (act.kind === "nmove" || act.kind === "nsize") {
    if (!act.moved && Math.hypot(e.clientX - act.sx, e.clientY - act.sy) < 5) return;
    const [x, y] = ptOf(e); noteDrag(x - act.lx, y - act.ly); act.lx = x; act.ly = y; return;
  }
  if (act.kind === "draw") {
    const s = act.s, n = act.note, ox = n ? n.x : 0, oy = n ? n.y : 0;
    for (const ev of evs) { const [x0, y0] = ptOf(ev), x = x0 - ox, y = y0 - oy, l = s.p[s.p.length - 1];
      if (Math.hypot(x - l[0], y - l[1]) < .5 / V.K) continue;
      s.p.push([x, y, pressureOf(ev)]);
      if (s.p.length > 2) { const i = s.p.length - 2; if (s.t === "p") liveIn(n, () => seg(xL, s, i)); else if (s.t === "g") liveIn(n, () => pencilSeg(xL, s, i)); } }
    if (s.t === "h") { clearLive(); liveIn(n, () => drawStroke(xL, s)); }
  }
});
function endPointer(e) {
  if (touches.has(e.pointerId)) { gestEnd(e); return; }
  if (!act || e.pointerId !== act.id) return;
  const a = act; act = null; const pg = S.page;
  if (a.kind === "tap") { if (a.m.k === "q") questionDialog(pg, a.m); else toggleMark(pg, a.m); return; }
  if (a.kind === "erase") { if (a.changed) { pushUndo(pg, a.snap); touchPage(pg); } return; }
  if (a.kind === "nmove" || a.kind === "nsize") {
    if (a.moved) { pushUndo(pg, a.snap); touchPage(pg); placeNoteBar(); }
    else if (a.kind === "nmove") { if (S.note === a.nid) hideNoteBar(); else showNoteBar(a.nid); }
    return;
  }
  if (a.kind === "place") {
    const k = S.tool, m = markAt(pg, a.x, a.y, k);
    if (m) { if (k === "q") questionDialog(pg, m); else toggleMark(pg, m); return; }
    if (k === "q") { questionDialog(pg, null, a.x, a.y); return; }
    pushUndo(pg, snapshot(pg));
    const nm = k === "box" ? { id: uid(), k, ...boxSlot(pg, a.y), done: false, ts: Date.now() }
      : { id: uid(), k, x: a.x, y: a.y, done: false, ts: Date.now() };
    pg.marks.push(nm); drawInk(); touchPage(pg); return;
  }
  if (a.kind === "lasso") { clearLive(); selectPoly(a.pts); return; }
  if (a.kind === "move") { if (a.moved) { pushUndo(pg, a.snap); touchPage(pg); } return; }
  if (a.kind === "draw") {
    const s = a.s; clearLive(); bbox(s); s.mt = s.ts;
    const snap = snapshot(pg);
    if (a.note) {
      const n = (pg.notes || []).find(q => q.id === a.note.id);
      if (!n) return;
      n.strokes.push(s); n.mt = s.ts; pushUndo(pg, snap);
      const r = strokeRect(s); redrawRegion([r[0] + n.x, r[1] + n.y, r[2] + n.x, r[3] + n.y]);
    } else {
      pg.strokes.push(s); pushUndo(pg, snap);
      const r = strokeRect(s);
      if (S.set.notesOn && (pg.notes || []).some(n => overlap(noteRect(n), r))) redrawRegion(r);   // a cetli takarja: a sorrend számít
      else { setViewT(xI); xI.save(); clipPage(xI, pg); drawStroke(xI, s); xI.restore(); }
      for (const m of doneRowsTouching(pg, s.bb)) markDirty([m.x, m.y - BOX, W, m.y + 2 * BOX]);
    }
    rememberWidth(s.t === "h" ? "hi" : s.t === "g" ? "pc" : "pen", s.w);
    touchPage(pg);
  }
}
function recoverAct(why) {
  if (!act) return;
  const a = act;
  try { if (a.kind === "draw" && a.s.p.length) { endPointer({ pointerId: a.id, pointerType: "pen" }); } else { act = null; clearLive();
    if (a.kind === "erase" && a.changed && S.page) { pushUndo(S.page, a.snap); touchPage(S.page); }
    if ((a.kind === "move" || a.kind === "nmove" || a.kind === "nsize") && a.moved && S.page) { pushUndo(S.page, a.snap); touchPage(S.page); } } }
  catch (e) { logError("helyreállítás", e && e.message); act = null; clearLive(); }
  act = null; logError("bevitel", "beragadt érintés feloldva: " + why + " (" + a.kind + ")");
}
cL.addEventListener("lostpointercapture", e => {
  if (touches.has(e.pointerId)) { gestEnd(e); return; }
  if (act && act.id === e.pointerId) setTimeout(() => { if (act && act.id === e.pointerId) recoverAct("elveszett fókusz"); }, 0);
});
document.addEventListener("visibilitychange", () => { if (document.hidden && act) recoverAct("háttérbe került"); });
cL.addEventListener("pointerup", endPointer);
cL.addEventListener("pointercancel", e => {
  if (touches.has(e.pointerId)) { gestEnd(e); return; }
  if (act && act.kind === "draw" && e.pointerId === act.id) endPointer(e); else if (act && e.pointerId === act.id) { act = null; clearLive(); }
});

/* Radír: egész vonal vagy csak a radír alatti rész */
function nearSeg(ax, ay, bx, by, x, y, r) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy; let t = L ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t)); return Math.hypot(ax + t * dx - x, ay + t * dy - y) < r;
}
/* egy vonallistán radíroz (lap vagy cetli koordinátáiban); visszaadja az új listát és az érintett területet */
function eraseList(list, x, y, R) {
  let hit = false, reg = null; const out = [];
  const grow = r => { reg = reg ? [Math.min(reg[0], r[0]), Math.min(reg[1], r[1]), Math.max(reg[2], r[2]), Math.max(reg[3], r[3])] : r.slice(); };
  for (const s of list) {
    const r = R + (s.t === "h" ? s.w * 3 : s.w * .6);
    if (x < s.bb[0] - r || x > s.bb[2] + r || y < s.bb[1] - r || y > s.bb[3] + r) { out.push(s); continue; }
    const p = s.p;
    const touched = p.length === 1 ? Math.hypot(p[0][0] - x, p[0][1] - y) < r
      : p.some((q, i) => i > 0 && nearSeg(p[i - 1][0], p[i - 1][1], q[0], q[1], x, y, r));
    if (!touched) { out.push(s); continue; }
    hit = true; grow(strokeRect(s));
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
  return { out, hit, reg };
}
function eraseAt(x, y) {
  const pg = S.page, R = S.set.erR;
  const nh = S.set.notesOn ? noteHit(pg, x, y) : null;
  if (nh) { // a cetlin csak a cetli írását törli, a lapot nem
    const n = nh.n, res = eraseList(n.strokes, x - n.x, y - n.y, R);
    if (res.hit) { n.strokes = res.out; n.mt = Date.now(); act.changed = true; markDirty([res.reg[0] + n.x, res.reg[1] + n.y, res.reg[2] + n.x, res.reg[3] + n.y]); }
    return;
  }
  const res = eraseList(pg.strokes, x, y, R);
  let hit = res.hit, reg = res.reg || [x - R - 4, y - R - 4, x + R + 4, y + R + 4];
  const grow = r => { reg = [Math.min(reg[0], r[0]), Math.min(reg[1], r[1]), Math.max(reg[2], r[2]), Math.max(reg[3], r[3])]; };
  const gone = pg.marks.filter(m => (m.k === "box" ? (x > m.x - R && x < m.x + BOX + R && y > m.y - R && y < m.y + BOX + R) : Math.hypot(x - m.x, y - m.y) < QR + R));
  if (gone.length) { pg.marks = pg.marks.filter(m => !gone.includes(m)); gone.forEach(m => grow(markRect(m))); hit = true; }
  if (hit) {
    pg.strokes = res.out; act.changed = true;
    for (const m of doneRowsTouching(pg, reg)) grow([m.x, m.y - BOX, W, m.y + 2 * BOX]);
    markDirty(reg);
  }
}

/* Lasszó (csak a lap írására; a cetlit a fogósávjánál lehet mozgatni) */
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
  if (!S.sel) { box.hidden = true; bar.hidden = true; $("recolor").hidden = true; return; }
  const [a, b, c, d] = S.sel.bb;
  Object.assign(box.style, { left: V.tx + a * V.K + "px", top: V.ty + b * V.K + "px", width: (c - a) * V.K + "px", height: (d - b) * V.K + "px" });
  box.hidden = false; bar.hidden = false;
  const br = bar.getBoundingClientRect(), top0 = SR.top, bot0 = SR.top + V.ch, left0 = SR.left, right0 = SR.left + V.cw;
  let top = SR.top + V.ty + b * V.K - br.height - 10; if (top < top0 + 6) top = SR.top + V.ty + d * V.K + 10;
  top = Math.min(Math.max(top, top0 + 6), bot0 - br.height - 6);
  let left = SR.left + V.tx + ((a + c) / 2) * V.K - br.width / 2; left = Math.max(left0 + 6, Math.min(left, right0 - br.width - 6));
  bar.style.top = top + "px"; bar.style.left = left + "px";
}
function clearSel() { if (!S.sel) return; S.sel = null; placeSel(); }
function moveSel(dx, dy) {
  const pg = S.page;
  if (!act.cloned) { // az áthelyezett vonalak új objektumok, hogy a visszavonás az eredetit őrizze
    pg.strokes = pg.strokes.map(s => S.sel.ids.has(s.id) ? { ...s, p: s.p.map(q => q.slice()), bb: s.bb.slice() } : s);
    act.cloned = true;
  }
  const now = Date.now(), before = S.sel.bb.slice();
  for (const s of pg.strokes) if (S.sel.ids.has(s.id)) { for (const q of s.p) { q[0] += dx; q[1] += dy; } s.bb[0] += dx; s.bb[2] += dx; s.bb[1] += dy; s.bb[3] += dy; s.mt = now; }
  for (const m of pg.marks) if (S.sel.mids.has(m.id)) { m.x += dx; m.y += dy; }
  S.sel.bb = [S.sel.bb[0] + dx, S.sel.bb[1] + dy, S.sel.bb[2] + dx, S.sel.bb[3] + dy];
  act.moved = true;
  const nb = S.sel.bb, pad = 30; let r = [Math.min(before[0], nb[0]) - pad, Math.min(before[1], nb[1]) - pad, Math.max(before[2], nb[2]) + pad, Math.max(before[3], nb[3]) + pad];
  for (const m of doneRowsTouching(pg, r)) r = [Math.min(r[0], m.x - 4), Math.min(r[1], m.y - BOX), W, Math.max(r[3], m.y + 2 * BOX)];
  markDirty(r); placeSel();
}
$("sDel").onclick = () => { const pg = S.page; pushUndo(pg, snapshot(pg));
  pg.strokes = pg.strokes.filter(s => !S.sel.ids.has(s.id)); pg.marks = pg.marks.filter(m => !S.sel.mids.has(m.id));
  clearSel(); drawInk(); touchPage(pg); };
$("sCopy").onclick = () => { const pg = S.page; pushUndo(pg, snapshot(pg)); const off = 8 * MM, now = Date.now(), ids = new Set(), mids = new Set();
  for (const s of pg.strokes.filter(s => S.sel.ids.has(s.id))) { const n = bbox({ ...s, id: uid(), ts: now, mt: now, p: s.p.map(q => [q[0] + off, q[1] + off, q[2]]) }); pg.strokes.push(n); ids.add(n.id); }
  for (const m of pg.marks.filter(m => S.sel.mids.has(m.id))) { const n = { ...m, id: uid(), x: m.x + off, y: m.y + off, ts: now, done: false }; delete n.dt; pg.marks.push(n); mids.add(n.id); }
  S.sel = { ids, mids }; selBounds(); placeSel(); drawInk(); touchPage(pg); };
$("sColor").onclick = () => {
  const rc = $("recolor"); if (!rc.hidden) { rc.hidden = true; return; } rc.textContent = "";
  const cols = [...new Set([...slots("pen"), ...favPens().map(f => f.c), "#1E2227"].map(c => c.toLowerCase()))].slice(0, 8);
  cols.forEach(c => rc.append(swatch(c, false, "Átszínezés: " + c, () => {
    const pg = S.page; pushUndo(pg, snapshot(pg)); const now = Date.now();
    pg.strokes = pg.strokes.map(s => S.sel.ids.has(s.id) && s.t === "p" ? { ...s, c, mt: now } : s);
    drawInk(); touchPage(pg); rc.hidden = true; })));
  rc.hidden = false; const br = $("selBar").getBoundingClientRect();
  rc.style.left = Math.max(8, Math.min(br.left, innerWidth - 310)) + "px"; rc.style.top = (br.bottom + 6) + "px";
};
$("sDone").onclick = () => clearSel();

/* ================= Öntapadós jegyzetcetli ================= */
function addNote() {
  const pg = S.page; if (!pg) return;
  if (!S.set.notesOn) { S.set.notesOn = true; saveSettings(); markViewBtns(); drawInk(); }
  const w = 70 * MM, h = 70 * MM, vr = visRect(), ph = pgH(pg);
  const x = clampN((Math.max(0, vr[0]) + Math.min(W, vr[2])) / 2 - w / 2, 0, Math.max(0, W - w));
  const y = clampN(Math.max(0, vr[1]) + 25 * MM, 0, Math.max(0, ph - h));
  pushUndo(pg, snapshot(pg));
  const n = { id: uid(), x, y, w: Math.min(w, W), h: Math.min(h, ph), c: S.set.noteColor || NOTE_COLORS[0], ts: Date.now(), mt: Date.now(), strokes: [] };
  pg.notes = pg.notes || []; pg.notes.push(n);
  markDirty(noteRect(n)); touchPage(pg); showNoteBar(n.id);
  toast("Jegyzetcetli: írj rá tollal, a felső sávjánál fogva mozgathatod, a jobb alsó sarkánál méretezheted.");
}
for (const id of ["bNote", "bNoteH", "bNoteD"]) $(id).onclick = () => { closePanels(); addNote(); };
function noteDrag(dx, dy) {
  const pg = S.page, i = pg.notes.findIndex(q => q.id === act.nid); if (i < 0) return;
  if (!act.moved) { pg.notes[i] = { ...pg.notes[i] }; act.moved = true; } // új objektum: a visszavonás az eredetit őrzi
  const n = pg.notes[i], before = noteRect(n), ph = pgH(pg);
  if (act.kind === "nmove") { n.x = clampN(n.x + dx, -n.w + 15 * MM, W - 15 * MM); n.y = clampN(n.y + dy, 0, ph - NH); }
  else {
    const minW = Math.max(30 * MM, ...n.strokes.map(s => s.bb[2] + 2)), minH = Math.max(25 * MM, ...n.strokes.map(s => s.bb[3] + 2));
    n.w = clampN(n.w + dx, Math.min(minW, 200 * MM), W - Math.max(0, n.x)); n.h = clampN(n.h + dy, Math.min(minH, 250 * MM), ph - n.y);
  }
  n.mt = Date.now();
  const r = noteRect(n); markDirty([Math.min(before[0], r[0]), Math.min(before[1], r[1]), Math.max(before[2], r[2]), Math.max(before[3], r[3])]);
  placeNoteBar();
}
function showNoteBar(id) {
  S.note = id; const box = $("noteCols"); box.textContent = "";
  const n = S.page.notes.find(q => q.id === id); if (!n) return hideNoteBar();
  NOTE_COLORS.forEach(c => box.append(swatch(c, c.toLowerCase() === n.c.toLowerCase(), "Cetli színe " + c, () => noteEdit(q => { q.c = c; S.set.noteColor = c; saveSettings(); }))));
  $("noteBar").hidden = false; placeNoteBar();
}
function hideNoteBar() { S.note = null; $("noteBar").hidden = true; }
function placeNoteBar() {
  const bar = $("noteBar"); if (!S.note || !S.page) { bar.hidden = true; return; }
  const n = (S.page.notes || []).find(q => q.id === S.note); if (!n || !S.set.notesOn) { bar.hidden = true; return; }
  bar.hidden = false; const br = bar.getBoundingClientRect();
  let top = SR.top + V.ty + n.y * V.K - br.height - 8; if (top < SR.top + 6) top = SR.top + V.ty + (n.y + NH) * V.K + 8;
  top = clampN(top, SR.top + 6, SR.top + V.ch - br.height - 6);
  const left = clampN(SR.left + V.tx + (n.x + n.w / 2) * V.K - br.width / 2, SR.left + 6, SR.left + V.cw - br.width - 6);
  bar.style.top = top + "px"; bar.style.left = left + "px";
}
function noteEdit(fn) {
  const pg = S.page, i = pg.notes.findIndex(q => q.id === S.note); if (i < 0) return;
  pushUndo(pg, snapshot(pg)); const before = noteRect(pg.notes[i]);
  const n = pg.notes[i] = { ...pg.notes[i] }; fn(n, i); n.mt = Date.now();
  markDirty(before); markDirty(noteRect(n)); touchPage(pg); showNoteBar(n.id);
}
$("nFront").onclick = () => { const pg = S.page, i = pg.notes.findIndex(q => q.id === S.note); if (i < 0) return;
  pushUndo(pg, snapshot(pg)); const [n] = pg.notes.splice(i, 1); pg.notes.push(n); markDirty(noteRect(n)); touchPage(pg); };
$("nDel").onclick = () => { const pg = S.page, n = pg.notes.find(q => q.id === S.note); if (!n) return;
  const del = () => { pushUndo(pg, snapshot(pg)); pg.notes = pg.notes.filter(q => q !== n); markDirty(noteRect(n)); touchPage(pg); hideNoteBar(); toast("Cetli törölve (visszavonható)"); };
  if (n.strokes.length) dialog("Cetli törlése", "<p>A cetli és a rá írt jegyzet törlődik. A visszavonás gombbal visszahozható.</p>", [["Mégse"], ["Törlés", "dan", del]]); else del(); };
$("nDone").onclick = hideNoteBar;
function markViewBtns() {
  $("vNotes").setAttribute("aria-pressed", String(!!S.set.notesOn));
  $("vNav").setAttribute("aria-pressed", String(navVis)); $("vPages").setAttribute("aria-pressed", String(pagesVis));
  $("bSide").setAttribute("aria-expanded", String(navVis || pagesVis));
}
$("vNotes").onclick = () => { S.set.notesOn = !S.set.notesOn; saveSettings(); markViewBtns(); if (!S.set.notesOn) hideNoteBar(); drawInk(); toast(S.set.notesOn ? "Jegyzetcetlik látszanak" : "Jegyzetcetlik elrejtve (a lapon megmaradnak)"); };

/* ================= Panelek és menüszalag ================= */
const PANELS = ["pPen", "pHi", "pPc", "pEr", "fileMenu", "tasks", "contacts"];
const PANEL_BTN = { fileMenu: "tabFile", tasks: "bTasks", contacts: "bContacts" };
function closePanels(except) {
  for (const id of PANELS) if (id !== except) { $(id).hidden = true; const b = PANEL_BTN[id]; if (b) $(b).setAttribute("aria-expanded", "false"); }
}
const closePops = closePanels;
function openPanel(id, anchor) {
  const el = $(id), wasOpen = !el.hidden;
  closePanels(); if (wasOpen) return false;
  el.hidden = false; const b = PANEL_BTN[id]; if (b) $(b).setAttribute("aria-expanded", "true");
  const topY = $("top").getBoundingClientRect().bottom + 6;
  if (el.classList.contains("tall")) { el.style.top = topY + "px"; }
  else {
    const r = (anchor || $(b || "tabFile")).getBoundingClientRect(), w = el.offsetWidth;
    el.style.left = clampN(r.left, 8, innerWidth - w - 8) + "px"; el.style.top = Math.max(topY, r.bottom + 4) + "px";
    el.style.maxHeight = (innerHeight - Math.max(topY, r.bottom + 4) - 12) + "px";
  }
  return true;
}
document.addEventListener("pointerdown", e => {
  if (e.target.closest(".pop, #top, .dlg, .selbar, .recolor")) return;
  closePanels();
}, true);
function setTab(t) {
  S.set.tab = t; saveSettings();
  document.querySelectorAll(".tab[data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  document.querySelectorAll(".rpanel").forEach(p => p.hidden = p.dataset.panel !== t);
}
document.querySelectorAll(".tab[data-tab]").forEach(b => b.onclick = () => {
  closePanels();
  if (S.set.ribbonOff) { S.set.ribbonOff = false; applyRibbon(); }
  setTab(b.dataset.tab);
});
$("tabFile").onclick = () => { if (openPanel("fileMenu", $("tabFile"))) Sync.status(); };
function applyRibbon() { document.body.classList.toggle("ribbon-off", !!S.set.ribbonOff); $("bRibbon").setAttribute("aria-pressed", String(!!S.set.ribbonOff));
  $("bRibbon").setAttribute("aria-label", S.set.ribbonOff ? "Menüszalag megjelenítése" : "Menüszalag összecsukása"); saveSettings(); requestAnimationFrame(layout); }
$("bRibbon").onclick = () => { S.set.ribbonOff = !S.set.ribbonOff; closePanels(); applyRibbon(); };

/* bal oldali ablaktáblák: széles kijelzőn a lap mellett, keskenyen a lap fölé nyílnak */
let narrow = false, navVis = true, pagesVis = true;
function applyPanes(noLayout) {
  document.body.classList.toggle("narrow", narrow);
  document.body.classList.toggle("nav-off", !navVis); document.body.classList.toggle("pages-off", !pagesVis);
  $("scrim").hidden = !(narrow && (navVis || pagesVis));
  markViewBtns();
  if (!narrow) { S.set.navOn = navVis; S.set.pagesOn = pagesVis; saveSettings(); }
  if (!noLayout) requestAnimationFrame(layout);
}
function checkNarrow() {
  const n = innerWidth < 900;
  if (n !== narrow) { narrow = n; if (n) { navVis = false; pagesVis = false; } else { navVis = S.set.navOn !== false; pagesVis = S.set.pagesOn !== false; } applyPanes(true); }
}
$("bSide").onclick = () => { if (navVis || pagesVis) { navVis = false; pagesVis = false; } else { navVis = true; pagesVis = true; } applyPanes(); };
$("vNav").onclick = () => { navVis = !navVis; applyPanes(); };
$("vPages").onclick = () => { pagesVis = !pagesVis; applyPanes(); };
$("scrim").onclick = () => { navVis = false; pagesVis = false; applyPanes(); };

/* ================= Eszközök ================= */
const TOOL_PANEL = { pen: "pPen", hi: "pHi", pc: "pPc", er: "pEr" };
function setTool(t) {
  if (t !== "lasso") clearSel();
  S.tool = t;
  document.querySelectorAll(".tool[data-tool]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
  renderPalette();
}
document.querySelectorAll(".tool[data-tool]").forEach(b => b.addEventListener("click", () => {
  const t = b.dataset.tool;
  if (S.tool === t && TOOL_PANEL[t]) { if (openPanel(TOOL_PANEL[t], b)) renderPanel(TOOL_PANEL[t]); return; }
  setTool(t); closePanels();
}));
$("bFavPens").onclick = () => { if (S.tool !== "pen") setTool("pen"); if (openPanel("pPen", $("bFavPens"))) renderPanel("pPen"); };
$("bMix").onclick = () => { if (S.tool !== "pen" && S.tool !== "hi") setTool("pen"); const id = S.tool === "hi" ? "pHi" : "pPen"; if (openPanel(id, $("bMix"))) renderPanel(id); };
$("bWidth").onclick = () => { if (!["pen", "hi", "pc"].includes(S.tool)) setTool("pen"); const id = TOOL_PANEL[S.tool]; if (openPanel(id, $("bWidth"))) renderPanel(id); };
function renderPanel(id) {
  if (id === "pPen") {
    renderFavPens(); syncPicker();
    const box = $("penSlots"), a = activeSlot("pen"); box.textContent = "";
    slots("pen").forEach((c, i) => box.append(swatch(c, i === a, "Toll " + (i + 1) + ". színhelye " + c, () => { if (S.tool !== "pen") setTool("pen"); useSlot("pen", i); })));
    if (document.activeElement !== $("penHexIn")) $("penHexIn").value = slots("pen")[a].toUpperCase();
    renderWidthFor("pen");
  } else if (id === "pHi") {
    const box = $("hiColors"); box.textContent = "";
    const a = activeSlot("hi");
    slots("hi").forEach((c, i) => box.append(swatch(c, i === a, "Kiemelő " + (i + 1) + ". színhelye " + c, () => useSlot("hi", i))));
    $("hiPick").value = slots("hi")[a];
    $("hiHex").textContent = S.set.hiColor.toUpperCase();
    renderWidthFor("hi");
  } else if (id === "pPc") {
    document.querySelectorAll("#pcHard button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.h === S.set.pcHard)));
    renderWidthFor("pc");
  } else if (id === "pEr") { markErMode(); $("erSize").value = S.set.erR; $("erOut").textContent = mmTxt(S.set.erR * 2); }
}
function swatch(c, pressed, label, fn) {
  const b = document.createElement("button"); b.className = "sw"; b.style.background = c; b.setAttribute("aria-label", label); b.setAttribute("aria-pressed", String(!!pressed)); b.onclick = fn; return b;
}

/* ================= Színek ================= */
/* 4 fix, saját beállítású színhely tollhoz és kiemelőhöz – a használt színeket az app nem menti magától */
const DEF_SLOTS = { pen: ["#1F4FA3", "#1E2227", "#C2410C", "#2E7D32"], hi: ["#F2C200", "#7ED957", "#FF8FC8", "#7CC4FF"] };
function colorKind() { return S.tool === "hi" ? "hi" : "pen"; }
function slots(k) { const key = k + "Slots"; if (!Array.isArray(S.set[key]) || S.set[key].length !== 4) S.set[key] = DEF_SLOTS[k].slice(); return S.set[key]; }
function activeSlot(k) { return Math.max(0, Math.min(3, S.set[k + "Slot"] | 0)); }
const curKeyOf = k => k === "hi" ? "hiColor" : "penColor";
function setColor(kind, c) {
  S.set[curKeyOf(kind)] = c; saveSettings(); renderPalette();
  if (!$("pPen").hidden && !pickDrag) renderPanel("pPen");
  if (!$("pHi").hidden) renderPanel("pHi");
}
function useSlot(k, i) { S.set[k + "Slot"] = i; setColor(k, slots(k)[i]); }
function setSlotColor(k, i, c) { slots(k)[i] = c; S.set[k + "Slot"] = i; setColor(k, c); }
/* menüszalag: a 4 színhely; az aktívra még egyszer koppintva megnyílik a beállítás */
function renderPalette() {
  const k = colorKind(), cur = S.set[curKeyOf(k)], a = activeSlot(k), box = $("recent"); box.textContent = "";
  slots(k).forEach((c, i) => box.append(swatch(c, i === a && c.toLowerCase() === cur.toLowerCase(), (k === "hi" ? "Kiemelő " : "Toll ") + (i + 1) + ". színe " + c, () => {
    if (S.tool !== "pen" && S.tool !== "hi") setTool("pen");
    const kk = colorKind();
    if (activeSlot(kk) === i && S.set[curKeyOf(kk)].toLowerCase() === slots(kk)[i].toLowerCase()) { $("bMix").click(); return; }
    useSlot(kk, i);
  })));
  renderFavW();
}
function hexToRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map(c => c + c).join(""); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return "#" + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join(""); }
function rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx]; }
function hsvToRgb(h, s, v) { const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c; let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]; }
let hsv = [220, .8, .64], pickDrag = null;
function syncPicker() { hsv = rgbToHsv(...hexToRgb(S.set.penColor)); drawPicker(); }
function drawPicker() {
  $("sv").style.background = `linear-gradient(0deg,#000,transparent),linear-gradient(90deg,#fff,hsl(${hsv[0]},100%,50%))`;
  $("svK").style.left = (hsv[1] * 100) + "%"; $("svK").style.top = ((1 - hsv[2]) * 100) + "%";
  $("hueK").style.left = (hsv[0] / 360 * 100) + "%"; $("penHex").textContent = S.set.penColor.toUpperCase();
}
function livePick() { const c = rgbToHex(...hsvToRgb(hsv[0] % 360, hsv[1], hsv[2])); S.set.penColor = c; slots("pen")[activeSlot("pen")] = c;
  drawPicker(); renderPalette(); drawPenPreview(); const sw = $("penSlots").children[activeSlot("pen")]; if (sw) sw.style.background = c; $("penHexIn").value = c.toUpperCase(); }
for (const [id, fn] of [["sv", (x, y) => { hsv[1] = x; hsv[2] = 1 - y; }], ["hue", x => { hsv[0] = Math.min(359.9, x * 360); }]]) {
  const el = $(id);
  const at = e => { const r = el.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))); };
  el.addEventListener("pointerdown", e => { e.preventDefault(); if (S.tool !== "pen") setTool("pen"); pickDrag = { id }; try { el.setPointerCapture(e.pointerId); } catch (_) {} at(e); livePick(); });
  el.addEventListener("pointermove", e => { if (!pickDrag || pickDrag.id !== id) return; at(e); livePick(); });
  const end = () => { if (!pickDrag || pickDrag.id !== id) return; pickDrag = null; setSlotColor("pen", activeSlot("pen"), S.set.penColor); };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
}
$("penHexIn").addEventListener("change", () => {
  const v = $("penHexIn").value.trim().replace(/^#?/, "#");
  if (/^#[0-9a-f]{6}$/i.test(v)) { if (S.tool !== "pen") setTool("pen"); setSlotColor("pen", activeSlot("pen"), v.toLowerCase()); syncPicker(); }
  else { $("penHexIn").value = slots("pen")[activeSlot("pen")].toUpperCase(); toast("Színkód formátuma: #1F4FA3"); }
});
$("penHexIn").addEventListener("keydown", e => { if (e.key === "Enter") $("penHexIn").blur(); });
$("hiPick").addEventListener("input", () => setSlotColor("hi", activeSlot("hi"), $("hiPick").value));

/* ================= Kedvenc tollak ================= */
const DEF_FAV = [{ n: "Jegyzet", c: "#1F4FA3", mm: .6 }, { n: "Megjegyzés", c: "#C2410C", mm: 1 }, { n: "Vázlat", c: "#1E2227", mm: .35 }];
function favPens() { if (!Array.isArray(S.set.favPens)) S.set.favPens = DEF_FAV.map(f => ({ n: f.n, c: f.c, w: wOfMm("pen", f.mm) })); return S.set.favPens; }
function renderFavPens() {
  const box = $("favList"), list = favPens(); box.textContent = "";
  list.forEach((f, i) => {
    const row = document.createElement("div"); row.className = "fav";
    const b = document.createElement("button"); b.className = "use";
    b.setAttribute("aria-pressed", String(S.set.penColor.toLowerCase() === f.c.toLowerCase() && sameW(S.set.penW, f.w)));
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), path = document.createElementNS(ns, "path");
    svg.setAttribute("viewBox", "0 0 40 12"); svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", "M2 8c8-6 14 2 22-2s10-2 14 0"); path.setAttribute("stroke", f.c); path.setAttribute("stroke-width", String(Math.max(1, Math.min(5, mmOfW("pen", f.w) * 3))));
    svg.append(path);
    const nm = document.createElement("span"); nm.textContent = f.n;
    const mm = document.createElement("span"); mm.className = "mm"; mm.textContent = fmtMm(mmOfW("pen", f.w));
    b.append(svg, nm, mm);
    b.onclick = () => { if (S.tool !== "pen") setTool("pen"); setWidth("pen", f.w); setColor("pen", f.c); renderPanel("pPen"); };
    const d = document.createElement("button"); d.className = "del"; d.setAttribute("aria-label", "Kedvenc törlése: " + f.n);
    d.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    d.onclick = () => { list.splice(i, 1); saveSettings(); renderFavPens(); };
    row.append(b, d); box.append(row);
  });
  $("favAdd").hidden = list.length >= 6 || !$("favSave").hidden;
}
$("favAdd").onclick = () => { $("favSave").hidden = false; $("favAdd").hidden = true; $("favName").value = ""; $("favName").focus(); };
const saveFav = () => { const n = $("favName").value.trim() || "Toll " + (favPens().length + 1);
  favPens().push({ n, c: S.set.penColor, w: S.set.penW }); saveSettings(); $("favSave").hidden = true; renderFavPens(); toast("Kedvenc mentve: " + n); };
$("favOk").onclick = saveFav;
$("favName").addEventListener("keydown", e => { if (e.key === "Enter") saveFav(); else if (e.key === "Escape") { $("favSave").hidden = true; renderFavPens(); } });

/* ================= Vastagság: mm-ben is beírható, utolsó 3 megjegyezve, 1 kedvenc ================= */
const mmTxt = u => (u / MM).toFixed(u / MM < 1 ? 2 : 1).replace(".", ",") + " mm";
const wKind = () => S.tool === "hi" ? "hi" : S.tool === "pc" ? "pc" : "pen";
const mmOfW = (k, w) => k === "hi" ? w * 6 / MM : w * .95 / MM;
const wOfMm = (k, mm) => k === "hi" ? mm * MM / 6 : mm * MM / .95;
const fmtMm = v => v.toFixed(2).replace(/0$/, "").replace(".", ",") + " mm";
const sameW = (a, b) => a != null && b != null && Math.abs(a - b) < .01;
const WKEY = { pen: "penW", hi: "hiW", pc: "pcW" };
function curW(k) { return S.set[WKEY[k]]; }
function setWidth(k, w) { S.set[WKEY[k]] = Math.max(.2, Math.min(40, w)); saveSettings(); renderWidthUI(); }
function rememberWidth(k, w) {
  if (!S.set.recentW) S.set.recentW = { pen: [], hi: [] };
  const r = S.set.recentW[k] || []; if (sameW(r[0], w)) return;
  S.set.recentW[k] = [w, ...r.filter(x => !sameW(x, w))].slice(0, 3); saveSettings(); renderWidthUI();
}
const WUI = { pen: { r: "penW", m: "penMm", c: "penChips", f: "penFav" }, hi: { r: "hiW", m: "hiMm", c: "hiChips", f: "hiFav" }, pc: { r: "pcW", m: "pcMm", c: "pcChips", f: "pcFav" } };
function renderWidthFor(k) {
  const u = WUI[k], w = curW(k), fav = (S.set.favW || {})[k];
  $(u.r).value = Math.min(+$(u.r).max, Math.max(+$(u.r).min, w));
  if (document.activeElement !== $(u.m)) $(u.m).value = mmOfW(k, w).toFixed(2).replace(".", ",");
  const box = $(u.c); box.textContent = "";
  const chip = (v, star) => { const b = document.createElement("button"); b.textContent = (star ? "★ " : "") + fmtMm(mmOfW(k, v));
    b.setAttribute("aria-pressed", String(sameW(v, w))); b.onclick = () => setWidth(k, v); box.append(b); };
  if (fav != null) chip(fav, true);
  ((S.set.recentW || {})[k] || []).filter(x => !sameW(x, fav)).slice(0, 3).forEach(v => chip(v, false));
  $(u.f).textContent = sameW(fav, w) ? "★ Ez a kedvenc (koppints a törléshez)" : (k === "hi" ? "☆ Legyen kedvenc szélesség" : "☆ Legyen kedvenc vastagság");
  if (k === "pen") drawPenPreview(); if (k === "pc") drawPcPreview();
}
for (const k of ["pen", "hi", "pc"]) {
  const u = WUI[k];
  $(u.r).addEventListener("input", () => setWidth(k, +$(u.r).value));
  $(u.m).addEventListener("change", () => { const v = parseFloat(String($(u.m).value).replace(",", "."));
    if (v > 0) setWidth(k, wOfMm(k, v)); $(u.m).value = mmOfW(k, curW(k)).toFixed(2).replace(".", ","); });
  $(u.m).addEventListener("keydown", e => { if (e.key === "Enter") $(u.m).blur(); });
  $(u.f).onclick = () => { if (!S.set.favW) S.set.favW = { pen: null, hi: null };
    S.set.favW[k] = sameW(S.set.favW[k], curW(k)) ? null : curW(k); saveSettings(); renderWidthUI(); };
}
function renderFavW() {
  const k = wKind(), fav = (S.set.favW || {})[k], fb = $("favW"), show = (S.tool === "pen" || S.tool === "hi" || S.tool === "pc") && fav != null;
  fb.hidden = !show;
  if (show) { fb.querySelector(".fav span").textContent = fmtMm(mmOfW(k, fav)).replace(" mm", ""); fb.setAttribute("aria-pressed", String(sameW(fav, curW(k))));
    fb.title = (k === "hi" ? "Kedvenc szélesség: " : "Kedvenc vastagság: ") + fmtMm(mmOfW(k, fav)); }
  $("wTxt").textContent = fmtMm(mmOfW(k, curW(k))).replace(" mm", "");
}
$("favW").onclick = () => { const k = wKind(), f = (S.set.favW || {})[k]; if (f != null) { setWidth(k, f); toast("Kedvenc: " + fmtMm(mmOfW(k, f))); } };
function renderWidthUI() { renderFavW(); if (!$("pPen").hidden) renderWidthFor("pen"); if (!$("pHi").hidden) renderWidthFor("hi"); if (!$("pPc").hidden) renderWidthFor("pc"); }
document.querySelectorAll("#pcHard button").forEach(b => b.onclick = () => { S.set.pcHard = b.dataset.h; saveSettings(); renderPanel("pPc"); drawPcPreview(); });
function drawPcPreview() {
  const c = $("pcPrev"), x = c.getContext("2d"), k = 8 / MM; // 1 mm = 8 px, mint a toll előnézeténél
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.setTransform(k, 0, 0, k, 0, 0);
  const p = []; for (let i = 0; i <= 60; i++) { const t = i / 60; p.push([(12 + t * 416) / k, (24 + Math.sin(t * 6.3) * 12) / k, .3 + .65 * Math.sin(t * Math.PI)]); }
  drawStroke(x, { t: "g", c: GRAPHITE, w: S.set.pcW, a: HARD[S.set.pcHard] || .6, p });
}
function drawPenPreview() {
  const c = $("penPrev"), x = c.getContext("2d"); x.clearRect(0, 0, c.width, c.height);
  x.strokeStyle = S.set.penColor; x.lineCap = "round"; x.lineWidth = Math.max(1, mmOfW("pen", S.set.penW) * 8);
  x.beginPath(); x.moveTo(12, 32); x.bezierCurveTo(80, 0, 140, 46, 220, 24); x.bezierCurveTo(300, 4, 360, 40, 428, 16); x.stroke();
}

/* ================= Radír ================= */
function markErMode() { $("erStroke").setAttribute("aria-pressed", String(S.set.erMode === "stroke")); $("erPart").setAttribute("aria-pressed", String(S.set.erMode === "part")); }
$("erStroke").onclick = () => { S.set.erMode = "stroke"; markErMode(); saveSettings(); };
$("erPart").onclick = () => { S.set.erMode = "part"; markErMode(); saveSettings(); };
$("erSize").addEventListener("input", () => { S.set.erR = +$("erSize").value; $("erOut").textContent = mmTxt(S.set.erR * 2); saveSettings(); });

/* ================= Füzetek, szakaszok, lapok ================= */
async function openNotebook(id, pageId) {
  const nb = nbOf(id); if (!nb) return;
  S.nb = nb; S.set.lastNb = id; S.set.navOpen[id] = true; saveSettings();
  await loadNotebookPages(nb);
  let sec = pageId ? nb.sections.find(s => s.pages.includes(pageId)) : null;
  if (!sec) sec = nb.sections.find(s => s.id === S.set.lastSec[id] && (!special(s) || s.pages.some(p => S.pages.has(p)))) || nb.sections.find(s => !special(s));
  await openSection(sec, pageId);
}
async function openSection(sec, pageId) {
  const nb = S.nb;
  if (special(sec) && !sec.pages.some(p => S.pages.has(p))) sec = nb.sections.find(s => !special(s));
  S.sec = sec; S.set.lastSec[nb.id] = sec.id; saveSettings();
  let avail = sec.pages.filter(p => S.pages.has(p));
  if (!avail.length) { const pg = newPage(nb); sec.pages.push(pg.id); S.pages.set(pg.id, pg); await persistPage(pg, true); nb.updated = Date.now(); saveNotebooks(); avail = [pg.id]; Sync.schedule(8000); }
  const target = pageId && avail.includes(pageId) ? pageId : (avail.includes(S.set.lastPage[sec.id]) ? S.set.lastPage[sec.id] : avail[0]);
  await openPage(target);
}
async function openPage(id, keepView) {
  const pg = await loadPage(id); if (!pg) return;
  if (S.page && S.page !== pg) persistPage(S.page, true);
  const r = secOf(id); if (r) { S.nb = r.nb; S.sec = r.sec; S.set.lastNb = r.nb.id; S.set.lastSec[r.nb.id] = r.sec.id; }
  if (S.page !== pg) { clearSel(); hideNoteBar(); }
  S.page = pg; if (S.sec) S.set.lastPage[S.sec.id] = id; saveSettings();
  await ensureBg(pg); tile = null;
  if (!keepView) { V.z = 1; V.K = V.fitK; V.tx = PAD; V.ty = PAD; }
  clampView(); render(); updUR(); renderPageList(); renderTree(); updateOpenBadge(); updTitle();
  $("paper").value = pg.paper;
  if (narrow && (navVis || pagesVis) && !keepView) { navVis = false; pagesVis = false; applyPanes(); }
}
const pageLabel = pg => pg.title || "Névtelen lap";
function updTitle() {
  const pg = S.page; if (!pg) return; const n = pageNoOf(pg), tot = S.sec ? S.sec.pages.length : 0;
  $("tPage").textContent = pageLabel(pg);
  $("tWhere").textContent = (S.nb ? S.nb.name : "") + " › " + (S.sec ? S.sec.name : "") + " · " + n + (S.sec && S.sec.gal ? ". kép" : S.sec && S.sec.pdf ? ". oldal" : ". lap");
  document.title = pageLabel(pg) + " – " + (S.nb ? S.nb.name : "") + " – CyberNote";
  $("bPrev").disabled = n <= 1; $("bNext").disabled = n >= tot;
}
const go = d => { const i = S.sec.pages.indexOf(S.page.id) + d; if (i >= 0 && i < S.sec.pages.length) openPage(S.sec.pages[i]); };
$("bPrev").onclick = () => go(-1); $("bNext").onclick = () => go(1);
/* a lapszámok változása után a következő lapok Drive-képe is frissüljön */
function bumpFrom(sec, i) { for (const id of sec.pages.slice(i)) { const p = S.pages.get(id); if (p) { p.updated = Date.now(); persistPage(p); } } }
async function addPage(afterId, opts) {
  const nb = opts && opts.into ? opts.into.nb : S.nb, sec = opts && opts.into ? opts.into.sec : S.sec, pg = newPage(nb, opts);
  const j = afterId ? sec.pages.indexOf(afterId) : -1, i = j >= 0 ? j + 1 : sec.pages.length;
  sec.pages.splice(i, 0, pg.id); nb.updated = Date.now();
  S.pages.set(pg.id, pg); await persistPage(pg, true); saveNotebooks();
  bumpFrom(sec, i + 1);
  Sync.schedule(8000);
  return pg;
}
const newPageEnd = async () => { closePanels(); if (S.sec && S.sec.gal) { pickShot(); return; } if (S.sec && S.sec.pdf) { pickPdf(); return; } const pg = await addPage(null); await openPage(pg.id); toast("Új lap: " + pageNoOf(pg) + "."); };
$("bAdd").onclick = $("bAdd2").onclick = $("pgAdd").onclick = newPageEnd;
$("pgInsert").onclick = async () => { closePops(); if (S.sec && S.sec.gal) { pickShot(); return; } if (S.sec && S.sec.pdf) { pickPdf(); return; } const pg = await addPage(S.page.id); await openPage(pg.id); toast("Beszúrva: " + pageNoOf(pg) + ". lap"); };
async function deletePage(pg) {
  const r = secOf(pg.id); if (!r) return;
  const { nb, sec } = r, i = sec.pages.indexOf(pg.id); sec.pages.splice(i, 1); nb.updated = Date.now();
  S.deleted.pages[pg.id] = Date.now(); saveDeleted(); S.pages.delete(pg.id); await DB.del("pages", pg.id); saveNotebooks();
  bumpFrom(sec, i);
  if (S.page === pg) { S.page = null; if (!sec.pages.length) { S.nb = nb; await openSection(sec); } else await openPage(sec.pages[Math.max(0, i - 1)]); }
  else { renderPageList(); renderTree(); }
  toast("Lap törölve"); Sync.schedule(3000);
}
function pageDialog(pg) {
  const r = secOf(pg.id); if (!r) return;
  const body = document.createElement("div"); body.className = "dlgbody";
  const opts = S.notebooks.flatMap(nb => nb.sections.map(s => `<option value="${s.id}"${s === r.sec ? " selected" : ""}>${esc(nb.name)} › ${esc(s.name)}</option>`)).join("");
  body.innerHTML = `<label for="pgTitle">Lap címe</label><input type="text" id="pgTitle" maxlength="80" placeholder="pl. Hőközpont – kapcsolási vázlat">
    <label for="pgSec">Helye (füzet › szakasz)</label><select id="pgSec">${opts}</select>
    <div class="seg"><button class="tb" id="pgUp">▲ Feljebb</button><button class="tb" id="pgDown">▼ Lejjebb</button></div>
    <p>${pageNoOf(pg)}. lap · létrehozva ${fmtDate(pg.created)} ${fmtTime(pg.created)}${pg.bg ? " · importált háttér" : ""}${pg.bg && pg.bg.pdf ? " (PDF)" : ""}</p>`;
  const ti = body.querySelector("#pgTitle"); ti.value = pg.title || "";
  const move = d => { const s = r.sec, i = s.pages.indexOf(pg.id), j = i + d; if (j < 0 || j >= s.pages.length) return;
    [s.pages[i], s.pages[j]] = [s.pages[j], s.pages[i]]; r.nb.updated = Date.now(); saveNotebooks(); bumpFrom(s, Math.min(i, j)); Sync.schedule(3000);
    renderPageList(); if (S.page) { updTitle(); drawPaper(); } body.querySelector("p").textContent = pageNoOf(pg) + ". lap"; };
  body.querySelector("#pgUp").onclick = () => move(-1); body.querySelector("#pgDown").onclick = () => move(1);
  dialog("Lap adatai", body, [
    ["Törlés", "dan", () => setTimeout(() => dialog("Lap törlése", `<p>A(z) ${pageNoOf(pg)}. lap minden tartalma törlődik, a Drive-ról is. Ez nem vonható vissza.</p>`, [["Mégse"], ["Törlés", "dan", () => deletePage(pg)]]), 0)],
    ["Mégse"],
    ["Mentés", "pri", async () => {
      pg.title = ti.value.trim();
      const to = body.querySelector("#pgSec").value;
      if (to !== r.sec.id) {
        let tnb = null, tsec = null; for (const nb of S.notebooks) for (const s of nb.sections) if (s.id === to) { tnb = nb; tsec = s; }
        if (tsec) { const i = r.sec.pages.indexOf(pg.id); r.sec.pages.splice(i, 1); bumpFrom(r.sec, i); tsec.pages.push(pg.id); pg.nb = tnb.id;
          r.nb.updated = tnb.updated = Date.now(); saveNotebooks(); toast("Áthelyezve: " + tnb.name + " › " + tsec.name);
          if (!r.sec.pages.length) { const np = newPage(r.nb); r.sec.pages.push(np.id); S.pages.set(np.id, np); await persistPage(np, true); saveNotebooks(); } }
      }
      touchPage(pg); persistPage(pg, true); Sync.schedule(3000);
      if (S.page === pg) await openPage(pg.id, true); else renderPageList();
    }]]);
  setTimeout(() => ti.focus(), 60);
}
$("bPgEdit").onclick = () => S.page && pageDialog(S.page);

const relDate = ts => new Date(ts).toDateString() === new Date().toDateString() ? "ma " + fmtTime(ts) : fmtDate(ts);
function openCountOf(pg) { return pg.marks.filter(m => !m.done).length; }
function secOpenCount(sec) { let n = 0; for (const id of sec.pages) { const pg = S.pages.get(id); if (pg) n += openCountOf(pg); } return n; }
function nbOpenCount(nb) { return nb.sections.reduce((a, s) => a + secOpenCount(s), 0); }
const ICON_EDIT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor"/></svg>';
const ICON_CHEV = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function badgeEl(n) { const b = el("span", "badge", String(n)); return b; }
function renderTree() {
  const box = $("tree"), q = $("nbSearch").value.trim().toLowerCase(); box.textContent = "";
  const list = S.notebooks.filter(n => !q || n.name.toLowerCase().includes(q) || n.sections.some(s => s.name.toLowerCase().includes(q)));
  for (const nb of list) {
    const open = !!S.set.navOpen[nb.id] || !!q;
    const row = el("div", "trow nbrow"); row.setAttribute("aria-current", String(S.nb === nb && !open));
    const chev = el("button", "chev"); chev.innerHTML = ICON_CHEV; chev.setAttribute("aria-expanded", String(open)); chev.setAttribute("aria-label", (open ? "Összecsukás: " : "Kibontás: ") + nb.name);
    chev.onclick = () => { S.set.navOpen[nb.id] = !open; saveSettings(); renderTree(); };
    const ob = el("button", "open"); const ic = el("span", "nbicon"); ic.style.background = nb.color;
    ob.append(ic, el("span", "nm", nb.name)); const oc = nbOpenCount(nb); if (oc && !open) ob.append(badgeEl(oc));
    ob.onclick = async () => { S.set.navOpen[nb.id] = true; await openNotebook(nb.id); };
    const ed = el("button", "edit"); ed.innerHTML = ICON_EDIT; ed.setAttribute("aria-label", "Füzet beállításai: " + nb.name); ed.onclick = () => notebookDialog(nb);
    row.append(chev, ob, ed); box.append(row);
    if (!open) continue;
    for (const sec of nb.sections) {
      if (special(sec)) continue;
      const sr = el("div", "trow secrow"); sr.setAttribute("aria-current", String(S.sec === sec));
      const sb = el("button", "open"); const bar = el("span", "secbar"); bar.style.background = sec.color || nb.color;
      sb.append(bar, el("span", "nm", sec.name)); const so = secOpenCount(sec); if (so) sb.append(badgeEl(so));
      sb.onclick = async () => { if (S.nb !== nb) { S.nb = nb; await loadNotebookPages(nb); } await openSection(sec); };
      const se = el("button", "edit"); se.innerHTML = ICON_EDIT; se.setAttribute("aria-label", "Szakasz beállításai: " + sec.name); se.onclick = () => sectionDialog(nb, sec);
      sr.append(sb, se); box.append(sr);
    }
    const add = el("button", "addrow sub"); add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'; add.append("Új szakasz");
    add.onclick = () => sectionDialog(nb, null); box.append(add);
    const g = galOf(nb);
    if (g) {
      const gr = el("div", "trow secrow galrow"); gr.setAttribute("aria-current", String(S.sec === g));
      const gb = el("button", "open"); const gi = el("span", "galicon"); gi.innerHTML = ICON_CAM;
      gb.append(gi, el("span", "nm", "Képtár")); gb.setAttribute("aria-label", "Képtár – " + nb.name + " (" + g.pages.length + " kép)");
      if (g.pages.length) gb.append(el("span", "cnt", String(g.pages.length)));
      const go2 = secOpenCount(g); if (go2) gb.append(badgeEl(go2));
      gb.onclick = async () => { if (S.nb !== nb) { S.nb = nb; await loadNotebookPages(nb); } if (!g.pages.some(p => S.pages.has(p))) { galEmpty(nb); return; } await openSection(g); };
      gr.append(gb); box.append(gr);
    }
    const pd = pdfOf(nb);
    if (pd) {
      const docs = pdfDocsOf(pd);
      const pr = el("div", "trow secrow galrow pdfrow"); pr.setAttribute("aria-current", String(S.sec === pd));
      const pb = el("button", "open"); const pi = el("span", "galicon"); pi.innerHTML = ICON_PDF;
      pb.append(pi, el("span", "nm", "PDF-ek")); pb.setAttribute("aria-label", "PDF-ek – " + nb.name + " (" + docs.length + " dokumentum)");
      if (docs.length) pb.append(el("span", "cnt", String(docs.length)));
      const po = secOpenCount(pd); if (po) pb.append(badgeEl(po));
      pb.onclick = async () => { if (S.nb !== nb) { S.nb = nb; await loadNotebookPages(nb); } if (!pd.pages.some(p => S.pages.has(p))) { pdfEmpty(nb); return; } await openSection(pd); };
      pr.append(pb); box.append(pr);
    }
  }
  if (!list.length) box.append(el("div", "empty", "Nincs ilyen nevű füzet vagy szakasz."));
}
function renderPageList() {
  const box = $("pgList"); if (!S.sec) return; box.textContent = "";
  const gal = !!S.sec.gal, pdf = !!S.sec.pdf; box.classList.toggle("shotgrid", gal); box.classList.toggle("pdflist", pdf);
  $("pgAdd").textContent = gal ? "Kép hozzáadása" : pdf ? "PDF hozzáadása" : "Lap hozzáadása";
  if (gal) { renderShotList(box); return; }
  if (pdf) { renderPdfList(box); return; }
  S.sec.pages.forEach((id, i) => {
    const pg = S.pages.get(id); if (!pg) return;
    const row = el("div", "pgrow"); row.setAttribute("aria-current", String(!!S.page && S.page.id === id));
    const b = el("button", "open");
    b.append(el("span", "t", pageLabel(pg)), el("span", "d", (i + 1) + ". lap · " + relDate(pg.created) + (pg.bg ? (pg.bg.pdf ? " · PDF" : " · kép") : "") + ((pg.notes || []).length ? " · cetli" : "")));
    b.onclick = () => openPage(id);
    const oc = openCountOf(pg); if (oc) row.append(b, badgeEl(oc)); else row.append(b);
    const ed = el("button", "edit"); ed.innerHTML = ICON_EDIT; ed.setAttribute("aria-label", "Lap adatai: " + pageLabel(pg)); ed.onclick = () => pageDialog(pg);
    row.append(ed); box.append(row);
  });
  const cur = box.querySelector('[aria-current="true"]'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}
/* ================= Képtár (képernyőképek projektenként) ================= */
const ICON_CAM = '<svg viewBox="0 0 24 24"><path d="M3.5 8.5h3.2L8.6 6h6.8l1.9 2.5h3.2v10.5H3.5z"/><circle cx="12" cy="13.5" r="3.4"/></svg>';
const SHOT_STRIP = 45 * MM; // üres sáv a kép alatt a megjegyzéseknek
const thumbs = new Map();
async function thumbUrl(pg) {
  if (!pg.bg) return ""; if (thumbs.has(pg.bg.id)) return thumbs.get(pg.bg.id);
  const b = await DB.get("blobs", pg.bg.id); if (!b) return "";
  const u = URL.createObjectURL(b); thumbs.set(pg.bg.id, u); return u;
}
function renderShotList(box) {
  S.sec.pages.forEach((id, i) => {
    const pg = S.pages.get(id); if (!pg) return;
    const row = el("div", "shot"); row.setAttribute("aria-current", String(!!S.page && S.page.id === id));
    const b = el("button", "open"); const im = el("img"); im.alt = ""; im.loading = "lazy";
    thumbUrl(pg).then(u => { if (u) im.src = u; });
    b.append(im, el("span", "t", pageLabel(pg)), el("span", "d", (i + 1) + ". kép · " + relDate(pg.created) + ((pg.strokes.length || (pg.notes || []).length) ? " · jegyzetelt" : "")));
    b.onclick = () => openPage(id); row.append(b);
    const oc = openCountOf(pg); if (oc) row.append(badgeEl(oc));
    const ed = el("button", "edit"); ed.innerHTML = ICON_EDIT; ed.setAttribute("aria-label", "Kép adatai: " + pageLabel(pg)); ed.onclick = () => pageDialog(pg);
    row.append(ed); box.append(row);
  });
  const cur = box.querySelector('[aria-current="true"]'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}
function galEmpty(nb) {
  dialog("Képtár – " + nb.name, `<p>A Képtár még üres. Ide kerülnek a projekt képernyőképei, külön a jegyzetlapoktól.</p>
    <p><b>Számítógépen:</b> Win+Shift+S-sel vágj ki egy részt a képernyőből, majd az appban nyomd meg a <b>Ctrl+V</b>-t. A kép az épp nyitott projekt Képtárába kerül, a jegyzetlapod nem változik. Képfájlt az ablakra is ráhúzhatsz.</p>
    <p><b>Tableten:</b> a képre ugyanúgy írhatsz, rajzolhatsz és nagyíthatsz, mint a füzet lapjain.</p>`,
    [["Bezárás"], ["Kép kiválasztása…", "pri", () => { S.nb = nb; pickShot(); }]]);
}
const isImgFile = f => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || "");
async function addShot(f, nb) {
  const g = galOf(nb); if (!g) return null;
  const { blob, w, h } = await imageBlob(f, 3200, 9000, .92), bgId = uid(); await DB.put("blobs", blob, bgId);
  const now = Date.now(), named = f.name && !/^image\.(png|jpe?g)$/i.test(f.name);
  const pg = newPage(nb, { bg: { id: bgId, w, h, type: blob.type || "image/jpeg" }, paper: "blank", h: Math.round(W * h / w + SHOT_STRIP), mmW: 210,
    title: named ? baseName(f.name) : "Képernyőkép " + fmtDate(now) + " " + fmtTime(now) });
  g.pages.push(pg.id); S.pages.set(pg.id, pg); await persistPage(pg, true); nb.updated = Date.now(); saveNotebooks();
  return pg;
}
async function shotsIn(files, nb) {
  nb = nb || S.nb; if (!nb || !files.length) return;
  const inGal = S.sec && S.sec.gal && S.nb === nb, made = [];
  busy(files.length > 1 ? files.length + " kép mentése a Képtárba…" : "Kép mentése a Képtárba…");
  for (const f of files) { try { const pg = await addShot(f, nb); if (pg) made.push(pg); } catch (e) { console.error(e); logError("kepernyokep", e && (e.stack || e.message)); toast("A kép nem menthető: " + e.message); } }
  unbusy(); if (!made.length) return;
  Sync.schedule(3000); renderTree();
  if (inGal) await openPage(made[made.length - 1].id);
  toast((made.length === 1 ? "Kép" : made.length + " kép") + " a Képtárba mentve – " + nb.name);
}
/* ================= PDF-ek (projektenként külön, a jegyzetlapoktól függetlenül) ================= */
const ICON_PDF = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16.5h6"/></svg>';
const pdfKey = pg => (pg.bg && pg.bg.pdf) || "kep-" + pg.id; // dokumentum szerinti csoport
function pdfDocsOf(sec) {
  const m = new Map();
  for (const id of sec.pages) { const pg = S.pages.get(id); if (!pg) continue; const k = pdfKey(pg); if (!m.has(k)) m.set(k, []); m.get(k).push(pg); }
  return [...m.values()];
}
const docName = pg => (pg.title || "PDF").replace(/ – \d+\. oldal$/, "");
function renderPdfList(box) {
  const open = S.set.pdfOpen || (S.set.pdfOpen = {});
  for (const pages of pdfDocsOf(S.sec)) {
    const first = pages[0], k = pdfKey(first), cur = S.page && pages.includes(S.page), exp = open[k] !== false;
    const hd = el("div", "pdfdoc"); hd.setAttribute("aria-current", String(!!cur));
    const hb = el("button", "open"); const ic = el("span", "galicon"); ic.innerHTML = ICON_PDF;
    hb.append(ic, el("span", "t", docName(first)), el("span", "d", pages.length + " oldal · " + relDate(first.created)));
    hb.setAttribute("aria-expanded", String(exp));
    hb.onclick = () => { open[k] = !exp; saveSettings(); if (!exp && !cur) openPage(first.id); else renderPageList(); };
    const oc = pages.reduce((a, p) => a + openCountOf(p), 0); if (oc) hd.append(hb, badgeEl(oc)); else hd.append(hb);
    box.append(hd);
    if (!exp) continue;
    pages.forEach((pg, i) => {
      const row = el("div", "pgrow pdfpg"); row.setAttribute("aria-current", String(S.page === pg));
      const b = el("button", "open"); const im = el("img"); im.alt = ""; im.loading = "lazy"; thumbUrl(pg).then(u => { if (u) im.src = u; });
      const inked = pg.strokes.length || (pg.notes || []).length;
      b.append(im, el("span", "t", (pg.bg && pg.bg.pn ? pg.bg.pn : i + 1) + ". oldal" + (inked ? " ✎" : "")));
      b.onclick = () => openPage(pg.id);
      row.append(b); const c2 = openCountOf(pg); if (c2) row.append(badgeEl(c2));
      const ed = el("button", "edit"); ed.innerHTML = ICON_EDIT; ed.setAttribute("aria-label", "Oldal adatai"); ed.onclick = () => pageDialog(pg);
      row.append(ed); box.append(row);
    });
  }
  const c = box.querySelector('.pdfpg[aria-current="true"]'); if (c && c.scrollIntoView) c.scrollIntoView({ block: "nearest" });
}
function pdfEmpty(nb) {
  dialog("PDF-ek – " + nb.name, `<p>Ide kerülnek a projekt PDF-jei, külön a jegyzetlapoktól és a Képtártól. Minden PDF oldala nagyítható, és tollal ráírhatsz, mint a füzet lapjaira.</p>
    <p>Hozzáadás: <b>Beszúrás › PDF importálása</b>, vagy húzd rá a PDF-fájlt az app ablakára.</p>`,
    [["Bezárás"], ["PDF kiválasztása…", "pri", () => { S.nb = nb; pickPdf(); }]]);
}
const isPdfFile = f => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
async function pdfsIn(files, nb) {
  nb = nb || S.nb; const pd = pdfOf(nb); if (!pd || !files.length) return;
  let first = null;
  try {
    for (const f of files) { const ps = await importPdf(f, null, { nb, sec: pd }); if (ps.length && !first) first = ps[0]; }
  } catch (e) { console.error(e); logError("import", e && (e.stack || e.message)); toast(navigator.onLine ? "A PDF-import nem sikerült: " + e.message : "A PDF-import első használatához internet kell."); }
  unbusy(); renderTree();
  if (first) { S.set.navOpen[nb.id] = true; await openPage(first.id); toast((files.length > 1 ? files.length + " PDF" : "PDF") + " a PDF-ek közé mentve – " + nb.name); }
}
function pickPdf() { importMode = "pdf"; closePanels(); const f = $("fileIn"); f.accept = "application/pdf,.pdf"; f.multiple = true; f.click(); }

function pickShot() { importMode = "shot"; closePanels(); const f = $("fileIn"); f.accept = "image/*"; f.multiple = true; f.click(); }
document.addEventListener("paste", e => {
  const t = e.target; if (t && t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  const cd = e.clipboardData; if (!cd) return;
  let files = [...(cd.items || [])].filter(i => i.kind === "file" && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) files = [...(cd.files || [])].filter(isImgFile);
  if (!files.length) return;
  e.preventDefault(); shotsIn(files);
});
addEventListener("dragover", e => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
addEventListener("drop", e => {
  const fs = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (!fs.length) return;
  e.preventDefault(); const imgs = fs.filter(isImgFile), pdfs = fs.filter(isPdfFile);
  if (!imgs.length && !pdfs.length) { toast("Ide képet (PNG, JPEG) vagy PDF-et húzhatsz."); return; }
  (async () => { if (imgs.length) await shotsIn(imgs); if (pdfs.length) await pdfsIn(pdfs); })();
});

let listT = 0;
function renderListsSoon() { clearTimeout(listT); listT = setTimeout(() => { renderPageList(); renderTree(); if (S.page) updTitle(); }, 300); }
function updateOpenBadge() {
  if (!S.nb) return; const n = nbOpenCount(S.nb);
  const b = $("badge"); b.textContent = n; if (n) delete b.dataset.zero; else b.dataset.zero = "";
}
$("nbSearch").addEventListener("input", renderTree);
$("nbNew").onclick = $("mNewNb").onclick = () => { closePanels(); notebookDialog(null); };

function colorPicker(body, cur, onPick) {
  const cols = body.querySelector(".colors");
  NB_COLORS.forEach(c => { const b = el("button"); b.style.background = c; b.setAttribute("aria-label", "Szín " + c); b.setAttribute("aria-pressed", String(c === cur));
    b.onclick = () => { onPick(c); cols.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); }; cols.append(b); });
}
function notebookDialog(nb) {
  const isNew = !nb; let color = nb ? nb.color : NB_COLORS[S.notebooks.length % NB_COLORS.length];
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `<label for="nbIn">Füzet (projekt) neve</label><input type="text" id="nbIn" maxlength="60" placeholder="pl. Givaudan – hőszivattyú">
    <span>Szín</span><div class="colors"></div>
    <label for="nbPaper">Új lapok alapja</label><select id="nbPaper">${paperOpts(nb ? nb.paper : "grid")}</select>`;
  const inp = body.querySelector("#nbIn"); inp.value = nb ? nb.name : "";
  colorPicker(body, color, c => { color = c; });
  const btns = [["Mégse"]];
  if (!isNew) btns.unshift(["Füzet törlése", "dan", () => setTimeout(() => deleteNotebookDialog(nb), 0)]);
  btns.push([isNew ? "Létrehozás" : "Mentés", "pri", async () => {
    const name = inp.value.trim() || "Névtelen füzet", paper = body.querySelector("#nbPaper").value;
    if (isNew) { const n = newNotebook(name, color, paper); S.notebooks.push(n); saveNotebooks(); await openNotebook(n.id); }
    else { nb.name = name; nb.color = color; nb.paper = paper; nb.updated = Date.now(); saveNotebooks(); renderTree(); updTitle();
      for (const id of nbPages(nb)) { const p = S.pages.get(id) || await loadPage(id); if (p) { p.updated = Date.now(); persistPage(p); } } }
    Sync.schedule(3000);
  }]);
  dialog(isNew ? "Új füzet" : "Füzet beállításai", body, btns); setTimeout(() => inp.focus(), 50);
}
function deleteNotebookDialog(nb) {
  const n = nbPages(nb).length;
  dialog("Füzet törlése", `<p>„${esc(nb.name)}”, minden szakasza és mind a ${n} lapja törlődik, a Drive-ról is. Ez nem vonható vissza.</p>`,
    [["Mégse"], ["Végleges törlés", "dan", async () => {
      const now = Date.now();
      for (const id of nbPages(nb)) { S.deleted.pages[id] = now; S.pages.delete(id); await DB.del("pages", id); }
      S.deleted.notebooks[nb.id] = now; saveDeleted();
      S.notebooks = S.notebooks.filter(x => x !== nb);
      if (!S.notebooks.length) S.notebooks.push(newNotebook("Jegyzetek", NB_COLORS[0], "grid"));
      saveNotebooks(); S.page = null; await openNotebook(S.notebooks[0].id); toast("Füzet törölve"); Sync.schedule(3000);
    }]]);
}
function sectionDialog(nb, sec) {
  const isNew = !sec; let color = sec ? sec.color : NB_COLORS[(nb.sections.length + 1) % NB_COLORS.length];
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `<label for="secIn">Szakasz neve</label><input type="text" id="secIn" maxlength="60" placeholder="pl. Hőközpont, Bejárás 11.06., Egyeztetések">
    <span>Szín</span><div class="colors"></div>${isNew ? "" : `<p>${sec.pages.length} lap · ${esc(nb.name)}</p>`}`;
  const inp = body.querySelector("#secIn"); inp.value = sec ? sec.name : "";
  colorPicker(body, color, c => { color = c; });
  const btns = [["Mégse"]];
  if (!isNew) btns.unshift(["Szakasz törlése", "dan", () => setTimeout(() => dialog("Szakasz törlése", `<p>„${esc(sec.name)}” és mind a ${sec.pages.length} lapja törlődik, a Drive-ról is. Ez nem vonható vissza.</p>`,
    [["Mégse"], ["Végleges törlés", "dan", async () => {
      const now = Date.now();
      for (const id of sec.pages) { S.deleted.pages[id] = now; S.pages.delete(id); await DB.del("pages", id); }
      saveDeleted(); nb.sections = nb.sections.filter(s => s !== sec);
      if (!nb.sections.some(s => !special(s))) nb.sections.unshift(newSection("Jegyzetek", nb.color));
      nb.updated = Date.now(); saveNotebooks(); S.page = null; await openNotebook(nb.id); toast("Szakasz törölve"); Sync.schedule(3000);
    }]]), 0)]);
  btns.push([isNew ? "Létrehozás" : "Mentés", "pri", async () => {
    const name = inp.value.trim() || (isNew ? (nb.sections.length + 1) + ". szakasz" : sec.name);
    if (isNew) { const s = newSection(name, color); const gi = nb.sections.findIndex(x => special(x)); nb.sections.splice(gi < 0 ? nb.sections.length : gi, 0, s); nb.updated = Date.now(); saveNotebooks(); S.set.navOpen[nb.id] = true;
      S.nb = nb; await loadNotebookPages(nb); await openSection(s); }
    else { sec.name = name; sec.color = color; nb.updated = Date.now(); saveNotebooks(); renderTree(); updTitle();
      for (const id of sec.pages) { const p = S.pages.get(id); if (p) { p.updated = Date.now(); persistPage(p); } } }
    Sync.schedule(3000);
  }]);
  dialog(isNew ? "Új szakasz – " + nb.name : "Szakasz beállításai", body, btns); setTimeout(() => inp.focus(), 50);
}
const PAPERS = [["grid", "Kockás 5 mm"], ["mm", "Milliméterpapír"], ["lined", "Vonalas"], ["dots", "Pontrács"], ["blank", "Üres"]];
const paperOpts = sel => PAPERS.map(([v, n]) => `<option value="${v}"${v === sel ? " selected" : ""}>${n}</option>`).join("");
$("paper").innerHTML = paperOpts("grid");
$("paper").onchange = () => { const pg = S.page; pg.paper = $("paper").value; drawPaper(); touchPage(pg); };

/* ================= Feladatok és kérdések ================= */
let tkKind = "box", tkDone = false;
function markSeg() { $("tkTasks").setAttribute("aria-pressed", String(tkKind === "box")); $("tkQs").setAttribute("aria-pressed", String(tkKind === "q"));
  $("fOpen").setAttribute("aria-pressed", String(!tkDone)); $("fDone").setAttribute("aria-pressed", String(tkDone)); }
$("bTasks").onclick = () => { if (openPanel("tasks")) { markSeg(); renderTasks(); } };
$("taskClose").onclick = () => closePanels();
$("tkTasks").onclick = () => { tkKind = "box"; markSeg(); renderTasks(); }; $("tkQs").onclick = () => { tkKind = "q"; markSeg(); renderTasks(); };
$("fOpen").onclick = () => { tkDone = false; markSeg(); renderTasks(); }; $("fDone").onclick = () => { tkDone = true; markSeg(); renderTasks(); };
$("tkAll").onchange = () => renderTasks();
function itemRegion(pg, m) {
  const ph = pgH(pg);
  if (m.k === "box") { const st = strikeFor({ ...pg, marks: [] }, m); const x1 = Math.min(W, st ? st[2] + 4 * MM : m.x + 120 * MM);
    return [Math.max(0, m.x - 3 * MM), Math.max(0, m.y - 4 * MM), x1, Math.min(ph, m.y + BOX + 4 * MM)]; }
  const cand = pg.strokes.filter(s => (s.t === "p" || s.t === "g") && s.bb[0] > m.x && Math.abs((s.bb[1] + s.bb[3]) / 2 - m.y) < QR * 2.4).sort((a, b) => a.bb[0] - b.bb[0]);
  let right = m.x + QR; for (const s of cand) { if (s.bb[0] - right > 22 * MM) break; right = Math.max(right, s.bb[2]); }
  const L = qLayout(m);
  if (L) return [Math.max(0, Math.min(m.x - QR, L.x) - 3 * MM), Math.max(0, Math.min(m.y - QR, L.y) - 3 * MM), Math.min(W, Math.max(m.x + QR, L.x + L.w) + 3 * MM), Math.min(ph, Math.max(m.y + QR, L.y + L.h) + 3 * MM)];
  return [Math.max(0, m.x - QR - 3 * MM), Math.max(0, m.y - QR - 4 * MM), Math.min(W, Math.max(right + 4 * MM, m.x + 60 * MM)), Math.min(ph, m.y + QR + 4 * MM)];
}
function cropCanvas(pg, r, cssW) {
  const [a, b, c, d] = r, wu = c - a, hu = d - b, dpr = Math.min(2, devicePixelRatio || 1);
  const cv = document.createElement("canvas"), k = cssW / wu; cv.width = Math.round(cssW * dpr); cv.height = Math.round(hu * k * dpr);
  const x = cv.getContext("2d"); x.fillStyle = "#fdfdfb"; x.fillRect(0, 0, cv.width, cv.height);
  x.setTransform(k * dpr, 0, 0, k * dpr, -a * k * dpr, -b * k * dpr); paintInk(x, pg, r, true); return cv;
}
let tkRender = 0;
async function renderTasks() {
  const token = ++tkRender, ul = $("tkList"), all = $("tkAll").checked, nbs = all ? S.notebooks : [S.nb];
  for (const nb of nbs) await loadNotebookPages(nb);
  if (token !== tkRender) return;
  ul.textContent = ""; let count = 0;
  for (const nb of nbs) for (const sec of nb.sections) {
    sec.pages.forEach((id, i) => {
      const pg = S.pages.get(id); if (!pg) return;
      pg.marks.filter(m => m.k === tkKind && !!m.done === tkDone).sort((a, b) => a.y - b.y).forEach(m => {
        count++;
        const row = el("div", "task"); if (m.done) row.dataset.done = "";
        const cb = el("button", "cb" + (m.k === "q" ? " q" : ""));
        cb.setAttribute("aria-label", m.done ? "Újranyitás" : (m.k === "q" ? "Kérdés lezárása" : "Késznek jelölés"));
        cb.append(el("span", null, m.done ? "✓" : ""));
        cb.onclick = () => { toggleMark(pg, m); renderTasks(); };
        const gob = el("button", "go");
        const cv = cropCanvas(pg, itemRegion(pg, m), Math.min(320, innerWidth - 120));
        const meta = el("span", "meta", (all ? nb.name + " › " : "") + sec.name + " · " + (i + 1) + ". lap · " + fmtDate(m.ts) + (m.text ? " · " + m.text.slice(0, 60) : ""));
        gob.append(cv, meta);
        gob.onclick = async () => { closePanels(); if (S.nb !== nb) await openNotebook(nb.id, id); else await openPage(id); flashAt(m); };
        row.append(cb, gob); ul.append(row);
      });
    });
  }
  if (!count) ul.append(el("div", "empty", (tkDone ? "Nincs kész " : "Nincs nyitott ") + (tkKind === "box" ? "feladat." : "kérdés.")));
}
function flashAt(m) {
  const y = m.k === "box" ? m.y : m.y - QR;
  V.ty = -y * V.K + 120; clampView(); render();
  setViewT(xL); xL.save(); xL.strokeStyle = "#c25a00"; xL.lineWidth = 3;
  const r = m.k === "box" ? [m.x - 3 * MM, m.y - 3 * MM, BOX + 6 * MM, BOX + 6 * MM] : [m.x - QR - 3 * MM, m.y - QR - 3 * MM, 2 * QR + 6 * MM, 2 * QR + 6 * MM];
  xL.strokeRect(...r); xL.restore(); setTimeout(() => { if (!act) clearLive(); }, 1600);
}

/* ================= Névjegyek (projektenként) ================= */
const ROLES = ["Megrendelő", "Építész", "Statikus", "Épületgépész", "Villamos", "Generálkivitelező", "Alvállalkozó", "Üzemeltető", "Tűzvédelem", "Energetikus", "Gyártó / forgalmazó", "Hatóság"];
$("bContacts").onclick = () => { if (openPanel("contacts")) renderContacts(); };
$("ctClose").onclick = () => closePanels();
$("ctNew").onclick = () => contactDialog(null);
$("ctSearch").addEventListener("input", () => renderContacts());
function renderContacts() {
  const nb = S.nb, list = (nb.contacts || []).slice().sort((a, b) => a.name.localeCompare(b.name, "hu"));
  const q = $("ctSearch").value.trim().toLowerCase();
  $("ctTitle").textContent = "Névjegyek – " + nb.name;
  const box = $("ctList"); box.textContent = "";
  const shown = list.filter(c => !q || [c.name, c.role, c.phone, c.email].join(" ").toLowerCase().includes(q));
  for (const c of shown) {
    const card = el("div", "ct"), head = el("div", "cthead"), info = el("div", "ctinfo");
    info.append(el("div", "ctname", c.name), el("div", "ctrole", c.role || ""));
    const ed = el("button", "edit"); ed.setAttribute("aria-label", "Névjegy szerkesztése: " + c.name);
    ed.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>'; ed.onclick = () => contactDialog(c);
    head.append(info, ed); card.append(head);
    const line = (href, text, icon) => { const a = el("a", "ctline"); a.href = href; a.innerHTML = icon; a.append(el("span", null, text)); card.append(a); };
    if (c.phone) line("tel:" + c.phone.replace(/[^0-9+]/g, ""), c.phone, '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>');
    if (c.email) line("mailto:" + c.email, c.email, '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>');
    box.append(card);
  }
  if (!shown.length) box.append(el("div", "empty", list.length ? "Nincs találat." : "Ehhez a projekthez még nincs névjegy. Az „Új névjegy” gombbal adhatsz hozzá."));
}
function contactDialog(c) {
  const nb = S.nb, isNew = !c;
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `<label for="cName">Név</label><input type="text" id="cName" maxlength="80" autocomplete="off">
    <label for="cPhone">Telefonszám</label><input type="text" id="cPhone" inputmode="tel" maxlength="40" autocomplete="off" placeholder="+36 30 123 4567">
    <label for="cMail">E-mail</label><input type="text" id="cMail" inputmode="email" maxlength="120" autocomplete="off" placeholder="nev@ceg.hu">
    <label for="cRole">Szakág</label><input type="text" id="cRole" list="roleList" maxlength="60" autocomplete="off" placeholder="pl. Épületgépész">
    <datalist id="roleList">${ROLES.map(r => `<option value="${esc(r)}">`).join("")}</datalist>
    <p id="cErr" class="err" hidden></p>`;
  const f = id => body.querySelector(id);
  if (c) { f("#cName").value = c.name; f("#cPhone").value = c.phone || ""; f("#cMail").value = c.email || ""; f("#cRole").value = c.role || ""; }
  const save = () => {
    const name = f("#cName").value.trim(), phone = f("#cPhone").value.trim(), email = f("#cMail").value.trim(), role = f("#cRole").value.trim();
    const err = !name ? "A név megadása kötelező." : (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ? "Az e-mail cím formátuma nem jó." : "";
    if (err) { f("#cErr").textContent = err; f("#cErr").hidden = false; return false; }
    nb.contacts = nb.contacts || []; const now = Date.now();
    if (isNew) nb.contacts.push({ id: uid(), name, phone, email, role, created: now, updated: now });
    else Object.assign(nb.contacts.find(x => x.id === c.id) || {}, { name, phone, email, role, updated: now });
    nb.updated = now; saveNotebooks(); Sync.schedule(3000); renderContacts(); toast(isNew ? "Névjegy mentve" : "Névjegy frissítve");
  };
  const btns = [];
  if (!isNew) btns.push(["Törlés", "dan", () => setTimeout(() => dialog("Névjegy törlése", `<p>„${esc(c.name)}” névjegye törlődik ebből a projektből.</p>`,
    [["Mégse"], ["Törlés", "dan", () => { nb.contacts = (nb.contacts || []).filter(x => x.id !== c.id); nb.updated = Date.now(); saveNotebooks(); Sync.schedule(3000); renderContacts(); toast("Névjegy törölve"); }]]), 0)]);
  btns.push(["Mégse"], ["Mentés", "pri", save]);
  dialog(isNew ? "Új névjegy" : "Névjegy", body, btns);
  setTimeout(() => f("#cName").focus(), 60);
}

/* ================= Import: a PDF mindig új lap(ok)ra kerül, a kép háttérként is ================= */
let importMode = "new";
const ACC_ALL = "application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg", ACC_IMG = "image/png,image/jpeg,.png,.jpg,.jpeg";
$("impNew").onclick = () => pickPdf();
$("mImport").onclick = () => { importMode = "sort"; closePanels(); const f = $("fileIn"); f.accept = ACC_ALL; f.multiple = true; f.click(); };
$("impShot").onclick = () => pickShot();
$("impHere").onclick = () => { importMode = "here"; closePanels(); const f = $("fileIn"); f.accept = ACC_IMG; f.multiple = false; f.click(); };
const baseName = n => n.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim().slice(0, 70);
async function jpegOf(c, q) { return new Promise(r => c.toBlob(r, "image/jpeg", q)); }
async function importPdf(f, afterId, into) {
  busy("PDF betöltése…"); const lib = await getPdfJs();
  const buf = new Uint8Array(await f.arrayBuffer()), pdfId = uid();
  await DB.put("blobs", new Blob([buf], { type: "application/pdf" }), pdfId);
  const task = lib.getDocument({ data: buf.slice() }), doc = await task.promise, made = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      busy(`PDF: ${i}. / ${doc.numPages} oldal…`);
      const p = await doc.getPage(i), v1 = p.getViewport({ scale: 1 }), sc = Math.min(2400 / v1.width, 3400 / v1.height, 6);
      const vp = p.getViewport({ scale: sc }), c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: cx, viewport: vp }).promise; p.cleanup();
      const blob = await jpegOf(c, .88), bgId = uid(); await DB.put("blobs", blob, bgId);
      const pg = await addPage(afterId, { into, bg: { id: bgId, w: c.width, h: c.height, type: "image/jpeg", pdf: pdfId, pn: i }, paper: "blank",
        h: Math.round(W * v1.height / v1.width), mmW: Math.round(v1.width / 72 * 25.4 * 10) / 10, title: baseName(f.name) + (doc.numPages > 1 ? ` – ${i}. oldal` : "") });
      afterId = pg.id; made.push(pg); c.width = c.height = 0;
    }
  } finally { try { task.destroy(); } catch (_) {} }
  return made;
}
async function imageBlob(f, mw = 2400, mh = 3400, q = .88) {
  const bmp = await createImageBitmap(f); let w = bmp.width, h = bmp.height, blob = f;
  if (w > mw || h > mh || f.type === "image/png" && f.size > 3e6 || !/^image\/(png|jpeg)$/.test(f.type)) {
    const k = Math.min(mw / w, mh / h, 1); const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(bmp, 0, 0, c.width, c.height);
    blob = await jpegOf(c, q); w = c.width; h = c.height;
  }
  try { bmp.close(); } catch (_) {}
  return { blob, w, h };
}
$("fileIn").addEventListener("change", async () => {
  const files = [...$("fileIn").files]; $("fileIn").value = ""; if (!files.length) return;
  if (importMode === "pdf" || importMode === "sort") { const nb = S.nb, imgs = importMode === "sort" ? files.filter(isImgFile) : [], pdfs = files.filter(isPdfFile);
    if (!imgs.length && !pdfs.length) { toast("Nem támogatott fájl"); return; }
    if (imgs.length) await shotsIn(imgs, nb); if (pdfs.length) await pdfsIn(pdfs, nb); return; }
  if (importMode === "shot") { const imgs = files.filter(isImgFile); if (imgs.length) { const nb = S.nb; await shotsIn(imgs, nb); const g = galOf(nb); if (S.sec !== g && g && g.pages.length) await openPage(g.pages[g.pages.length - 1]); } return; }
  let made = [], after = S.page ? S.page.id : null;
  try {
    for (const f of files) {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      if (isPdf) { const ps = await importPdf(f, after); made.push(...ps); if (ps.length) after = ps[ps.length - 1].id; continue; }
      if (!(/^image\/(png|jpeg)$/.test(f.type) || /\.(png|jpe?g)$/i.test(f.name))) { toast("Nem támogatott fájl: " + f.name); continue; }
      busy("Kép betöltése…");
      const { blob, w, h } = await imageBlob(f), bgId = uid(); await DB.put("blobs", blob, bgId);
      const bg = { id: bgId, w, h, type: blob.type || "image/jpeg" };
      if (importMode === "here") { const pg = S.page; pushUndo(pg, snapshot(pg)); pg.bg = bg; await ensureBg(pg); tile = null; drawPaper(); touchPage(pg); unbusy(); toast("Háttér betöltve erre a lapra"); return; }
      const r = clampN(h / w, .3, 3);
      const pg = await addPage(after, { bg, paper: "blank", h: Math.round(W * r), mmW: r >= 1 ? 210 : 297, title: baseName(f.name) });
      made.push(pg); after = pg.id;
    }
  } catch (e) { console.error(e); unbusy(); toast(navigator.onLine ? "Az importálás nem sikerült: " + e.message : "A PDF-import első használatához internet kell."); logError("import", e && (e.stack || e.message)); if (made.length) await openPage(made[0].id); return; }
  unbusy(); if (made.length) { await openPage(made[0].id); toast(made.length === 1 ? "Új lapra importálva" : made.length + " új lap importálva"); }
});

/* ================= Export: PDF és Word (.docx) – saját író, internet nélkül is működik ================= */
const enc = new TextEncoder();
const u8 = s => enc.encode(s);
function pdfStr(s) { // PDF szöveg UTF-16BE hexában (ékezetek miatt)
  let h = "FEFF"; for (const ch of String(s)) { const c = ch.codePointAt(0); if (c > 0xffff) { const v = c - 0x10000; h += (0xd800 + (v >> 10)).toString(16).padStart(4, "0") + (0xdc00 + (v & 1023)).toString(16).padStart(4, "0"); } else h += c.toString(16).padStart(4, "0"); }
  return "<" + h.toUpperCase() + ">";
}
const exportPx = pg => Math.min(3200, Math.round((pg.mmW || 210) / 25.4 * 200)); // ≈ 200 dpi
async function pageJpeg(pg) { const c = await renderPageCanvas(pg, exportPx(pg), true); const b = await jpegOf(c, .86); const out = { data: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height }; c.width = c.height = 0; return out; }
async function buildPdf(ids, title, progress) {
  const parts = [], offs = []; let len = 0;
  const push = d => { const b = typeof d === "string" ? u8(d) : d; parts.push(b); len += b.length; };
  const n = ids.length, kids = ids.map((_, i) => `${4 + 3 * i} 0 R`).join(" ");
  push("%PDF-1.4\n%âãÏÓ\n");
  for (let i = 0; i < n; i++) {
    progress && progress(i, n);
    const pg = await loadPage(ids[i]), img = await pageJpeg(pg);
    const wpt = (pg.mmW || 210) / 25.4 * 72, hpt = wpt * pgH(pg) / W, po = 4 + 3 * i, co = po + 1, io = po + 2;
    const content = `q\n${wpt.toFixed(3)} 0 0 ${hpt.toFixed(3)} 0 0 cm\n/Im${i} Do\nQ\n`;
    offs[po] = len; push(`${po} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt.toFixed(3)} ${hpt.toFixed(3)}] /Resources << /XObject << /Im${i} ${io} 0 R >> >> /Contents ${co} 0 R >>\nendobj\n`);
    offs[co] = len; push(`${co} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
    offs[io] = len; push(`${io} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`);
    push(img.data); push("\nendstream\nendobj\n");
  }
  const d = new Date(), pd = "D:" + d.getFullYear() + [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, "0")).join("");
  offs[1] = len; push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offs[2] = len; push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  offs[3] = len; push(`3 0 obj\n<< /Title ${pdfStr(title)} /Creator ${pdfStr("CyberNote " + APP_VERSION)} /CreationDate (${pd}) >>\nendobj\n`);
  const size = 4 + 3 * n, xref = len;
  let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) x += String(offs[i]).padStart(10, "0") + " 00000 n \n";
  push(x + `trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
/* ZIP (tárolt, tömörítés nélkül – a JPEG úgyis tömörített) a .docx-hez */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(files) {
  const parts = [], cen = []; let off = 0;
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = u8(f.name), data = typeof f.data === "string" ? u8(f.data) : f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cdSize = cen.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
const xesc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
async function buildDocx(ids, title, progress) {
  const files = [], rels = [], body = [];
  const tw = mm => Math.round(mm * 56.6929), emu = mm => Math.round(mm * 36000), MARG = 10, HEAD = 9;
  for (let i = 0; i < ids.length; i++) {
    progress && progress(i, ids.length);
    const pg = await loadPage(ids[i]), img = await pageJpeg(pg), r = secOf(pg.id);
    files.push({ name: `word/media/lap${i + 1}.jpeg`, data: img.data });
    rels.push(`<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/lap${i + 1}.jpeg"/>`);
    const pw = pg.mmW || 210, ph = pw * pgH(pg) / W, land = pw > ph;
    const bw = pw - 2 * MARG, bh = ph - 2 * MARG - HEAD;
    let iw = bw, ih = bw * pgH(pg) / W; if (ih > bh) { ih = bh; iw = bh * W / pgH(pg); }
    const head = (r ? r.nb.name + " › " + r.sec.name + " › " : "") + pageNoOf(pg) + ". lap" + (pg.title ? " – " + pg.title : "");
    const sect = `<w:sectPr><w:pgSz w:w="${tw(pw)}" w:h="${tw(ph)}"${land ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${tw(MARG)}" w:right="${tw(MARG)}" w:bottom="${tw(MARG)}" w:left="${tw(MARG)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
    body.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xesc(head)}</w:t></w:r><w:r><w:rPr><w:color w:val="666666"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">   ${xesc(fmtDate(pg.created))}</w:t></w:r></w:p>`);
    const last = i === ids.length - 1;
    body.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>${last ? "" : sect}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu(iw)}" cy="${emu(ih)}"/><wp:docPr id="${i + 1}" name="Lap ${i + 1}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${i + 1}" name="lap${i + 1}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${i + 1}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(iw)}" cy="${emu(ih)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
    if (last) body.push(sect);
  }
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const doc = X + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join("")}</w:body></w:document>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  files.unshift(
    { name: "[Content_Types].xml", data: X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: "_rels/.rels", data: X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: "docProps/core.xml", data: X + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xesc(title)}</dc:title><dc:creator>CyberNote</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: "word/document.xml", data: doc },
    { name: "word/_rels/document.xml.rels", data: X + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>` });
  return zipStore(files);
}
const safeName = s => s.replace(/[\\/:*?"<>|]+/g, "_").trim();
function exportScope(scope) {
  const nb = S.nb, sec = S.sec, day = new Date().toISOString().slice(0, 10);
  if (scope === "page") return { ids: [S.page.id], name: `${safeName(nb.name)} – ${safeName(sec.name)} – ${pageNoOf(S.page)}. lap${S.page.title ? " – " + safeName(S.page.title) : ""}` };
  if (scope === "sec") return { ids: sec.pages.filter(id => S.pages.has(id)), name: `${safeName(nb.name)} – ${safeName(sec.name)} – ${day}` };
  return { ids: nbPages(nb).filter(id => S.pages.has(id)), name: `${safeName(nb.name)} – ${day}` };
}
async function exportDoc(kind, scope) {
  closePanels(); if (S.page) persistPage(S.page, true);
  await loadNotebookPages(S.nb);
  const { ids, name } = exportScope(scope), file = name.slice(0, 150) + (kind === "pdf" ? ".pdf" : ".docx");
  if (!ids.length) { toast("Nincs exportálható lap"); return; }
  try {
    busy(kind === "pdf" ? "PDF készítése…" : "Word-dokumentum készítése…");
    const prog = (i, n) => busy(`${kind === "pdf" ? "PDF" : "Word"}: ${i + 1}. / ${n} lap…`);
    const blob = kind === "pdf" ? await buildPdf(ids, name, prog) : await buildDocx(ids, name, prog);
    unbusy(); offerFile(blob, file);
  } catch (e) { console.error(e); unbusy(); logError("export", e && (e.stack || e.message)); toast("Az exportálás nem sikerült: " + (e && e.message)); }
}
function offerFile(blob, name) {
  const f = new File([blob], name, { type: blob.type });
  const size = (blob.size / 1048576).toFixed(1).replace(".", ",") + " MB";
  const btns = [["Mentés a Letöltésekbe", "pri", () => downloadBlob(blob, name)]];
  if (navigator.canShare && navigator.canShare({ files: [f] })) btns.unshift(["Megosztás…", "", () => navigator.share({ files: [f], title: name }).catch(() => {})]);
  dialog("Elkészült", `<p>${esc(name)} – ${size}</p>`, btns);
}
function downloadBlob(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast("Mentve: " + name); }
document.querySelectorAll("[data-exp]").forEach(b => b.onclick = () => { const [k, s] = b.dataset.exp.split(":"); exportDoc(k, s); });
function exportAsk(kind) {
  dialog(kind === "pdf" ? "Mentés PDF-be" : "Mentés Word-be (.docx)", "<p>Mit mentsek? Minden lap egy oldal lesz, a jegyzetcetlikkel és az importált PDF-háttérrel együtt.</p>",
    [["Mégse"], ["Teljes füzet", "", () => exportDoc(kind, "nb")], ["Szakasz", "", () => exportDoc(kind, "sec")], ["Aktuális lap", "pri", () => exportDoc(kind, "page")]]);
}
$("bExpPdfH").onclick = () => exportAsk("pdf"); $("bExpDocH").onclick = () => exportAsk("docx");

/* ================= Google Drive szinkron ================= */
const Sync = {
  token: null, exp: 0, timer: 0, running: false, needAuth: false, ids: null, lastOk: 0, err: "",
  async init() {
    this.ids = (await DB.get("kv", "drive")) || { root: null, lapok: null, index: null, open: null, summary: null, files: {}, bgs: {}, pushed: {} };
    this.ids.pdfs = this.ids.pdfs || {};
    try { const t = JSON.parse(localStorage.getItem("jf_tok") || "null"); if (t && t.exp > Date.now() + 60000) { this.token = t.tok; this.exp = t.exp; } } catch (e) {}
    this.fromRedirect();
    this.status();
    addEventListener("online", () => this.schedule(1000));
    addEventListener("offline", () => this.status());
    setInterval(() => this.schedule(0), 180000);
    document.addEventListener("visibilitychange", () => { if (document.hidden) { if (S.page) persistPage(S.page, true); if (this.token) this.run(); } });
    if (S.set.driveOn && S.set.clientId) { this.gis().catch(() => {}); this.schedule(1500); }
  },
  saveIds() { return DB.put("kv", this.ids, "drive"); },
  status(text) {
    const d = $("sdot"), st = $("status"); let k = "", msg, short;
    if (!S.set.driveOn || !S.set.clientId) { msg = "Csak ezen az eszközön mentve – Drive-szinkron: Fájl › Beállítások"; short = "Helyben"; }
    else if (text) { k = "busy"; msg = text; short = "Szinkron…"; }
    else if (!navigator.onLine) { k = "busy"; msg = "Offline – helyben mentve, később szinkronizál"; short = "Offline"; }
    else if (this.needAuth) { k = "err"; msg = "Drive: koppints ide a bejelentkezéshez"; short = "Bejelentkezés"; }
    else if (this.err) { k = "err"; msg = "Szinkron hiba: " + this.err; short = "Hiba"; }
    else { k = "ok"; msg = this.lastOk ? "Drive-ra mentve · " + fmtTime(this.lastOk) : "Drive-szinkron bekapcsolva"; short = this.lastOk ? "Mentve " + fmtTime(this.lastOk) : "Drive"; }
    if (k) d.dataset.s = k; else delete d.dataset.s;
    d.title = msg; d.setAttribute("aria-label", "Szinkron: " + msg); st.textContent = msg; $("sdotTxt").textContent = short; this.msg = msg;
  },
  schedule(ms) { if (!S.set.driveOn || !S.set.clientId) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms); },
  async gis() { if (!(window.google && google.accounts && google.accounts.oauth2)) await loadScript("https://accounts.google.com/gsi/client"); },
  /* Bejelentkezés ugyanazon a lapon (felugró ablak nélkül) – ott, ahol a böngésző a felugró ablakos módot megakasztja (popup_closed) */
  redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ""); },
  redirect() {
    try { if (S.page) persistPage(S.page, true); } catch (e) {}
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem("jf_oauth_state", st); } catch (e) {}
    const q = new URLSearchParams({ client_id: S.set.clientId, redirect_uri: this.redirectUri(), response_type: "token",
      scope: "https://www.googleapis.com/auth/drive.file", include_granted_scopes: "true", state: st });
    location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q);
    return new Promise(() => {});
  },
  fromRedirect() {
    const h = location.hash; if (!h || !/(access_token|error)=/.test(h)) return;
    const p = new URLSearchParams(h.slice(1)); let want = null;
    try { want = localStorage.getItem("jf_oauth_state"); localStorage.removeItem("jf_oauth_state"); } catch (e) {}
    history.replaceState(null, "", location.pathname + location.search);
    if (p.get("error")) { setTimeout(() => toast("A bejelentkezés nem sikerült: " + p.get("error")), 800); return; }
    if (!want || p.get("state") !== want) { setTimeout(() => toast("A bejelentkezés nem sikerült (ellenőrző kód eltér) – próbáld újra."), 800); return; }
    this.token = p.get("access_token"); this.exp = Date.now() + (+p.get("expires_in") || 3600) * 1000; this.needAuth = false;
    try { localStorage.setItem("jf_tok", JSON.stringify({ tok: this.token, exp: this.exp })); } catch (e) {}
    S.set.driveOn = true; S.set.authRedirect = true; saveSettings();
    setTimeout(() => toast("Bejelentkezve – szinkron indul"), 800);
  },
  async auth(interactive) {
    if (this.token && Date.now() < this.exp - 60000) return this.token;
    if (S.set.authRedirect) { if (interactive) return this.redirect(); throw Object.assign(new Error("Bejelentkezés szükséges"), { auth: true }); }
    try { return await this.authPopup(interactive); }
    catch (e) {
      if (interactive && /popup_closed|popup_failed_to_open/.test(e.message)) { S.set.authRedirect = true; saveSettings(); return this.redirect(); }
      throw e;
    }
  },
  async authPopup(interactive) {
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
    if (!this.ids.root) { this.ids = { root: null, lapok: null, index: null, open: null, summary: null, files: {}, bgs: {}, pdfs: {}, pushed: {} };
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
      if (pg && pg.updated <= ts) { S.pages.delete(id); await DB.del("pages", id); for (const nb of S.notebooks) for (const s of nb.sections) s.pages = s.pages.filter(x => x !== id); }
    }
    for (const [id, ts] of Object.entries(del.notebooks || {})) if (!S.deleted.notebooks[id]) {
      S.deleted.notebooks[id] = ts; const nb = nbOf(id); if (nb && nb.updated <= ts) S.notebooks = S.notebooks.filter(n => n.id !== id);
    }
    let changedCur = false;
    const rnbs = (remote.notebooks || []).map(n => normNb(clone(n)));
    if (rnbs.length) {
      const remoteIds = new Set(rnbs.map(n => n.id));
      S.notebooks = S.notebooks.filter(nb => { const ps = nbPages(nb); if (remoteIds.has(nb.id) || nb.name !== "Jegyzetek" || ps.length !== 1) return true;
        const pg = S.pages.get(ps[0]); const empty = pg && !pg.strokes.length && !pg.marks.length && !pg.bg && !(pg.notes || []).length;
        if (empty) { S.pages.delete(pg.id); DB.del("pages", pg.id); } return !empty; });
    }
    const keep = s => ({ ...s, pages: s.pages.filter(p => !S.deleted.pages[p]) });
    for (const rn of rnbs) {
      if (S.deleted.notebooks[rn.id]) continue;
      const ln = nbOf(rn.id);
      if (!ln) S.notebooks.push({ ...rn, sections: rn.sections.map(keep) });
      else if (rn.updated > ln.updated) { Object.assign(ln, rn, { sections: rn.sections.map(keep) }); if (S.nb === ln) changedCur = true; }
    }
    for (const [id, rp] of Object.entries(remote.pages || {})) {
      if (S.deleted.pages[id]) continue;
      const lp = S.pages.get(id) || await loadPage(id);
      if (lp && lp.updated >= rp.updated) continue;
      if (!rp.json) continue;
      const o = JSON.parse(await this.download(rp.json));
      if (o.bg && !(await DB.get("blobs", o.bg.id)) && rp.bgFile) { try { await DB.put("blobs", await this.download(rp.bgFile, true), o.bg.id); this.ids.bgs[o.bg.id] = rp.bgFile; } catch (e) { console.error(e); } }
      if (o.bg && o.bg.pdf && rp.pdfFile && !(await DB.get("blobs", o.bg.pdf))) { try { await DB.put("blobs", await this.download(rp.pdfFile, true), o.bg.pdf); this.ids.pdfs[o.bg.pdf] = rp.pdfFile; } catch (e) { console.error(e); } }
      const pg = deserializePage(o); S.pages.set(id, pg); await DB.put("pages", serializePage(pg));
      this.ids.files[id] = { json: rp.json, img: rp.img }; this.ids.pushed[id] = pg.updated;
      if (S.page && S.page.id === id) changedCur = true;
    }
    saveDeleted(); saveNotebooks();
    if (!S.notebooks.length) { S.notebooks.push(newNotebook("Jegyzetek", NB_COLORS[0], "grid")); saveNotebooks(); }
    if (!nbOf(S.nb && S.nb.id)) await openNotebook(S.notebooks[0].id);
    else if (changedCur || !nbPages(S.nb).includes(S.page && S.page.id)) { const keepId = S.page && S.page.id; if (S.page) S.page = S.pages.get(S.page.id) || null; await openNotebook(S.nb.id, keepId); }
    else { renderTree(); renderPageList(); updateOpenBadge(); }
  },
  async push() {
    for (const nb of S.notebooks) for (const sec of nb.sections) {
      for (const id of sec.pages) {
        const pg = S.pages.get(id) || await loadPage(id); if (!pg) continue;
        if ((this.ids.pushed[id] || 0) >= pg.updated && this.ids.files[id]) continue;
        const n = sec.pages.indexOf(id) + 1, base = `${safeName(nb.name)} – ${safeName(sec.name)} – ${String(n).padStart(3, "0")}`;
        if (pg.bg && !this.ids.bgs[pg.bg.id]) { const blob = await DB.get("blobs", pg.bg.id);
          if (blob) this.ids.bgs[pg.bg.id] = await this.upload(null, "hatter-" + pg.bg.id + (pg.bg.type === "image/png" ? ".png" : ".jpg"), pg.bg.type || "image/jpeg", blob, this.ids.lapok, { jf: "bg", bgId: pg.bg.id }); }
        if (pg.bg && pg.bg.pdf && !this.ids.pdfs[pg.bg.pdf]) { const blob = await DB.get("blobs", pg.bg.pdf);
          if (blob) this.ids.pdfs[pg.bg.pdf] = await this.upload(null, "pdf-" + pg.bg.pdf + ".pdf", "application/pdf", blob, this.ids.lapok, { jf: "pdf", pdfId: pg.bg.pdf }); }
        const f = this.ids.files[id] || {};
        const data = { ...serializePage(pg), notebookName: nb.name, sectionName: sec.name, pageNo: n };
        f.json = await this.upload(f.json, base + ".json", "application/json", JSON.stringify(data), this.ids.lapok, { jf: "page", pageId: id });
        const c = await renderPageCanvas(pg, 1240, false); const img = await jpegOf(c, .82); c.width = c.height = 0;
        f.img = await this.upload(f.img, base + ".jpg", "image/jpeg", img, this.ids.lapok, { jf: "pageimg", pageId: id });
        this.ids.files[id] = f; this.ids.pushed[id] = pg.updated; await this.saveIds();
      }
    }
    for (const id of Object.keys(S.deleted.pages)) { const f = this.ids.files[id]; if (f) { if (f.json) await this.trash(f.json); if (f.img) await this.trash(f.img); delete this.ids.files[id]; delete this.ids.pushed[id]; } }
  },
  buildIndex() {
    const pages = {};
    for (const nb of S.notebooks) for (const sec of nb.sections) sec.pages.forEach((id, i) => { const pg = S.pages.get(id), f = this.ids.files[id] || {};
      if (!pg) return;
      const ns = (pg.notes || []).flatMap(n => n.strokes);
      const lastInk = Math.max(pg.created, ...pg.strokes.map(s => s.mt || s.ts || 0), ...ns.map(s => s.mt || s.ts || 0), ...(pg.notes || []).map(n => n.mt || n.ts || 0), ...pg.marks.map(m => Math.max(m.ts || 0, m.dt || 0)));
      pages[id] = { nb: nb.id, notebookName: nb.name, sectionId: sec.id, sectionName: sec.name, pageNo: i + 1, title: pg.title || "", created: pg.created, updated: pg.updated, lastInk,
        notes: (pg.notes || []).length, json: f.json, img: f.img, bgFile: pg.bg ? this.ids.bgs[pg.bg.id] : undefined, pdfFile: pg.bg && pg.bg.pdf ? this.ids.pdfs[pg.bg.pdf] : undefined }; });
    return { v: 2, app: "CyberNote " + APP_VERSION, updated: Date.now(), timezone: "Europe/Budapest",
      notebooks: S.notebooks.map(n => ({ id: n.id, name: n.name, color: n.color, paper: n.paper, created: n.created, updated: n.updated,
        sections: n.sections.map(s => ({ id: s.id, name: s.name, color: s.color, created: s.created, pages: s.pages, ...(s.gal ? { gal: true } : {}), ...(s.pdf ? { pdf: true } : {}) })), pages: nbPages(n), contacts: n.contacts || [] })),
      pages, deleted: S.deleted };
  },
  buildOpen() {
    const items = [];
    for (const nb of S.notebooks) for (const sec of nb.sections) sec.pages.forEach((id, i) => { const pg = S.pages.get(id); if (!pg) return; const f = this.ids.files[id] || {}, ph = pgH(pg);
      for (const m of pg.marks) if (!m.done) { const r = itemRegion(pg, m);
        items.push({ tipus: m.k === "box" ? "feladat" : "kérdés", szoveg: m.text || null, fuzet: nb.name, szakasz: sec.name, lapszam: i + 1, lapcim: pg.title || null, letrehozva: new Date(m.ts).toISOString(),
          kepFajlId: f.img, kivagas_szazalek: { x0: +(r[0] / W * 100).toFixed(1), y0: +(r[1] / ph * 100).toFixed(1), x1: +(r[2] / W * 100).toFixed(1), y1: +(r[3] / ph * 100).toFixed(1) } }); } });
    return { leiras: "Nyitott feladatok és kérdések (füzet › szakasz › lapszám). Ha van szoveg, az a begépelt kérdés; egyébként a kézírás a lap képén (kepFajlId) a kivagas_szazalek téglalapban olvasható.", frissitve: new Date().toISOString(), tetelek: items };
  },
};
/* A Google-token óránként lejár; a frissítéshez felhasználói koppintás kell (felugró ablak), ezért menü-koppintáskor frissítünk */
let authing = false;
document.addEventListener("click", e => {
  if (!S.set.driveOn || !S.set.clientId || !navigator.onLine || authing) return;
  if (!e.target.closest("#top, .pop, #nav, #pagesCol")) return;
  if (Sync.token && Sync.exp - Date.now() > 5 * 60000) return;
  authing = true;
  Sync.auth(false).then(() => { Sync.needAuth = false; Sync.schedule(500); }).catch(() => { Sync.needAuth = true; Sync.status(); }).finally(() => { authing = false; });
}, true);
$("sdot").onclick = () => { if (!S.set.driveOn || !S.set.clientId) { settingsDialog(); return; }
  if (Sync.needAuth || !Sync.token || Sync.exp - Date.now() < 60000) { Sync.token = null; Sync.auth(true).then(() => { Sync.needAuth = false; Sync.run(); }).catch(() => { Sync.needAuth = true; Sync.status(); }); return; }
  toast(Sync.msg || "Szinkron…"); Sync.run(true); };
$("mSummary").onclick = () => {
  closePops();
  if (!S.set.driveOn || !S.set.clientId || !Sync.ids || !Sync.ids.root) {
    dialog("Napi összefoglalók", "<p>Az összefoglalók a Google Drive „Tervezői jegyzetfüzet / Napi összefoglalók” mappájába érkeznek. Ehhez előbb kapcsold be a szinkront a Beállításokban.</p>", [["Rendben", "pri"]]); return;
  }
  // Az összefoglalókat az ütemezett feladat hozza létre, az app ezeket nem látja (drive.file), ezért a Drive-mappát nyitjuk meg
  const a = document.createElement("a"); a.href = "https://drive.google.com/drive/folders/" + Sync.ids.root; a.target = "_blank"; a.rel = "noopener"; document.body.append(a); a.click(); a.remove();
};

/* ================= Beállítások ================= */
function settingsDialog() {
  closePops(); Sync.gis().catch(() => {});
  const body = document.createElement("div"); body.className = "dlgbody";
  body.innerHTML = `
    <strong>Google Drive szinkron</strong>
    <p>A lapok a Drive „Tervezői jegyzetfüzet” mappájába kerülnek (a mappa neve a meglévő szinkron miatt marad). Ebből készül a napi összefoglaló, és így a lapok más eszközön is elérhetők.</p>
    <label for="cid">OAuth kliensazonosító (Client ID)</label>
    <input type="text" id="cid" placeholder="….apps.googleusercontent.com" autocomplete="off" spellcheck="false">
    <p>Engedélyezett JavaScript-forrásnak ezt add meg a Google Cloudban: <code>${esc(location.origin)}</code></p>
    <p>Ha a bejelentkező ablak „popup_closed” hibát ad, az app ugyanazon a lapon jelentkeztet be. Ehhez a Google Cloudban az <em>Authorized redirect URIs</em> közé ezt is add hozzá: <code>${esc(Sync.redirectUri())}</code></p>
    <div class="seg"><button class="btn pri" id="dOn"></button><button class="btn" id="dNow">Szinkronizálás most</button></div>
    <p id="dState"></p>
    <strong>S Pen gomb teszt</strong>
    <p>Bekapcsolva a képernyő alján kiírja, mit jelez a toll. Írj a lapra lenyomott oldalsó gombbal, és küldd el a kiírt sort.</p>
    <div class="seg"><button class="tb" id="dbgBtn"></button></div>
    <strong>Hibanapló</strong>
    <p id="errInfo"></p>
    <div class="seg"><button class="tb" id="errShow">Megnézem</button><button class="tb" id="errClear">Törlés</button></div>
    <pre id="errText" class="errlog" hidden></pre>
    <strong>Program frissítése</strong>
    <p>Ha az app furcsán viselkedik: újratölti a programfájlokat. A jegyzeteid és beállításaid nem törlődnek.</p>
    <div class="seg"><button class="tb" id="hardReload">Program frissítése most</button></div>
    <p style="font-size:12px">Verzió: ${APP_VERSION}</p>`;
  const cid = body.querySelector("#cid"); cid.value = S.set.clientId || "";
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
  const errs = () => { try { return JSON.parse(localStorage.getItem(ERRLOG) || "[]"); } catch (_) { return []; } };
  const markErr = () => { const l = errs(); body.querySelector("#errInfo").textContent = l.length ? l.length + " bejegyzés, a legutóbbi: " + new Date(l[0].t).toLocaleString("hu-HU") : "Nincs rögzített hiba."; };
  body.querySelector("#errShow").onclick = () => { const pre = body.querySelector("#errText"), l = errs();
    pre.textContent = l.map(e => `${new Date(e.t).toLocaleString("hu-HU")} · ${e.v} · ${e.k}\n${e.m}`).join("\n\n") || "Nincs rögzített hiba."; pre.hidden = !pre.hidden; };
  body.querySelector("#errClear").onclick = () => { try { localStorage.removeItem(ERRLOG); } catch (_) {} markErr(); body.querySelector("#errText").hidden = true; };
  body.querySelector("#hardReload").onclick = () => hardReload();
  markDrive(); markDbg(); markErr();
  dialog("Beállítások és szinkron", body, [["Kész", "pri"]]);
}
$("mSettings").onclick = settingsDialog;

/* ================= Párbeszéd, értesítés ================= */
function dialog(title, body, buttons) {
  $("dlgTitle").textContent = title; const b = $("dlgBody"); b.textContent = "";
  if (typeof body === "string") b.innerHTML = body; else b.append(body);
  const row = $("dlgBtns"); row.textContent = "";
  for (const [label, kind, fn] of buttons) { const btn = document.createElement("button"); btn.className = "btn" + (kind === "pri" ? " pri" : kind === "dan" ? " dan" : ""); btn.textContent = label;
    btn.onclick = () => { if (fn && fn() === false) return; $("dlg").hidden = true; }; row.append(btn); }
  $("dlg").hidden = false;
}
let tt; function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2600); }
function busy(m) { $("busyText").textContent = m; $("busy").hidden = false; }
function unbusy() { $("busy").hidden = true; }

/* ================= Billentyűk, átméretezés ================= */
document.addEventListener("keydown", e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const c = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (c && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (c && k === "y") { e.preventDefault(); redo(); }
  else if (c && (k === "+" || k === "=")) { e.preventDefault(); $("zIn").click(); }
  else if (c && k === "-") { e.preventDefault(); $("zOut").click(); }
  else if (c && k === "0") { e.preventDefault(); $("zFitW").click(); }
  else if (e.key === "PageDown" || e.key === "ArrowRight" && e.altKey) go(1);
  else if (e.key === "PageUp" || e.key === "ArrowLeft" && e.altKey) go(-1);
  else if (e.key === "Escape") { closePops(); clearSel(); hideNoteBar(); }
});
let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { checkNarrow(); layout(); }, 120); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawPaper);
addEventListener("pagehide", () => { if (S.page) persistPage(S.page, true); });

/* Programfájlok frissítése: a service worker és a gyorsítótár törlése, majd újratöltés – az IndexedDB-ben lévő jegyzetek maradnak */
async function hardReload() {
  try { if (S.page) await persistPage(S.page, true); } catch (_) {}
  try { const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : []; await Promise.all(regs.map(r => r.unregister())); } catch (_) {}
  try { if (window.caches) { const k = await caches.keys(); await Promise.all(k.map(n => caches.delete(n))); } } catch (_) {}
  location.reload();
}
function fatal(e) {
  logError("indulás", e && (e.stack || e.message) || e);
  const d = document.createElement("div"); d.className = "fatal";
  d.innerHTML = `<div class="fbox"><h3>Az app nem tudott elindulni</h3><p>A jegyzeteid megvannak ezen az eszközön (és a Drive-on, ha a szinkron be volt kapcsolva). Próbáld a programfájlok frissítését.</p>
    <pre></pre><div class="acts"><button class="btn" id="fRe">Újratöltés</button><button class="btn pri" id="fHard">Program frissítése</button></div></div>`;
  d.querySelector("pre").textContent = String(e && (e.message || e));
  document.body.append(d); d.querySelector("#fRe").onclick = () => location.reload(); d.querySelector("#fHard").onclick = () => hardReload();
}

/* ================= Indulás ================= */
async function start() {
  try { await DB.open(); } catch (e) { toast("A tároló nem nyitható meg: " + e.message); return; }
  S.set = { ...DEF_SET, ...((await DB.get("kv", "settings")) || {}) };
  for (const k of ["lastSec", "lastPage", "navOpen"]) if (!S.set[k] || typeof S.set[k] !== "object") S.set[k] = {};
  S.notebooks = ((await DB.get("kv", "notebooks")) || []).map(normNb);
  S.deleted = (await DB.get("kv", "deleted")) || { pages: {}, notebooks: {} };
  if (!S.notebooks.length) S.notebooks.push(newNotebook("Jegyzetek", NB_COLORS[0], "grid"));
  await saveNotebooks();
  narrow = innerWidth < 900; navVis = !narrow && S.set.navOn !== false; pagesVis = !narrow && S.set.pagesOn !== false;
  applyPanes(true); setTab(S.set.tab || "draw"); document.body.classList.toggle("ribbon-off", !!S.set.ribbonOff); $("bRibbon").setAttribute("aria-pressed", String(!!S.set.ribbonOff));
  setTool("pen"); layout();
  await openNotebook(nbOf(S.set.lastNb) ? S.set.lastNb : S.notebooks[0].id);
  for (const nb of S.notebooks) loadNotebookPages(nb).then(() => { updateOpenBadge(); renderListsSoon(); }).catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await Sync.init();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
      if (!reg) return;
      reg.addEventListener("updatefound", () => { const w = reg.installing; if (!w) return;
        w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) toast("Új verzió letöltve – a következő indításkor él."); }); });
    }).catch(console.error);
  }
}
start().catch(fatal);
window.__jf = { S, V, Sync, W, H0, MM, buildPdf, buildDocx, render, layout, addNote }; // hibakereséshez és teszthez
})();

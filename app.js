const VER = '1.5.0';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } };
const STAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>';
const LOCK = '<svg class="lk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const UNLOCK = '<svg class="lk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';
const CLOUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/></svg>';
const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>';
const shake = el => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };
async function flash(btn, html, ms = 1200) { const h = btn.innerHTML; btn.innerHTML = html; setTimeout(() => btn.innerHTML = h, ms); }

/* ===== サーバー ===== */
let S = null, online = false;
const ready = (async () => {
  try { S = await import(`./server.js?v=${VER}`); online = !!(await S.init()); } catch (e) { console.warn(e); online = false; }
  const av = online && S.apiVersion ? S.apiVersion() : null;
  $('#ver').textContent = `ver ${VER}` + (!online ? ' · 未接続' : av !== VER ? ` · API ${av || '旧'}` : '');
  $('#ver').classList.toggle('off', !online || av !== VER);
  $('#pubBtn').disabled = !online; tickJ();
  return online;
})();

/* ===== 画面切替 ===== */
let mode = 'host', view = 'pack';
function show() {
  $$('#mode button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === mode));
  $$('#hsub button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === view));
  $('#host').hidden = mode !== 'host'; $('#judge').hidden = mode !== 'judge';
  for (const v of ['pack', 'pub', 'tally']) $('#' + v).hidden = view !== v;
  $('#barPack').hidden = !(mode === 'host' && view === 'pack');
  $('#barPub').hidden = !(mode === 'host' && view === 'pub');
  $('#barTally').hidden = !(mode === 'host' && view === 'tally');
  $('#barJudge').hidden = !(mode === 'judge' && J.room);
  const h = mode === 'judge' ? 'judge' : view;
  if (location.hash.slice(1) !== h) history.replaceState(null, '', '#' + h);
  if (mode === 'host' && view === 'pub') refreshMyRooms();
  if (mode === 'judge') startLobby();
}
function fromHash() { const h = location.hash.slice(1); if (h === 'judge') mode = 'judge'; else { mode = 'host'; if (['pack', 'pub', 'tally'].includes(h)) view = h; } show(); }
$$('#mode button').forEach(b => b.onclick = () => { mode = b.dataset.m; show(); });
$$('#hsub button').forEach(b => b.onclick = () => { view = b.dataset.v; show(); });
addEventListener('hashchange', fromHash);

/* ===== 01 パック ===== */
// 端末内保存（音源を含むので IndexedDB）
const IDB = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((res, rej) => {
      const r = indexedDB.open('taikai', 2);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async tx(store, mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction(store, mode), o = fn(t.objectStore(store)); t.oncomplete = () => res(o && o.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); },
  get(k) { return this.tx('kv', 'readonly', st => st.get(k)); },
  set(k, v) { return this.tx('kv', 'readwrite', st => { st.put(v, k); }); },
  allFiles() { return this.tx('files', 'readonly', st => st.getAll()); },
  putFiles(list) { return this.tx('files', 'readwrite', st => { for (const f of list) st.put({ path: f.path, blob: new Blob([f.data]) }); }); },
  clearFiles() { return this.tx('files', 'readwrite', st => { st.clear(); }); }
};
function storeErr(e) { console.warn(e); msgs = [...msgs.filter(m => !m.startsWith('端末')), '端末に保存できませんでした（容量不足の可能性があります）']; $('#msg').innerHTML = msgs.map(m => `<div>${esc(m)}</div>`).join(''); }
let persistAsked = false;
function saveFiles(added) {
  if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
  (added ? IDB.putFiles(added) : IDB.clearFiles()).catch(storeErr);
}
let seed = {}, restoring = true, metaT = null;
function saveMeta() {
  if (restoring) return;
  clearTimeout(metaT);
  metaT = setTimeout(() => IDB.set('packmeta', {
    root: $('#root').value, prefix: $('#prefix').checked, dropSub: $('#dropSub').checked, am, audioName: $('#audioName').value,
    order, edits: Object.fromEntries(charts.map(c => [c.id, { group: c.group, author: c.author }]))
  }).catch(storeErr), 300);
}
let files = [], charts = [], order = [], msgs = [], am = 'match';
const AUDIO = /\.(ogg|mp3|wav|opus|flac)$/i;
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|\._|Thumbs\.db$)/;
async function addFiles(list) {
  msgs = []; const n0 = files.length;
  for (const f of list) {
    if (JUNK.test(f.name)) continue;
    const data = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      try { const zb = f.name.replace(/\.zip$/i, ''); for (const x of await readZip(data)) if (!JUNK.test(x.path)) files.push({ path: zb + '/' + x.path, data: x.data }); }
      catch (e) { msgs.push(`${f.name}：読み込めません`); }
    } else files.push({ path: f.name, data });
  }
  rebuild(); saveFiles(files.slice(n0));
}
function rebuild() {
  const prev = new Map(charts.map(c => [c.id, c])), dirs = new Map();
  for (const f of files) { const i = f.path.lastIndexOf('/'), d = i < 0 ? '' : f.path.slice(0, i); if (!dirs.has(d)) dirs.set(d, []); dirs.get(d).push(f); }
  charts = [];
  for (const [d, fs] of dirs) {
    const tjas = fs.filter(f => /\.tja$/i.test(f.path)), auds = fs.filter(f => AUDIO.test(f.path));
    for (const t of tjas) {
      const name = t.path.slice(t.path.lastIndexOf('/') + 1), { text, enc } = decodeText(t.data);
      const fn = authorFromName(name.replace(/\.tja$/i, '')), title = headerVal(text, 'TITLE') || fn.title, wave = headerVal(text, 'WAVE');
      const a = auds.find(x => wave && (x.path.endsWith('/' + wave) || x.path === wave)) || auds[0], old = prev.get(t.path) || seed[t.path];
      charts.push({ id: t.path, dir: d, file: name, text, enc, group: old ? old.group : title.trim(), author: old ? old.author : fn.author, audio: a ? { name: a.path.split('/').pop(), data: a.data } : null });
    }
  }
  const ids = charts.map(c => c.id);
  if (ids.length !== order.length || ids.some(id => !order.includes(id))) shuffle(false);
  render();
}
function shuffle(r = true) {
  order = charts.map(c => c.id);
  const rnd = new Uint32Array(order.length); crypto.getRandomValues(rnd);
  for (let i = order.length - 1; i > 0; i--) { const j = rnd[i] % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  if (r) render();
}
const opt = () => ({ prefix: $('#prefix').checked, audioMode: am, audioName: $('#audioName').value });
function render() {
  const plan = makePlan(charts, order, opt()), n = charts.length, g = new Set(plan.map(p => p.chart.group.trim())).size, has = n > 0;
  $('#drop').classList.toggle('mini', has); $('#clear').hidden = !has; $('#packBody').hidden = !has;
  $('#dropT').innerHTML = has ? `<span class="cnt">${n}</span>譜面 <span class="cnt">${g}</span>曲` : 'TJA・音源・ZIP';
  $('#msg').innerHTML = msgs.map(m => `<div>${esc(m)}</div>`).join('');
  $('#list').innerHTML = plan.map(p => `<div class="it">
    <div class="no">${p.n}</div>
    <div>${p.label ? `<span class="lab">${p.label}</span>` : '<span class="lab x"></span>'}</div>
    <input type="text" data-g="${esc(p.id)}" value="${esc(p.chart.group)}" aria-label="曲名">
    <input type="text" class="au" data-a="${esc(p.id)}" value="${esc(p.chart.author)}" placeholder="作成者" aria-label="作成者">
    <div class="src"><button class="vw" data-view="${esc(p.id)}">TJA</button><span>${esc((p.chart.dir ? p.chart.dir + '/' : '') + p.chart.file)}</span>${p.chart.audio ? `<span>♪ ${esc(p.audioName)}</span>` : '<span class="bad">♪ 音源なし</span>'}</div>
  </div>`).join('');
  if (pv === 'files') renderTree(plan);
  ['dlZip', 'dlJson', 'toPub', 'shuffle'].forEach(id => $('#' + id).disabled = !has);
  saveMeta();
}
/* 中身の確認 */
let pv = 'order', sheetId = null, sheetMode = 'out';
const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const outText = p => transformTja(p.chart.text, { title: p.display, wave: p.audioName, dropSub: $('#dropSub').checked });
function renderTree(plan) {
  const root = rootName(); let total = 0, count = 0;
  const rows = plan.map(p => {
    const t = encodeSJIS(outText(p)).length, a = p.chart.audio ? p.chart.audio.data.length : 0;
    total += t + a; count += p.chart.audio ? 2 : 1;
    return `<div class="tr fd"><span>${esc(p.folder)}/</span></div>
      <button class="tr fl" data-view="${esc(p.id)}"><span>${esc(p.base)}.tja</span><small>${kb(t)}</small></button>
      ${p.chart.audio ? `<div class="tr fl au"><span>${esc(p.audioName)}</span><small>${kb(a)}</small></div>` : ''}`;
  }).join('');
  $('#tree').innerHTML = `<div class="tr rt"><span>${esc(root)}/</span><small>${count}ファイル・${kb(total)}</small></div>${rows}`;
}
$$('#pv button').forEach(b => b.onclick = () => { pv = b.dataset.p; $$('#pv button').forEach(x => x.setAttribute('aria-pressed', x === b)); $('#list').hidden = pv !== 'order'; $('#tree').hidden = pv !== 'files'; render(); });
function openSheet(id) { sheetId = id; $('#sheet').hidden = false; document.body.style.overflow = 'hidden'; drawSheet(); }
function closeSheet() { sheetId = null; $('#sheet').hidden = true; document.body.style.overflow = ''; }
function drawSheet() {
  const p = makePlan(charts, order, opt()).find(x => x.id === sheetId); if (!p) return closeSheet();
  $('#shT').textContent = sheetMode === 'out' ? `${p.folder}/${p.base}.tja` : (p.chart.dir ? p.chart.dir + '/' : '') + p.chart.file;
  $$('#shSeg button').forEach(x => x.setAttribute('aria-pressed', x.dataset.s === sheetMode));
  const lines = (sheetMode === 'out' ? outText(p) : p.chart.text).split(/\r?\n/);
  $('#shB').innerHTML = lines.map((l, i) => `<span class="ln">${i + 1}</span>${esc(l) || ' '}`).join('\n');
  $('#shE').textContent = sheetMode === 'out' ? 'Shift_JIS' : p.chart.enc;
}
document.addEventListener('click', e => { const v = e.target.closest('[data-view]'); if (v) openSheet(v.dataset.view); });
$$('#shSeg button').forEach(b => b.onclick = () => { sheetMode = b.dataset.s; drawSheet(); });
$('#shX').onclick = closeSheet;
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && sheetId) closeSheet(); });
$('#list').addEventListener('change', e => { const g = e.target.dataset.g; if (g) { charts.find(x => x.id === g).group = e.target.value; render(); } });
$('#list').addEventListener('input', e => { const a = e.target.dataset.a; if (a) { charts.find(x => x.id === a).author = e.target.value; saveMeta(); } });
['#root', '#dropSub'].forEach(q => $(q).addEventListener('input', saveMeta));
$('#dropSub').addEventListener('change', saveMeta);
$('#prefix').addEventListener('change', render);
$('#audioName').addEventListener('input', render);
$$('#am button').forEach(b => b.onclick = () => { am = b.dataset.a; $$('#am button').forEach(x => x.setAttribute('aria-pressed', x === b)); $('#audioName').hidden = am !== 'fixed'; render(); });
$('#fFiles').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#clear').onclick = () => { files = []; charts = []; order = []; msgs = []; render(); saveFiles(); closeSheet(); };
$('#shuffle').onclick = () => shuffle();
const dz = $('#drop');
['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add('on'); }));
['dragleave', 'drop'].forEach(t => dz.addEventListener(t, () => dz.classList.remove('on')));
dz.addEventListener('drop', e => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });

function save(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove(); }
  if (btn) flash(btn, '✓');
}
const rootName = () => safeName($('#root').value || '譜面パック');
const mapping = () => makePlan(charts, order, opt()).map(p => ({ order: p.n, label: p.label, title: p.display, author: p.chart.author, source: (p.chart.dir ? p.chart.dir + '/' : '') + p.chart.file }));
const songLine = m => `${m.title}${m.author ? ' / ' + m.author : ''}`;
function fillSongs() { $('#songs').value = mapping().map(songLine).join('\n'); saveH(); }
$('#dlZip').onclick = () => {
  const root = rootName(), dropSub = $('#dropSub').checked, out = [];
  for (const p of makePlan(charts, order, opt())) {
    out.push({ path: `${root}/${p.folder}/${p.base}.tja`, data: encodeSJIS(transformTja(p.chart.text, { title: p.display, wave: p.audioName, dropSub })) });
    if (p.chart.audio) out.push({ path: `${root}/${p.folder}/${p.audioName}`, data: p.chart.audio.data });
  }
  fillSongs();
  save(root + '.zip', new Blob(makeZip(out), { type: 'application/zip' }));
};
$('#dlJson').onclick = () => { fillSongs(); save(rootName() + '_対応表.json', new Blob([JSON.stringify({ pack: rootName(), songs: mapping() }, null, 2)], { type: 'application/json' })); };
$('#toPub').onclick = () => { fillSongs(); if (!$('#pName').value.trim()) $('#pName').value = $('#root').value; saveH(); view = 'pub'; show(); };

/* ===== 02 公開 ===== */
const H = Object.assign({ roomId: null, name: '', pass: '', songs: '', open: true, pubPass: null, scorers: [], startAt: null, endAt: null }, store('taikai-host') || {});
const toLocal = ms => { if (!ms) return ''; const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocal = v => { if (!v) return null; const t = new Date(v).getTime(); return isFinite(t) ? t : null; };
function setTimes() { $('#pStart').value = toLocal(H.startAt); $('#pEnd').value = toLocal(H.endAt); }
$('#pName').value = H.name; $('#pPass').value = H.pass; $('#songs').value = H.songs; $('#pOpen').checked = H.open; setTimes();
function saveH() { Object.assign(H, { name: $('#pName').value, pass: $('#pPass').value, songs: $('#songs').value, open: $('#pOpen').checked, startAt: fromLocal($('#pStart').value), endAt: fromLocal($('#pEnd').value) }); store('taikai-host', H); updPubBtn(); }
['#pName', '#pPass', '#songs', '#pStart', '#pEnd'].forEach(s => $(s).addEventListener('input', saveH));
$$('[data-clr]').forEach(b => b.onclick = () => { $('#' + b.dataset.clr).value = ''; saveH(); });
function updPubBtn() { $('#pubBtn').textContent = H.roomId ? '更新' : '公開'; }
let myList = [];
async function refreshMyRooms() {
  if (!(await ready)) { $('#myRooms').innerHTML = ''; return; }
  try { myList = await S.myRooms(); } catch (e) { myList = []; }
  $('#myRooms').innerHTML = myList.map(r => `<button class="chip" data-r="${esc(r.id)}" aria-pressed="${r.id === H.roomId}">${r.open ? '<i class="d"></i>' : ''}${esc(r.name || '無題')}</button>`).join('')
    + `<button class="chip new" data-r="" aria-pressed="${!H.roomId}">＋</button>`;
}
$('#myRooms').addEventListener('click', async e => {
  const b = e.target.closest('[data-r]'); if (!b) return;
  const id = b.dataset.r;
  if (!id) { Object.assign(H, { roomId: null, name: '', pass: '', songs: H.songs, open: true, pubPass: null, startAt: null, endAt: null }); $('#pName').value = ''; $('#pPass').value = ''; $('#pOpen').checked = true; setTimes(); }
  else {
    const r = await S.loadRoom(id); if (!r) return;
    const authors = r.authors || [];
    Object.assign(H, { roomId: id, name: r.name || '', pass: r.pass || '', open: !!r.open, pubPass: r.pass || '', startAt: r.startAt || null, endAt: r.endAt || null }); setTimes();
    H.songs = (r.titles || []).map((t, i) => t + (authors[i] ? ' / ' + authors[i] : '')).join('\n');
    $('#pName').value = H.name; $('#pPass').value = H.pass; $('#songs').value = H.songs; $('#pOpen').checked = H.open;
  }
  saveH(); watch(); refreshMyRooms();
});
$('#pOpen').addEventListener('change', async () => {
  saveH();
  if (H.roomId && await ready) { try { await S.setOpen(H.roomId, H.open); refreshMyRooms(); } catch (e) { $('#pOpen').checked = !H.open; saveH(); } }
});
$('#pubBtn').onclick = async e => {
  const btn = e.currentTarget, songs = parseSongs($('#songs').value);
  if (!$('#pName').value.trim()) { shake($('#pName')); $('#pName').focus(); return; }
  if (!songs.length) { shake($('#songs')); $('#songs').focus(); return; }
  saveH();
  if (H.startAt && H.endAt && H.endAt <= H.startAt) { shake($('#pEnd')); return; }
  btn.disabled = true;
  try {
    H.roomId = await S.publish({ roomId: H.roomId, name: $('#pName').value.trim(), pass: $('#pPass').value.trim(), titles: songs.map(s => s.name), authors: songs.map(s => s.author), open: $('#pOpen').checked, startAt: H.startAt, endAt: H.endAt });
    H.pubPass = $('#pPass').value.trim(); saveH(); watch(); refreshMyRooms();
    flash(btn, '✓ 公開済み', 1600);
  } catch (er) { console.error(er); flash(btn, '失敗しました', 1600); }
  btn.disabled = false;
};

/* 提出の受信 */
let unsub = null, subs = [];
async function watch() {
  if (unsub) { unsub(); unsub = null; }
  subs = []; renderSubs();
  if (!H.roomId || H.pubPass == null || !(await ready)) return;
  unsub = await S.watchSubs(H.roomId, H.pubPass, list => { subs = list; renderSubs(); syncScorers(); });
}
function renderSubs() {
  $('#subN').textContent = subs.length;
  $('#who').innerHTML = subs.map(s => `<span>${esc(s.name)}</span>`).join('');
}
const subText = s => (s.scores || []).map(x => x == null || x.v == null || x.v === '' ? '-' : x.v + (x.fav ? '○' : '')).join('\n');
function syncScorers() {
  const manual = scorers.filter(s => !s.uid);
  scorers = [...subs.map(s => ({ uid: s.uid, name: s.name, text: subText(s) })), ...manual];
  renderSc(); saveSc();
}

/* ===== 03 集計 ===== */
let scorers = H.scorers && H.scorers.length ? H.scorers : [];
function saveSc() { H.scorers = scorers; store('taikai-host', H); }
function renderSc() {
  $('#scs').innerHTML = scorers.map((s, i) => `<div class="s"><div class="h">${s.uid ? CLOUD : ''}<input type="text" data-n="${i}" value="${esc(s.name)}" aria-label="採点者名" ${s.uid ? 'readonly' : ''}>${s.uid ? '' : `<button data-x="${i}" aria-label="削除">×</button>`}</div><textarea data-t="${i}" rows="10" placeholder="71\n72\n74○" ${s.uid ? 'readonly' : ''}>${esc(s.text)}</textarea></div>`).join('')
    + '<button class="add" id="addSc" aria-label="採点者を追加">＋</button>';
}
$('#scs').addEventListener('input', e => { const d = e.target.dataset; if (d.n != null) scorers[d.n].name = e.target.value; if (d.t != null) scorers[d.t].text = e.target.value; saveSc(); });
$('#scs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'addSc') { scorers.push({ name: `採点者${scorers.filter(s => !s.uid).length + 1}`, text: '' }); renderSc(); saveSc(); $$('#scs textarea').pop().focus(); }
  else if (b.dataset.x != null) { scorers.splice(+b.dataset.x, 1); renderSc(); saveSc(); }
});
$('#fJson').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const j = JSON.parse(await f.text()); $('#songs').value = (j.songs || []).sort((a, b) => a.order - b.order).map(songLine).join('\n'); saveH(); }
  catch (er) { shake($('#songs')); }
};
let lastText = '';
$('#run').onclick = () => {
  const songs = parseSongs($('#songs').value);
  if (!songs.length) { view = 'pub'; show(); shake($('#songs')); return; }
  const { rows, warns } = aggregate(songs, scorers), texts = rows.map(formatRow);
  lastText = texts.join('\n\n');
  $('#warns').innerHTML = warns.map(w => `<div>${esc(w)}</div>`).join('');
  $('#out').innerHTML = rows.map((r, k) => `<div class="cd${r.rank === 1 ? ' top' : ''}">
    <div class="rk">${r.rank}<small>位</small></div>
    <h3>${esc(r.name)}${r.author ? ` <span>/ ${esc(r.author)}</span>` : ''}</h3>
    <button class="btn cp" data-c="${k}" aria-label="コピー">${COPY}</button>
    <div class="st"><div>平均<b>${fmt2(r.mean)}</b></div><div>お気に入り<b>${r.favs}</b></div><div>標準偏差<b>${fmt2(r.sd)}</b></div><div>MAX<b>${r.maxes}</b></div></div>
    <div class="sv">${[...r.ents].sort((a, b) => b.v - a.v).map(e => `<span class="${e.fav ? 'f ' : ''}${e.max ? 'm' : ''}">${esc(e.v)}</span>`).join('')}</div>
  </div>`).join('');
  $$('#out [data-c]').forEach(b => b.onclick = () => copy(texts[b.dataset.c], b));
  $('#resWrap').hidden = false; $('#copyAll').disabled = false;
  $('#resWrap').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
};
$('#copyAll').onclick = e => copy(lastText, e.currentTarget);

/* ===== 評価モード ===== */
const pad = n => String(n).padStart(2, '0');
const fmtAt = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtLeft = ms => { const t = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), x = t % 60; return h >= 24 ? `${Math.floor(h / 24)}日 ${h % 24}時間` : `${h ? h + ':' : ''}${pad(m)}:${pad(x)}`; };
const J = { room: null, key: null, titles: [], sc: [], sent: false, editing: false, startAt: null, endAt: null, skew: 0 };
$('#jName').value = store('taikai-jname') || '';
let lobbyOff = null, openRooms = [], openId = null, lobbySkew = 0;
async function startLobby() {
  if (lobbyOff || !(await ready)) { if (!online) $('#openRooms').innerHTML = '<div class="empty">未接続</div>'; return; }
  lobbyOff = S.watchOpenRooms(list => { openRooms = list; if (list[0] && list[0].now) lobbySkew = list[0].now - Date.now(); renderLobby(); });
}
function roomWhen(r, skew) {
  const now = Date.now() + skew;
  if (r.startAt && now < r.startAt) return `<span class="when wait">${fmtAt(r.startAt)} 開始</span>`;
  if (r.endAt) return `<span class="when">${fmtAt(r.endAt)} 締切</span>`;
  return '';
}
function renderLobby() {
  const focused = document.activeElement && document.activeElement.name === 'p' ? document.activeElement.value : null;
  $('#openRooms').innerHTML = openRooms.length ? openRooms.map(r => `<div class="rc">
    <button data-o="${esc(r.id)}"><span class="nm"><h3>${esc(r.name || '無題')}</h3>${roomWhen(r, lobbySkew)}</span><span class="c">${r.count || 0}<small>曲</small></span>${r.hasPass ? (store('taikai-pass-' + r.id) ? UNLOCK : LOCK) : '<span></span>'}</button>
    ${r.hasPass && openId === r.id ? `<form data-p="${esc(r.id)}"><input type="text" name="p" placeholder="あいことば" aria-label="あいことば" autocomplete="off"><button class="btn ink">入る</button></form>` : ''}
  </div>`).join('') : '<div class="empty">公開中の大会はありません</div>';
  const f = $('#openRooms form'); if (f) { if (focused != null) f.p.value = focused; f.p.focus(); }
}
$('#openRooms').addEventListener('click', e => {
  const b = e.target.closest('[data-o]'); if (!b) return;
  const r = openRooms.find(x => x.id === b.dataset.o); if (!r) return;
  if (!r.hasPass) return join(r, '');
  const saved = store('taikai-pass-' + r.id);
  if (saved && openId !== r.id) return join(r, saved).then(ok => { if (!ok) { store('taikai-pass-' + r.id, ''); openId = r.id; renderLobby(); } });
  openId = openId === r.id ? null : r.id; renderLobby();
});
$('#openRooms').addEventListener('submit', e => {
  e.preventDefault();
  const r = openRooms.find(x => x.id === e.target.dataset.p); if (r) join(r, e.target.p.value, e.target);
});
async function join(r, pass, form) {
  let res = null;
  try { res = await S.enter(r.id, pass); } catch (er) { res = null; }
  if (!res) { if (form) { form.p.classList.add('ng'); shake(form); form.p.select(); } return false; }
  if (r.hasPass) store('taikai-pass-' + r.id, pass);
  const draft = store('taikai-j-' + r.id);
  Object.assign(J, { room: r, key: res.key, titles: res.titles, sent: !!res.mine, editing: false, startAt: res.startAt || null, endAt: res.endAt || null, skew: res.now ? res.now - Date.now() : 0 });
  J.sc = res.mine ? res.mine.scores.map(x => ({ v: x.v == null ? '' : String(x.v), fav: !!x.fav })) : (draft || []);
  if (res.mine) $('#jName').value = res.mine.name;
  if (lobbyOff) { lobbyOff(); lobbyOff = null; }
  $('#lobby').hidden = true; $('#jroom').hidden = false; $('#jTitle').textContent = r.name || '無題';
  $('#roster').innerHTML = (res.roster || []).map(n => `<span>${esc(n)}</span>`).join('');
  $('#rosterWrap').hidden = !(res.roster || []).length;
  renderJ(); show();
  return true;
}
$('#jBack').onclick = () => { J.room = null; $('#lobby').hidden = false; $('#jroom').hidden = true; openId = null; show(); };
function renderJ() {
  $('#jl').innerHTML = J.titles.map((t, i) => { const s = J.sc[i] || {}; return `<div class="jr" data-i="${i}">
    <div class="no">${i + 1}</div><div class="tg">MAX</div>
    <div class="tt">${esc(t)}</div>
    <input type="text" inputmode="decimal" enterkeyhint="next" data-j="${i}" value="${esc(s.v ?? '')}" aria-label="${i + 1}曲目の点数">
    <button class="fv" data-f="${i}" aria-pressed="${!!s.fav}" aria-label="お気に入り">${STAR}</button>
  </div>`; }).join('');
  updJ(); tickJ();
}
const numOf = v => { const s = String(v ?? '').normalize('NFKC').trim(); return s !== '' && isFinite(Number(s)) ? Number(s) : null; };
const phase = () => { const now = Date.now() + J.skew; return J.startAt && now < J.startAt ? 'wait' : J.endAt && now >= J.endAt ? 'end' : 'open'; };
const locked = () => phase() === 'end' || (J.sent && !J.editing);
function updJ() {
  const nums = J.titles.map((_, i) => numOf(J.sc[i] && J.sc[i].v)), vals = nums.filter(x => x != null);
  const mx = vals.length ? Math.max(...vals) : null;
  $$('#jl .jr').forEach(r => r.classList.toggle('mx', mx != null && nums[r.dataset.i] === mx));
  $('#jProg').innerHTML = `<b>${vals.length}</b>/${J.titles.length}`;
  if (J.room) store('taikai-j-' + J.room.id, J.sc);
}
let sending = false;
function tickJ() {
  if (!J.room) return;
  const ph = phase(), lk = locked(), now = Date.now() + J.skew, b = $('#jSend');
  $('#jroom').classList.toggle('locked', lk);
  $$('#jl input').forEach(x => x.readOnly = lk); $$('#jl .fv').forEach(x => x.disabled = lk); $('#jName').readOnly = lk;
  $('#jTime').textContent = ph === 'wait' ? `開始まで ${fmtLeft(J.startAt - now)}` : ph === 'open' && J.endAt ? `締切まで ${fmtLeft(J.endAt - now)}` : '';
  if (sending) return;
  b.className = 'btn ' + (ph === 'open' && lk ? '' : 'pri');
  b.disabled = !online || ph !== 'open';
  b.textContent = ph === 'wait' ? '開始前' : ph === 'end' ? '締切' : lk ? '修正' : J.sent ? '更新' : '送信';
}
setInterval(tickJ, 1000);
$('#jl').addEventListener('input', e => { const i = e.target.dataset.j; if (i != null) { J.sc[i] = { ...(J.sc[i] || {}), v: e.target.value }; updJ(); } });
$('#jl').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.j != null) { e.preventDefault(); const nx = $(`#jl [data-j="${+e.target.dataset.j + 1}"]`); nx ? nx.focus() : e.target.blur(); } });
$('#jl').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b || locked()) return; const i = b.dataset.f; J.sc[i] = { ...(J.sc[i] || {}), fav: !(J.sc[i] && J.sc[i].fav) }; b.setAttribute('aria-pressed', J.sc[i].fav); updJ(); });
$('#jName').addEventListener('input', () => store('taikai-jname', $('#jName').value));
const ERR = { 'not-yet': '開始前です', ended: '締切済み', closed: '受付終了', pass: 'あいことば変更' };
$('#jSend').onclick = async e => {
  const btn = e.currentTarget;
  if (locked()) { J.editing = true; tickJ(); const f = $('#jl input'); if (f) f.focus(); return; }
  const name = $('#jName').value.trim();
  if (!name) { shake($('#jName')); $('#jName').focus(); return; }
  const bad = J.titles.findIndex((_, i) => { const v = J.sc[i] && String(J.sc[i].v ?? '').trim(); return v && !/^[-ー]$/.test(v) && numOf(v) == null; });
  if (bad >= 0) { const el = $(`#jl [data-j="${bad}"]`); shake(el); el.focus(); return; }
  const scores = J.titles.map((_, i) => { const s = J.sc[i] || {}; return { v: numOf(s.v), fav: !!s.fav }; });
  sending = true; btn.disabled = true;
  try { await S.submit(J.room.id, J.key, name, scores); J.sent = true; J.editing = false; btn.textContent = '✓ 送信済み'; btn.className = 'btn done'; await new Promise(r => setTimeout(r, 1400)); }
  catch (er) { if (er.message === 'ended' || er.message === 'closed') { J.endAt = Date.now() + J.skew; J.editing = false; } if (er.message === 'pass') store('taikai-pass-' + J.room.id, ''); btn.textContent = ERR[er.message] || '送信できませんでした'; await new Promise(r => setTimeout(r, 1600)); }
  sending = false; tickJ();
};

async function restorePack() {
  try {
    const [recs, m] = await Promise.all([IDB.allFiles(), IDB.get('packmeta')]);
    const f = await Promise.all((recs || []).map(async r => ({ path: r.path, data: new Uint8Array(await r.blob.arrayBuffer()) })));
    if (m) {
      $('#root').value = m.root ?? $('#root').value; $('#prefix').checked = m.prefix ?? true; $('#dropSub').checked = !!m.dropSub;
      $('#audioName').value = m.audioName || 'song.ogg'; am = m.am || 'match';
      $$('#am button').forEach(x => x.setAttribute('aria-pressed', x.dataset.a === am)); $('#audioName').hidden = am !== 'fixed';
    }
    if (f && f.length) { files = f; seed = (m && m.edits) || {}; order = (m && m.order) || []; rebuild(); seed = {}; }
  } catch (e) { storeErr(e); }
  restoring = false; render();
}
renderSc(); render(); updPubBtn(); fromHash(); watch(); restorePack();

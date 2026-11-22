/* ===== core: zip / 文字コード / TJA整形 / 集計 ===== */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u) { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function makeZip(files) { // files: [{path, data:Uint8Array}] → Uint8Array[]（無圧縮・UTF-8ファイル名）
  const enc = new TextEncoder(), parts = [], cd = []; let off = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const nb = enc.encode(f.path), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
    h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nb, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
    c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    cd.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + sz;
  }
  const cdSize = cd.reduce((s, a) => s + a.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return [...parts, ...cd, new Uint8Array(e.buffer)];
}

function decodeName(b) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch (e) { return new TextDecoder('shift_jis').decode(b); }
}

async function readZip(buf) { // → [{path, data:Uint8Array}]
  const u = new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let e = -1;
  for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('zipとして読み込めませんでした');
  const n = dv.getUint16(e + 10, true); let off = dv.getUint32(e + 16, true);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const flag = dv.getUint16(off + 8, true), method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
    const nb = u.subarray(off + 46, off + 46 + nlen);
    const path = (flag & 0x800) ? new TextDecoder().decode(nb) : decodeName(nb);
    off += 46 + nlen + xlen + clen;
    if (path.endsWith('/') || (flag & 1)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    out.push({ path, data });
  }
  return out;
}

/* ---- 文字コード ---- */
function decodeText(b) {
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { text: new TextDecoder().decode(b.subarray(3)), enc: 'UTF-8(BOM)' };
  if (b[0] === 0xFF && b[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), enc: 'UTF-16' };
  if (b[0] === 0xFE && b[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), enc: 'UTF-16' };
  try { const t = new TextDecoder('utf-8', { fatal: true }).decode(b); return { text: t, enc: /[^\x00-\x7F]/.test(t) ? 'UTF-8' : 'ASCII' }; }
  catch (e) { return { text: new TextDecoder('shift_jis').decode(b), enc: 'Shift_JIS' }; }
}

let SJ = null;
function sjMap() {
  if (SJ) return SJ;
  SJ = new Map(); const d = new TextDecoder('shift_jis');
  for (let b = 0xA1; b <= 0xDF; b++) { const c = d.decode(new Uint8Array([b])); if (c.length === 1 && !SJ.has(c)) SJ.set(c, [b]); }
  for (let l = 0x81; l <= 0xFC; l++) {
    if (l > 0x9F && l < 0xE0) continue;
    for (let t = 0x40; t <= 0xFC; t++) {
      if (t === 0x7F) continue;
      const c = d.decode(new Uint8Array([l, t]));
      if (c.length === 1 && c !== '\uFFFD' && !SJ.has(c)) SJ.set(c, [l, t]);
    }
  }
  return SJ;
}
const SJ_FALLBACK = { '〜': '～', '‖': '∥', '−': '－', '¢': '￠', '£': '￡', '¬': '￢', '—': '―', '¥': '￥', '‾': '￣' };
function encodeSJIS(s) {
  const m = sjMap(), out = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    const b = m.get(ch) || m.get(SJ_FALLBACK[ch]);
    if (b) out.push(...b); else out.push(0x3F);
  }
  return new Uint8Array(out);
}

/* ---- TJA ---- */
function headerVal(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':'); if (i < 0) continue;
    if (line.slice(0, i).trim().toUpperCase() === key) return line.slice(i + 1).trim();
  }
  return null;
}
function authorFromName(base) {
  const m = base.match(/^(.*?)\s*[(（]([^()（）]*)[)）]\s*$/);
  return m ? { title: m[1].trim(), author: m[2].trim() } : { title: base.trim(), author: '' };
}
function transformTja(text, o) { // o: {title, wave, dropSub}
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/), out = []; let hasT = false, hasW = false;
  for (const line of lines) {
    const i = line.indexOf(':');
    const key = i < 0 ? '' : line.slice(0, i).trim().toUpperCase();
    if (key === 'TITLE') { if (!hasT) out.push('TITLE:' + o.title); hasT = true; continue; }
    if (key === 'WAVE') { if (!hasW) out.push('WAVE:' + o.wave); hasW = true; continue; }
    if (key === 'MAKER') continue;
    if (key === 'SUBTITLE' && o.dropSub) continue;
    out.push(line);
  }
  if (!hasW) { const ti = out.findIndex(l => l.startsWith('TITLE:')); out.splice(ti + 1, 0, 'WAVE:' + o.wave); }
  if (!hasT) out.unshift('TITLE:' + o.title);
  return out.join(eol);
}
function letters(i) { let s = ''; i++; while (i > 0) { i--; s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26); } return s; }
const FW = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '”', '<': '＜', '>': '＞', '|': '｜' };
function safeName(s) { return (s.replace(/[\\/:*?"<>|]/g, c => FW[c]).replace(/[\x00-\x1F]/g, '').replace(/[ .]+$/, '').trim()) || '無題'; }

function sjNorm(s) { // Shift_JISで表せる文字に揃える（ファイル名とWAVE:を一致させるため）
  const m = sjMap(); let o = '';
  for (const ch of s) { const cp = ch.codePointAt(0); o += cp < 0x80 || m.has(ch) ? ch : m.has(SJ_FALLBACK[ch]) ? SJ_FALLBACK[ch] : '_'; }
  return o;
}
function makePlan(charts, order, opt) { // opt: {prefix, audioMode, audioName, flat}
  const byId = new Map(charts.map(c => [c.id, c]));
  const count = {}, seen = {}, used = new Set();
  for (const id of order) { const g = sjNorm(byId.get(id).group.trim()); count[g] = (count[g] || 0) + 1; }
  return order.map((id, n) => {
    const c = byId.get(id), g = sjNorm(c.group.trim());
    let label = '';
    if (count[g] >= 2) { label = letters(seen[g] || 0); seen[g] = (seen[g] || 0) + 1; }
    const display = label ? `${g}【${label}】` : g;
    const base = safeName(label ? `${g} ${label}` : g);
    const ext = c.audio ? (c.audio.name.match(/\.[^.]+$/) || ['.ogg'])[0].toLowerCase() : '.ogg';
    // 音源名は曲名のみ（譜面ラベル A/B… は付けない）。WAVE: もこの名前になる
    const song = safeName(g) + ext;
    if (opt.flat) return { id, n: n + 1, label, display, base, folder: '', audioName: song, chart: c };
    let folder = (opt.prefix ? String(n + 1).padStart(2, '0') + ' ' : '') + base, k = 2;
    while (used.has(folder)) folder = `${opt.prefix ? String(n + 1).padStart(2, '0') + ' ' : ''}${base} (${k++})`;
    used.add(folder);
    let audioName = song;
    if (opt.audioMode === 'fixed' && opt.audioName.trim()) { audioName = safeName(opt.audioName.trim()); if (!/\.[^.]+$/.test(audioName)) audioName += ext; }
    return { id, n: n + 1, label, display, base, folder, audioName, chart: c };
  });
}

/* ---- 集計 ---- */
function parseSongs(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.lastIndexOf(' / ');
    return i < 0 ? { name: l, author: '' } : { name: l.slice(0, i).trim(), author: l.slice(i + 3).trim() };
  });
}
// 新旧の曲目を対応付ける（Worker の matchSongs と同じ）。news[i] に対応する olds の番号、なければ -1
function matchSongs(olds, news) {
  const strip = t => String(t).replace(/【[^【】]*】\s*$/, '').trim(), used = new Set(), res = news.map(() => -1);
  const passes = [(o, n) => o.name === n.name && o.author === n.author, (o, n) => !!n.author && o.author === n.author && strip(o.name) === strip(n.name), (o, n) => o.name === n.name];
  for (const eq of passes) news.forEach((n, i) => { if (res[i] >= 0) return; const j = olds.findIndex((o, k) => !used.has(k) && eq(o, n)); if (j >= 0) { res[i] = j; used.add(j); } });
  return res;
}
function parseScoreLines(text) {
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let bad = 0;
  const vals = lines.map(raw => {
    let s = raw.normalize('NFKC').trim(), fav = false;
    if (!s || /^[-ー―]$/.test(s) || /^自/.test(s)) return null; // 空欄・自譜面は採点なし
    s = s.replace(/[○◯〇●◎]+\s*$/, () => { fav = true; return ''; }).trim();
    const v = Number(s);
    if (s === '' || !isFinite(v)) { bad++; return null; }
    return { v, fav };
  });
  return { vals, bad };
}
function aggregate(songs, scorers) {
  const rows = songs.map((s, i) => ({ ...s, i, ents: [] })), warns = [];
  scorers.forEach((sc, k) => {
    const who = sc.name.trim() || `採点者${k + 1}`;
    const { vals, bad } = parseScoreLines(sc.text);
    if (!vals.length) return;
    if (vals.length !== songs.length) warns.push(`${who}：行数が${vals.length}行です（曲数は${songs.length}曲）`);
    if (bad) warns.push(`${who}：数値として読めない行が${bad}行あります`);
    const nums = vals.filter(Boolean).map(x => x.v);
    const mx = nums.length ? Math.max(...nums) : null;
    vals.forEach((x, i) => { if (x && rows[i]) rows[i].ents.push({ v: x.v, fav: x.fav, max: x.v === mx }); });
  });
  for (const r of rows) {
    const n = r.ents.length;
    r.mean = n ? r.ents.reduce((s, e) => s + e.v, 0) / n : null;
    r.sd = n ? Math.sqrt(r.ents.reduce((s, e) => s + (e.v - r.mean) ** 2, 0) / n) : null;
    r.favs = r.ents.filter(e => e.fav).length;
    r.maxes = r.ents.filter(e => e.max).length;
  }
  rows.sort((a, b) => (b.mean ?? -Infinity) - (a.mean ?? -Infinity) || b.favs - a.favs || a.i - b.i);
  rows.forEach((r, k) => {
    const p = rows[k - 1];
    r.rank = p && p.mean === r.mean && p.favs === r.favs ? p.rank : k + 1;
  });
  return { rows, warns };
}
const fmt2 = x => x == null ? '―' : (Math.round(x * 100) / 100).toFixed(2);
const fmt3 = x => x == null ? '―' : (Math.round(x * 1000) / 1000).toFixed(3);
// 大会全体の数値と、各項目の最大・最小（同値はすべて対象）
function summarize(rows) {
  const scored = rows.filter(r => r.ents.length), all = scored.flatMap(r => r.ents.map(e => e.v));
  const r3 = x => Math.round(x * 1000) / 1000;
  const sds = scored.map(r => r3(r.sd));
  const favMax = Math.max(0, ...rows.map(r => r.favs)), maxMax = Math.max(0, ...rows.map(r => r.maxes));
  return {
    mean: all.length ? all.reduce((a, b) => a + b, 0) / all.length : null,
    sdMean: scored.length ? scored.reduce((a, r) => a + r.sd, 0) / scored.length : null,
    favTotal: rows.reduce((a, r) => a + r.favs, 0),
    favMax: favMax > 0 ? favMax : null, maxMax: maxMax > 0 ? maxMax : null,
    sdMax: scored.length > 1 ? Math.max(...sds) : null, sdMin: scored.length > 1 ? Math.min(...sds) : null
  };
}
function tags(r, S) {
  const sd = r.ents.length ? Math.round(r.sd * 1000) / 1000 : null;
  return {
    favs: S && S.favMax != null && r.favs === S.favMax ? 'MAX' : '',
    maxes: S && S.maxMax != null && r.maxes === S.maxMax ? 'MAX' : '',
    sd: !S || sd == null ? '' : sd === S.sdMax ? 'MAX' : sd === S.sdMin ? 'min' : ''
  };
}
function formatSummary(S) {
  return `## 全体平均：${fmt3(S.mean)}\n## 標準偏差平均：${fmt3(S.sdMean)}\n## 総お気に入り数：${S.favTotal}`;
}
function formatRow(r, S) {
  const toks = [...r.ents].sort((a, b) => b.v - a.v).map(e => {
    let t = String(e.v);
    if (e.max) t = `**${t}**`;
    if (e.fav) t = `__${t}__`;
    return t;
  });
  const T = tags(r, S), tg = x => x ? ` (${x})` : '';
  return `# 【${r.rank}位】${r.name}${r.author ? ' / ' + r.author : ''}\n## 平均点：${fmt3(r.mean)}\nお気に入り：${r.favs}${tg(T.favs)}\n標準偏差：${fmt3(r.sd)}${tg(T.sd)}\nMAX：${r.maxes}${tg(T.maxes)}\n\n${toks.join(' ')}`;
}



// 譜面大会ツール API（Cloudflare Workers + D1）
// D1 のバインディング名は DB。テーブルは初回アクセス時に自動で作られます。

const VERSION = '1.10.0';

const HEAD = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: HEAD });
class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

let ready = false;
async function setup(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL DEFAULT '',
      titles TEXT NOT NULL, authors TEXT NOT NULL, open INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL, updated INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS subs (
      room TEXT NOT NULL, judge TEXT NOT NULL, name TEXT NOT NULL, scores TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (room, judge))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS rooms_owner ON rooms(owner)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, w INTEGER NOT NULL, n INTEGER NOT NULL, t INTEGER NOT NULL)`)
  ]);
  // 後から追加した列（既にあればエラーになるので無視）。ids は曲ごとの固定ID
  for (const [c, type] of [['start_at', 'INTEGER'], ['end_at', 'INTEGER'], ['ids', 'TEXT']]) {
    try { await db.prepare(`ALTER TABLE rooms ADD COLUMN ${c} ${type}`).run(); } catch (e) {}
  }
  ready = true;
}

async function idOf(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) throw new HttpError(401, 'token');
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const norm = s => String(s ?? '').normalize('NFKC').trim();
const str = (s, max) => { s = String(s ?? '').trim(); if (s.length > max) throw new HttpError(400, 'too-long'); return s; };
const list = (a, max, each) => { if (!Array.isArray(a) || a.length > max) throw new HttpError(400, 'bad-list'); return a.map(each); };
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map(x => (x % 36).toString(36)).join('');

async function ownRoom(db, id, owner) {
  const r = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(String(id || '')).first();
  if (!r) throw new HttpError(404, 'no-room');
  if (r.owner !== owner) throw new HttpError(403, 'not-owner');
  return r;
}
async function openRoom(db, id, pass) {
  const r = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(String(id || '')).first();
  if (!r || !r.open) throw new HttpError(404, 'closed');
  if (norm(pass) !== norm(r.pass)) throw new HttpError(403, 'pass');
  return r;
}
// 曲ごとの固定ID（旧データは並び順から作る）
const idsOf = r => { const t = JSON.parse(r.titles); try { const a = JSON.parse(r.ids || 'null'); if (Array.isArray(a) && a.length === t.length) return a; } catch (e) {} return t.map((_, i) => 'i' + i); };
// 新旧の曲目を対応付ける：曲名+作成者 → 【A】等を除いた曲名+作成者 → 曲名 の順（app側の matchSongs と同じ）
function matchSongs(olds, news) {
  const strip = t => String(t).replace(/【[^【】]*】\s*$/, '').trim(), used = new Set(), res = news.map(() => -1);
  const passes = [(o, n) => o.name === n.name && o.author === n.author, (o, n) => !!n.author && o.author === n.author && strip(o.name) === strip(n.name), (o, n) => o.name === n.name];
  for (const eq of passes) news.forEach((n, i) => { if (res[i] >= 0) return; const j = olds.findIndex((o, k) => !used.has(k) && eq(o, n)); if (j >= 0) { res[i] = j; used.add(j); } });
  return res;
}
const BLANK = { v: null, fav: false };
// 回数制限（IPごと・時間枠ごとの回数を D1 に記録）
async function limit(db, key, max, ms, now) {
  const r = await db.prepare(`INSERT INTO rl (k, w, n, t) VALUES (?, ?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN w = excluded.w THEN n + 1 ELSE 1 END, w = excluded.w, t = excluded.t RETURNING n`)
    .bind(key, Math.floor(now / ms), now).first();
  if (r && r.n > max) throw new HttpError(429, 'busy');
}
const time = v => { const n = Number(v); return v == null || v === '' || !isFinite(n) || n <= 0 ? null : Math.floor(n); };
const win = r => ({ startAt: r.start_at ?? null, endAt: r.end_at ?? null });
function checkWindow(r, now) {
  if (r.start_at && now < r.start_at) throw new HttpError(403, 'not-yet');
  if (r.end_at && now >= r.end_at) throw new HttpError(403, 'ended');
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: HEAD });
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    try {
      if (!env.DB) throw new HttpError(500, 'no-db');
      const db = env.DB;
      await setup(db);

      if (req.method === 'GET') {
        if (path === '/health' || path === '/') return json({ ok: true, ver: VERSION });
        if (path === '/rooms') {
          const now = Date.now();
          const { results } = await db.prepare('SELECT id, name, pass, titles, created, start_at, end_at FROM rooms WHERE open = 1 AND (end_at IS NULL OR end_at > ?) ORDER BY created DESC LIMIT 50').bind(now).all();
          return json(results.map(r => ({ id: r.id, name: r.name, hasPass: !!r.pass, count: JSON.parse(r.titles).length, open: true, ...win(r), now })));
        }
        throw new HttpError(404, 'not-found');
      }
      if (req.method !== 'POST') throw new HttpError(405, 'method');
      if (Number(req.headers.get('content-length') || 0) > 256 * 1024) throw new HttpError(413, 'too-large');
      const b = await req.json().catch(() => { throw new HttpError(400, 'json'); });
      const me = await idOf(b.token), now = Date.now();
      const ip = req.headers.get('CF-Connecting-IP') || '-';
      if (['/save', '/open', '/delete', '/submit'].includes(path)) {
        await limit(db, 'w:' + ip, 60, 60000, now); // 書き込みは1分60回まで
        if (path === '/submit') await limit(db, 's:' + ip, 20, 60000, now);
        if (path === '/save' && !b.id) await limit(db, 'c:' + ip, 20, 3600000, now); // 大会の新規作成は1時間20件まで
        if (Math.random() < 0.01) await db.prepare('DELETE FROM rl WHERE t < ?').bind(now - 86400000).run();
      }

      switch (path) {
        case '/mine': {
          const { results } = await db.prepare('SELECT * FROM rooms WHERE owner = ? ORDER BY created DESC').bind(me).all();
          return json(results.map(r => ({ id: r.id, name: r.name, hasPass: !!r.pass, count: JSON.parse(r.titles).length, open: !!r.open, ...win(r) })));
        }
        case '/load': {
          const r = await ownRoom(db, b.id, me);
          return json({ id: r.id, name: r.name, pass: r.pass, titles: JSON.parse(r.titles), authors: JSON.parse(r.authors), open: !!r.open, ...win(r) });
        }
        case '/save': {
          const name = str(b.name, 60), pass = str(b.pass, 60);
          const titles = list(b.titles, 300, t => str(t, 120));
          const authors = list(b.authors || [], 300, t => str(t, 60));
          if (!name || !titles.length) throw new HttpError(400, 'empty');
          const open = b.open === false ? 0 : 1, st = time(b.startAt), en = time(b.endAt);
          if (st && en && en <= st) throw new HttpError(400, 'bad-window');
          const songs = titles.map((t, i) => ({ name: t, author: authors[i] || '' }));
          if (b.id) {
            const r = await ownRoom(db, b.id, me), oldIds = idsOf(r), oldA = JSON.parse(r.authors);
            // 曲の並べ替え・追加・削除があっても、届いた採点が正しい曲に付くように並べ直す
            const m = matchSongs(JSON.parse(r.titles).map((t, i) => ({ name: t, author: oldA[i] || '' })), songs);
            const ids = m.map(j => j >= 0 ? oldIds[j] : newId());
            const changed = ids.length !== oldIds.length || ids.some((x, i) => x !== oldIds[i]);
            const q = [db.prepare('UPDATE rooms SET name = ?, pass = ?, titles = ?, authors = ?, ids = ?, open = ?, start_at = ?, end_at = ?, updated = ? WHERE id = ?')
              .bind(name, pass, JSON.stringify(titles), JSON.stringify(authors), JSON.stringify(ids), open, st, en, now, b.id)];
            let moved = 0;
            if (changed) {
              const { results } = await db.prepare('SELECT judge, scores FROM subs WHERE room = ?').bind(b.id).all();
              for (const sb of results) {
                const old = JSON.parse(sb.scores);
                q.push(db.prepare('UPDATE subs SET scores = ? WHERE room = ? AND judge = ?').bind(JSON.stringify(m.map(j => j >= 0 && old[j] ? old[j] : BLANK)), b.id, sb.judge));
                moved++;
              }
            }
            await db.batch(q);
            return json({ id: b.id, moved });
          }
          const id = newId();
          await db.prepare('INSERT INTO rooms (id, owner, name, pass, titles, authors, ids, open, start_at, end_at, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, me, name, pass, JSON.stringify(titles), JSON.stringify(authors), JSON.stringify(titles.map(() => newId())), open, st, en, now, now).run();
          return json({ id, moved: 0 });
        }
        case '/open': {
          await ownRoom(db, b.id, me);
          await db.prepare('UPDATE rooms SET open = ?, updated = ? WHERE id = ?').bind(b.open ? 1 : 0, now, b.id).run();
          return json({ ok: true });
        }
        case '/delete': {
          await ownRoom(db, b.id, me);
          await db.batch([db.prepare('DELETE FROM subs WHERE room = ?').bind(b.id), db.prepare('DELETE FROM rooms WHERE id = ?').bind(b.id)]);
          return json({ ok: true });
        }
        case '/subs': {
          await ownRoom(db, b.id, me);
          const { results } = await db.prepare('SELECT judge, name, scores, at FROM subs WHERE room = ? ORDER BY at').bind(b.id).all();
          return json(results.map(s => ({ uid: s.judge.slice(0, 16), name: s.name, scores: JSON.parse(s.scores), at: s.at })));
        }
        case '/enter': {
          const r = await openRoom(db, b.id, b.pass);
          const m = await db.prepare('SELECT name, scores FROM subs WHERE room = ? AND judge = ?').bind(r.id, me).first();
          // 参加者名簿：作成者名だけを重複なし・五十音順で返す（曲との対応は伏せる）
          const roster = [...new Set(JSON.parse(r.authors).map(x => String(x).trim()).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'ja'));
          return json({ name: r.name, titles: JSON.parse(r.titles), ids: idsOf(r), roster, mine: m ? { name: m.name, scores: JSON.parse(m.scores) } : null, ...win(r), now });
        }
        case '/submit': {
          const r = await openRoom(db, b.id, b.pass);
          checkWindow(r, now);
          const name = str(b.name, 40);
          if (!name) throw new HttpError(400, 'name');
          let scores = list(b.scores, 300, x => {
            const v = x && x.v != null && isFinite(Number(x.v)) ? Number(x.v) : null;
            return { v, fav: !!(x && x.fav) };
          });
          // 曲IDつきなら、採点中に曲目が更新されていても今の並びに合わせる
          if (Array.isArray(b.ids)) {
            const byId = new Map(); b.ids.slice(0, scores.length).forEach((id, i) => byId.set(String(id), scores[i]));
            scores = idsOf(r).map(id => byId.get(id) || BLANK);
          }
          await db.prepare(`INSERT INTO subs (room, judge, name, scores, at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(room, judge) DO UPDATE SET name = excluded.name, scores = excluded.scores, at = excluded.at`)
            .bind(r.id, me, name, JSON.stringify(scores), now).run();
          return json({ ok: true, at: now });
        }
      }
      throw new HttpError(404, 'not-found');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status);
      return json({ error: 'server', detail: String(e && e.message || e) }, 500);
    }
  }
};

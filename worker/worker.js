// 譜面大会ツール API（Cloudflare Workers + D1）
// D1 のバインディング名は DB。テーブルは初回アクセス時に自動で作られます。

const VERSION = '1.5.0';

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
    db.prepare(`CREATE INDEX IF NOT EXISTS rooms_owner ON rooms(owner)`)
  ]);
  // 受付時間の列（後から追加。既にあればエラーになるので無視）
  for (const c of ['start_at', 'end_at']) {
    try { await db.prepare(`ALTER TABLE rooms ADD COLUMN ${c} INTEGER`).run(); } catch (e) {}
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
          if (b.id) {
            await ownRoom(db, b.id, me);
            await db.prepare('UPDATE rooms SET name = ?, pass = ?, titles = ?, authors = ?, open = ?, start_at = ?, end_at = ?, updated = ? WHERE id = ?')
              .bind(name, pass, JSON.stringify(titles), JSON.stringify(authors), open, st, en, now, b.id).run();
            return json({ id: b.id });
          }
          const id = newId();
          await db.prepare('INSERT INTO rooms (id, owner, name, pass, titles, authors, open, start_at, end_at, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, me, name, pass, JSON.stringify(titles), JSON.stringify(authors), open, st, en, now, now).run();
          return json({ id });
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
          return json({ name: r.name, titles: JSON.parse(r.titles), roster, mine: m ? { name: m.name, scores: JSON.parse(m.scores) } : null, ...win(r), now });
        }
        case '/submit': {
          const r = await openRoom(db, b.id, b.pass);
          checkWindow(r, now);
          const name = str(b.name, 40);
          if (!name) throw new HttpError(400, 'name');
          const scores = list(b.scores, 300, x => {
            const v = x && x.v != null && isFinite(Number(x.v)) ? Number(x.v) : null;
            return { v, fav: !!(x && x.fav) };
          });
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

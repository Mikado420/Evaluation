// 譜面大会ツール API（Cloudflare Workers + D1）
// D1 のバインディング名は DB。テーブルは初回アクセス時に自動で作られます。

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

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: HEAD });
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    try {
      if (!env.DB) throw new HttpError(500, 'no-db');
      const db = env.DB;
      await setup(db);

      if (req.method === 'GET') {
        if (path === '/health' || path === '/') return json({ ok: true });
        if (path === '/rooms') {
          const { results } = await db.prepare('SELECT id, name, pass, titles, created FROM rooms WHERE open = 1 ORDER BY created DESC LIMIT 50').all();
          return json(results.map(r => ({ id: r.id, name: r.name, hasPass: !!r.pass, count: JSON.parse(r.titles).length, open: true })));
        }
        throw new HttpError(404, 'not-found');
      }
      if (req.method !== 'POST') throw new HttpError(405, 'method');
      if (Number(req.headers.get('content-length') || 0) > 256 * 1024) throw new HttpError(413, 'too-large');
      const b = await req.json().catch(() => { throw new HttpError(400, 'json'); });
      const me = await idOf(b.token), now = Date.now();

      switch (path) {
        case '/mine': {
          const { results } = await db.prepare('SELECT id, name, pass, titles, open, created FROM rooms WHERE owner = ? ORDER BY created DESC').bind(me).all();
          return json(results.map(r => ({ id: r.id, name: r.name, hasPass: !!r.pass, count: JSON.parse(r.titles).length, open: !!r.open })));
        }
        case '/load': {
          const r = await ownRoom(db, b.id, me);
          return json({ id: r.id, name: r.name, pass: r.pass, titles: JSON.parse(r.titles), authors: JSON.parse(r.authors), open: !!r.open });
        }
        case '/save': {
          const name = str(b.name, 60), pass = str(b.pass, 60);
          const titles = list(b.titles, 300, t => str(t, 120));
          const authors = list(b.authors || [], 300, t => str(t, 60));
          if (!name || !titles.length) throw new HttpError(400, 'empty');
          const open = b.open === false ? 0 : 1;
          if (b.id) {
            await ownRoom(db, b.id, me);
            await db.prepare('UPDATE rooms SET name = ?, pass = ?, titles = ?, authors = ?, open = ?, updated = ? WHERE id = ?')
              .bind(name, pass, JSON.stringify(titles), JSON.stringify(authors), open, now, b.id).run();
            return json({ id: b.id });
          }
          const id = newId();
          await db.prepare('INSERT INTO rooms (id, owner, name, pass, titles, authors, open, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, me, name, pass, JSON.stringify(titles), JSON.stringify(authors), open, now, now).run();
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
          return json({ name: r.name, titles: JSON.parse(r.titles), mine: m ? { name: m.name, scores: JSON.parse(m.scores) } : null });
        }
        case '/submit': {
          const r = await openRoom(db, b.id, b.pass);
          const name = str(b.name, 40);
          if (!name) throw new HttpError(400, 'name');
          const scores = list(b.scores, 300, x => {
            const v = x && x.v != null && isFinite(Number(x.v)) ? Number(x.v) : null;
            return { v, fav: !!(x && x.fav) };
          });
          await db.prepare(`INSERT INTO subs (room, judge, name, scores, at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(room, judge) DO UPDATE SET name = excluded.name, scores = excluded.scores, at = excluded.at`)
            .bind(r.id, me, name, JSON.stringify(scores), now).run();
          return json({ ok: true });
        }
      }
      throw new HttpError(404, 'not-found');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status);
      return json({ error: 'server', detail: String(e && e.message || e) }, 500);
    }
  }
};

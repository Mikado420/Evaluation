// Cloudflare Workers の API との通信
import { API } from './config.js';

const base = String(API || '').replace(/\/+$/, '');
let token = null;
try { token = localStorage.getItem('taikai-token'); } catch (e) {}
if (!token) {
  token = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem('taikai-token', token); } catch (e) {}
}

async function call(path, body) {
  const r = await fetch(base + path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token, ...body })
  } : undefined);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || String(r.status)); e.status = r.status; throw e; }
  return d;
}

function poll(fn, cb, ms) {
  let on = true, t = null;
  const tick = async () => {
    if (!on) return;
    try { cb(await fn()); } catch (e) {}
    if (on) t = setTimeout(tick, document.hidden ? ms * 4 : ms);
  };
  tick();
  return () => { on = false; clearTimeout(t); };
}

export async function init() {
  if (!base) return null;
  await call('/health');
  return token;
}
export const watchOpenRooms = cb => poll(() => call('/rooms'), cb, 10000);
export const myRooms = () => call('/mine', {});
export const loadRoom = id => call('/load', { id }).catch(() => null);
export async function publish({ roomId, name, pass, titles, authors, open }) {
  return (await call('/save', { id: roomId || null, name, pass, titles, authors, open })).id;
}
export const setOpen = (id, open) => call('/open', { id, open });
export async function watchSubs(id, pass, cb) { return poll(() => call('/subs', { id }), cb, 5000); }
export async function enter(id, pass) {
  try { const d = await call('/enter', { id, pass }); return { key: pass, titles: d.titles, mine: d.mine }; }
  catch (e) { if (e.status === 403 || e.status === 404) return null; throw e; }
}
export const submit = (id, key, name, scores) => call('/submit', { id, pass: key, name, scores });

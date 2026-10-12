import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkCompetitions, normalizeCantina, normalizeCode4rena, normalizeSherlock, formatMessage } from './competitions_watch.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const H = 3600000;

const cantina = (over = []) => [
  { id: 'live-1', name: 'Revert v4lend Competition', kind: 'public_contest', status: 'live', company: { name: 'Revert' }, currencyCode: 'USDC', totalRewardPot: '50000', kycRequired: true, timeframe: { start: '2026-10-06T18:30:00Z', end: '2026-11-03T18:30:00Z' } },
  { id: 'old-1', name: 'Royco Day', kind: 'public_contest', status: 'complete', currencyCode: 'USDC', totalRewardPot: '1', timeframe: { start: '2026-08-10T20:00:00Z', end: '2026-08-19T20:00:00Z' } },
  { id: 'priv-1', name: 'Private thing', kind: 'private_contest', status: 'live', currencyCode: 'USDC', totalRewardPot: '9', timeframe: { start: '2026-10-01T00:00:00Z', end: '2026-12-01T00:00:00Z' } },
  ...over,
];
const c4 = (over = []) => ({ data: { audits: [
  { uid: 'u-done', slug: 'monetrix', title: 'Monetrix', status: 'Completed', formattedAmount: '$22,000 in USDC', startTime: '2026-04-24T20:00:00Z', endTime: '2026-05-04T20:00:00Z' },
  { uid: 'u-judging', slug: 'k2', title: 'K2', status: 'Judging', startTime: '2026-04-17T20:00:00Z', endTime: '2026-05-27T20:00:00Z' },
  ...over,
] } });
const sherlock = (created = [], running = []) => ({ CREATED: created, RUNNING: running });

function makeFetch({ cantinaDoc = cantina(), c4Doc = c4(), sh = sherlock(), fail = {} } = {}) {
  return async (url) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('cantina.xyz')) return fail.cantina ? { ok: false, status: 503 } : ok(cantinaDoc);
    if (url.includes('code4rena.com')) return fail.code4rena ? { ok: false, status: 500 } : ok(c4Doc);
    if (url.includes('sherlock.xyz')) {
      if (fail.sherlock) return { ok: false, status: 502 };
      const status = new URL(url).searchParams.get('status');
      if (!['CREATED', 'RUNNING'].includes(status)) return ok({ error: 'unable to load contests' });
      return ok({ items: sh[status] });
    }
    throw new Error('url inesperada ' + url);
  };
}

async function tmpState() { return path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'comp-')), 'competitions_seen.json'); }
const collector = () => { const sent = []; return { sent, send: async (m) => { sent.push(m); return { ok: true }; } }; };

test('normalizers: descartan privadas, terminadas y estados terminales', () => {
  assert.deepEqual(normalizeCantina(cantina()).map((c) => c.key), ['cantina:live-1']);
  assert.equal(normalizeCantina(cantina())[0].pot, '50,000 USDC');
  assert.deepEqual(normalizeCode4rena(c4()), []);
  assert.throws(() => normalizeCantina({}), /no es un array/);
  assert.throws(() => normalizeCode4rena({}), /sin data\.audits/);
  assert.deepEqual(normalizeSherlock([{ id: 1, title: 'x', private: true }]), []);
});

test('primera corrida: registra lo existente y NO avisa (baseline)', async () => {
  const f = await tmpState(); const { sent, send } = collector();
  const r = await checkCompetitions(send, f, { fetchImpl: makeFetch(), now: NOW });
  assert.equal(r.firstRun, true); assert.equal(r.notified, 0); assert.equal(sent.length, 0);
  const saved = JSON.parse(await fs.readFile(f, 'utf8'));
  assert.ok(saved.seen.cantina.includes('cantina:live-1'));
});

test('segunda corrida sin novedades: 0 avisos; con una nueva: 1 aviso, y no se repite', async () => {
  const f = await tmpState(); const { sent, send } = collector();
  await checkCompetitions(send, f, { fetchImpl: makeFetch(), now: NOW });
  assert.equal((await checkCompetitions(send, f, { fetchImpl: makeFetch(), now: NOW })).notified, 0);

  const nueva = { uid: 'u-new', slug: 'fresh-protocol', title: 'Fresh Protocol', org: 'Fresh', league: 'ETH', status: 'Active', formattedAmount: '$80,000 in USDC', startTime: new Date(NOW + 48 * H).toISOString(), endTime: new Date(NOW + 20 * 24 * H).toISOString(), hasMandatoryProofOfConcept: true };
  const fx = makeFetch({ c4Doc: c4([nueva]) });
  const r = await checkCompetitions(send, f, { fetchImpl: fx, now: NOW });
  assert.equal(r.fresh, 1); assert.equal(r.notified, 1);
  assert.match(sent[0], /ANUNCIADA/); assert.match(sent[0], /Fresh Protocol/); assert.match(sent[0], /80,000/); assert.match(sent[0], /code4rena\.com\/audits\/fresh-protocol/);
  assert.equal((await checkCompetitions(send, f, { fetchImpl: fx, now: NOW })).notified, 0); // no repite
});

test('competencia ya abierta se anuncia como ABIERTA con tiempo restante (Sherlock RUNNING)', async () => {
  const f = await tmpState(); const { sent, send } = collector();
  await checkCompetitions(send, f, { fetchImpl: makeFetch(), now: NOW });
  const run = { id: 777, title: 'Cool DEX', private: false, prize_pool: 120000, token: 'USDC', type_label: 'Public', starts_at: Math.floor((NOW - 24 * H) / 1000), ends_at: Math.floor((NOW + 6 * 24 * H) / 1000) };
  const r = await checkCompetitions(send, f, { fetchImpl: makeFetch({ sh: sherlock([], [run]) }), now: NOW });
  assert.equal(r.notified, 1); assert.match(sent[0], /ABIERTA/); assert.match(sent[0], /quedan 6 dias/); assert.match(sent[0], /sherlock\.xyz\/contests\/777/);
});

test('una competencia cuyo fin ya paso no avisa aunque sea nueva', async () => {
  const f = await tmpState(); const { sent, send } = collector();
  await checkCompetitions(send, f, { fetchImpl: makeFetch(), now: NOW });
  const vieja = { id: 'zombie', name: 'Zombie', kind: 'public_contest', status: 'live', currencyCode: 'USDC', totalRewardPot: '5', timeframe: { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' } };
  const r = await checkCompetitions(send, f, { fetchImpl: makeFetch({ cantinaDoc: cantina([vieja]) }), now: NOW });
  assert.equal(r.fresh, 0); assert.equal(sent.length, 0);
});

test('si falla el envio, se reintenta en el siguiente ciclo (no se marca vista)', async () => {
  const f = await tmpState(); const good = collector();
  await checkCompetitions(good.send, f, { fetchImpl: makeFetch(), now: NOW });
  const nueva = { id: 'n2', name: 'Nueva', kind: 'public_contest', status: 'live', currencyCode: 'USDC', totalRewardPot: '10000', timeframe: { start: new Date(NOW).toISOString(), end: new Date(NOW + 10 * 24 * H).toISOString() } };
  const fx = makeFetch({ cantinaDoc: cantina([nueva]) });
  const bad = await checkCompetitions(async () => ({ ok: false }), f, { fetchImpl: fx, now: NOW });
  assert.equal(bad.fresh, 1); assert.equal(bad.notified, 0);
  const again = await checkCompetitions(good.send, f, { fetchImpl: fx, now: NOW });
  assert.equal(again.notified, 1);
});

test('una fuente caida no rompe las otras ni marca nada como visto; se reporta en errors', async () => {
  const f = await tmpState(); const { sent, send } = collector();
  const r0 = await checkCompetitions(send, f, { fetchImpl: makeFetch({ fail: { sherlock: true } }), now: NOW });
  assert.deepEqual(Object.keys(r0.errors), ['sherlock']);
  const saved = JSON.parse(await fs.readFile(f, 'utf8'));
  assert.ok(saved.seen.cantina && saved.seen.code4rena && !saved.seen.sherlock);
  // Cuando Sherlock vuelve con una RUNNING, avisa (no estaba marcada como vista).
  const run = { id: 5, title: 'Back Online', private: false, prize_pool: 1000, token: 'USDC', starts_at: Math.floor((NOW - H) / 1000), ends_at: Math.floor((NOW + 5 * 24 * H) / 1000) };
  const r1 = await checkCompetitions(send, f, { fetchImpl: makeFetch({ sh: sherlock([], [run]) }), now: NOW });
  assert.equal(r1.notified, 1); assert.equal(r1.errors, undefined);
});

test('todas las fuentes caidas: error y NO se escribe estado', async () => {
  const f = await tmpState(); const { send } = collector();
  const r = await checkCompetitions(send, f, { fetchImpl: makeFetch({ fail: { cantina: true, code4rena: true, sherlock: true } }), now: NOW });
  assert.equal(r.checked, 0); assert.equal(Object.keys(r.errors).length, 3);
  await assert.rejects(fs.readFile(f, 'utf8'));
});

test('formatMessage: anunciada vs abierta', () => {
  const base = { platform: 'Cantina', title: 'T', sponsor: 'S', pot: '1 USDC', url: 'https://x', notes: [] };
  assert.match(formatMessage({ ...base, start: NOW + 5 * H, end: NOW + 9 * 24 * H }, NOW), /en 5 h/);
  assert.match(formatMessage({ ...base, start: NOW - H, end: NOW + 3 * H }, NOW), /quedan 3 h/);
});

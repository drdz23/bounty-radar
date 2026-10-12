// competitions_watch.js — Vigila competencias de auditoria NUEVAS: Cantina, Code4rena y Sherlock.
//
// Por que existe: una competencia es la primera auditoria a fondo de codigo fresco, y llegar el dia 1
// es la ventaja real (v4lend #669 salio asi). Los listados publicos no avisan, asi que se consultan sus
// APIs publicas (sin clave) y se avisa por Telegram cuando aparece una que aun no habia visto.
//
//   Cantina    GET https://cantina.xyz/api/v0/competitions                   (solo kind=public_contest)
//   Code4rena  GET https://code4rena.com/api/v1/audits                       ({data:{audits:[]}})
//   Sherlock   GET https://mainnet-contest.sherlock.xyz/contests?status=CREATED|RUNNING
//              (ACTIVE/LIVE/SCHEDULED NO existen: el API responde error. RUNNING = en curso, CREATED = anunciada.)
//
// No envia nada a las plataformas ni firma nada: solo lee y avisa.
// Una competencia cuenta como "alertable" si NO ha terminado (fin en el futuro) y su estado no es terminal.

import fs from 'node:fs/promises';
import path from 'node:path';

const URLS = {
  cantina: process.env.CANTINA_COMPETITIONS_URL || 'https://cantina.xyz/api/v0/competitions',
  code4rena: process.env.C4_AUDITS_URL || 'https://code4rena.com/api/v1/audits',
  sherlock: process.env.SHERLOCK_CONTESTS_URL || 'https://mainnet-contest.sherlock.xyz/contests',
};
const SHERLOCK_STATUSES = ['CREATED', 'RUNNING'];
const UA = { 'user-agent': 'bounty-radar/competitions_watch' };

const CANTINA_TERMINAL = new Set(['complete', 'completed', 'cancelled', 'canceled']);
const C4_TERMINAL = new Set(['completed', 'judging', 'reporting', 'cancelled', 'canceled']);

const ms = (v) => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
const epochMs = (s) => (typeof s === 'number' && s > 0 ? s * 1000 : null);

function money(amount, cur) {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0 ? `${n.toLocaleString('en-US')} ${cur || ''}`.trim() : null;
}

/** Cantina: solo competencias publicas que no terminaron. */
export function normalizeCantina(list) {
  if (!Array.isArray(list)) throw new Error('Cantina: respuesta no es un array');
  return list
    .filter((x) => x && x.kind === 'public_contest' && !CANTINA_TERMINAL.has(String(x.status).toLowerCase()))
    .map((x) => ({
      key: `cantina:${x.id}`,
      platform: 'Cantina',
      title: x.name,
      sponsor: x.company?.name || null,
      pot: money(x.totalRewardPot, x.currencyCode),
      start: ms(x.timeframe?.start),
      end: ms(x.timeframe?.end),
      url: x.url || `https://cantina.xyz/competitions/${x.id}`,
      notes: [x.kycRequired ? 'exige KYC de Cantina (ya lo tienes si cobraste v4lend)' : null],
    }));
}

/** Code4rena: auditorias que no estan en estado terminal. */
export function normalizeCode4rena(doc) {
  const list = doc?.data?.audits;
  if (!Array.isArray(list)) throw new Error('Code4rena: respuesta sin data.audits[]');
  return list
    .filter((x) => x && !C4_TERMINAL.has(String(x.status).toLowerCase()))
    .map((x) => ({
      key: `c4:${x.uid || x.slug}`,
      platform: 'Code4rena',
      title: x.title,
      sponsor: x.org || null,
      pot: x.formattedAmount || null,
      start: ms(x.startTime),
      end: ms(x.endTime),
      url: `https://code4rena.com/audits/${x.slug}`,
      notes: [
        x.league ? `ecosistema: ${x.league}` : null,
        x.mitigationOf ? 'revision de mitigacion (premio chico)' : null,
        x.hasMandatoryProofOfConcept ? 'exige PoC' : null,
      ],
    }));
}

/** Sherlock: contests publicos en CREATED/RUNNING (cada estado se pide por separado). */
export function normalizeSherlock(items) {
  if (!Array.isArray(items)) throw new Error('Sherlock: items no es un array');
  return items
    .filter((x) => x && !x.private)
    .map((x) => ({
      key: `sherlock:${x.id}`,
      platform: 'Sherlock',
      title: x.title,
      sponsor: null,
      pot: money(x.prize_pool, x.token),
      start: epochMs(x.starts_at),
      end: epochMs(x.ends_at),
      url: `https://audits.sherlock.xyz/contests/${x.id}`,
      notes: [x.type_label ? `tipo: ${x.type_label}` : null],
    }));
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchSherlock(fetchImpl) {
  const out = [];
  for (const status of SHERLOCK_STATUSES) {
    const j = await getJson(fetchImpl, `${URLS.sherlock}?status=${status}`);
    if (j?.error) throw new Error(`Sherlock status=${status}: ${j.error}`);
    out.push(...normalizeSherlock(j?.items));
  }
  return out;
}

const SOURCES = {
  cantina: async (f) => normalizeCantina(await getJson(f, URLS.cantina)),
  code4rena: async (f) => normalizeCode4rena(await getJson(f, URLS.code4rena)),
  sherlock: (f) => fetchSherlock(f),
};

function span(ms_) {
  const h = Math.round(Math.abs(ms_) / 3600000);
  return h >= 48 ? `${Math.round(h / 24)} dias` : `${h} h`;
}

export function formatMessage(c, now = Date.now()) {
  const upcoming = c.start && c.start > now;
  const lines = [
    upcoming ? '🆕 COMPETENCIA DE AUDITORIA ANUNCIADA (aun no abre)' : '🔥 COMPETENCIA DE AUDITORIA ABIERTA',
    `• ${c.platform}: ${c.title}${c.sponsor ? ` (${c.sponsor})` : ''}`,
    c.pot ? `• premio: ${c.pot}` : null,
    c.start ? `• abre: ${new Date(c.start).toISOString().slice(0, 16).replace('T', ' ')} UTC${upcoming ? ` (en ${span(c.start - now)})` : ''}` : null,
    c.end ? `• cierra: ${new Date(c.end).toISOString().slice(0, 16).replace('T', ' ')} UTC${!upcoming ? ` (quedan ${span(c.end - now)})` : ''}` : null,
    ...c.notes.filter(Boolean).map((n) => `• ${n}`),
    `• ${c.url}`,
    '',
    'Codigo fresco = primera auditoria a fondo. Llegar el dia 1 es la ventaja; verifica el commit exacto del scope antes de empezar.',
  ];
  return lines.filter((x) => x !== null).join('\n');
}

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

/**
 * @param send       async (message, opts?) => any   (devuelve {ok:false} si fallo el envio)
 * @param stateFile  JSON con las claves ya vistas por plataforma
 * @returns { checked, fresh, notified, firstRun, errors? }
 *
 * Una fuente que falla NO se marca como vista ni borra lo guardado: se reintenta en el proximo ciclo.
 * La primera corrida (sin estado) solo registra lo que ya existe, para no avisar de lo conocido (p. ej. v4lend).
 */
export async function checkCompetitions(send, stateFile, { baseline = true, fetchImpl = fetch, now = Date.now() } = {}) {
  const state = await readJson(stateFile, null);
  const firstRun = !state;
  const seenBySource = state?.seen || {};
  const errors = {};
  const results = {};

  for (const [name, load] of Object.entries(SOURCES)) {
    try { results[name] = await load(fetchImpl); }
    catch (e) { errors[name] = e.message; }
  }
  if (Object.keys(results).length === 0) return { checked: 0, fresh: 0, notified: 0, firstRun, errors };

  let checked = 0, fresh = 0, notified = 0;
  const nextSeen = { ...seenBySource };

  for (const [name, list] of Object.entries(results)) {
    const seen = new Set(seenBySource[name] || []);
    const retry = new Set();
    checked += list.length;
    // Alertable: no ha terminado. (Las que ya cerraron pero siguen en estado no terminal no sirven.)
    const open = list.filter((c) => !c.end || c.end > now);
    const newOnes = open.filter((c) => !seen.has(c.key));
    fresh += newOnes.length;

    if (!(firstRun && baseline)) {
      for (const c of newOnes) {
        const r = await send(formatMessage(c, now)).catch((e) => ({ ok: false, err: e.message }));
        if (r?.ok === false) { retry.add(c.key); continue; }
        notified++;
      }
    }
    // Se recuerdan TODAS las vistas (tambien las cerradas) para no re-avisar; las no enviadas se reintentan.
    for (const c of list) if (!retry.has(c.key)) seen.add(c.key);
    nextSeen[name] = [...seen];
  }

  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ updated_at: new Date(now).toISOString(), seen: nextSeen }, null, 2), 'utf8');
  return { checked, fresh, notified, firstRun, ...(Object.keys(errors).length ? { errors } : {}) };
}

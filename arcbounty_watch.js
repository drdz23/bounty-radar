// arcbounty_watch.js — Vigila la API PUBLICA de ArcBounty (https://arcbounty.app, USDC en Arc).
//
//   GET /api/v1/bounties?status=open  → bounties abiertas (sin clave ni registro)
//
// Solo avisa de las abiertas a las que un humano puede responder (audience 'anyone' o 'humans')
// y que no estan reservadas a otra wallet. No envia nada ni firma nada.
// Ojo: las 16 bounties vistas hasta 2026-10-09 pagaban 1-10 USDC; el aviso es normal, no prioritario.
//
// Env (opcional): ARCBOUNTY_API_URL

import fs from 'node:fs/promises';
import path from 'node:path';

const API_URL = process.env.ARCBOUNTY_API_URL || 'https://arcbounty.app/api/v1/bounties?status=open';

export function eligible(b) {
  if (String(b.status).toLowerCase() !== 'open') return false;
  if (b.audience === 'agents') return false;              // solo agentes
  if (b.reservedFor) return false;                        // reservada a otra wallet
  if (b.deadline && new Date(b.deadline).getTime() < Date.now()) return false;
  return true;
}

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

/**
 * @param send       async (message, opts?) => any
 * @param stateFile  JSON con los jobIds ya vistos
 * @returns { checked, fresh, notified, firstRun, error? }
 */
export async function checkArcBounty(send, stateFile, { baseline = true, fetchImpl = fetch } = {}) {
  let data;
  try {
    const res = await fetchImpl(API_URL, { headers: { 'user-agent': 'bounty-radar/arcbounty_watch' } });
    if (!res.ok) return { checked: 0, fresh: 0, notified: 0, error: `HTTP ${res.status}` };
    data = await res.json();
  } catch (e) {
    return { checked: 0, fresh: 0, notified: 0, error: e.message };
  }
  const list = Array.isArray(data?.bounties) ? data.bounties : null;
  if (!list) return { checked: 0, fresh: 0, notified: 0, error: 'respuesta sin bounties[]' };

  const state = await readJson(stateFile, null);
  const seen = new Set((state?.ids || []).map(Number));
  const firstRun = !state;
  const fresh = list.filter((b) => !seen.has(Number(b.jobId)));

  let notified = 0;
  const retry = new Set();
  if (!(firstRun && baseline)) {
    for (const b of fresh) {
      if (!eligible(b)) continue;
      const msg = [
        '🧭 ARCBOUNTY: bounty nueva abierta',
        `• #${b.jobId} ${b.rewardUsdc} USDC · ${b.category || 'sin categoria'} · para: ${b.audience || '?'}`,
        b.tags?.length ? `• tags: ${b.tags.slice(0, 6).join(', ')}` : null,
        b.deadline ? `• vence: ${b.deadline.slice(0, 16).replace('T', ' ')} UTC` : null,
        `• ${b.url || `https://arcbounty.app/bounty/${b.jobId}`}`,
        b.workerBondRequired ? `• OJO: exige fianza de ${b.workerBondUsdc} USDC` : null,
        '',
        'Pagan USDC en la red Arc (hace falta wallet con USDC para gas). Montos vistos hasta ahora: 1-10 USDC.',
      ].filter((x) => x !== null).join('\n');
      const r = await send(msg).catch((e) => ({ ok: false, err: e.message }));
      if (r?.ok === false) { retry.add(Number(b.jobId)); continue; }
      notified++;
    }
  }

  for (const b of list) if (!retry.has(Number(b.jobId))) seen.add(Number(b.jobId));
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ updated_at: new Date().toISOString(), ids: [...seen] }, null, 2), 'utf8');
  return { checked: list.length, fresh: fresh.length, notified, firstRun };
}

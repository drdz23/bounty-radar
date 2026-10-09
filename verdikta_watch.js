// verdikta_watch.js — Vigila el feed PUBLICO de Verdikta Bounties (sin clave ni registro).
//
//   https://bounties.verdikta.org/feed.xml  → Atom con TODAS las bounties y su estado
//   (OPEN / AWARDED / CLOSED). Si el texto de una bounty dirigida menciona nuestra wallet,
//   se avisa como "DIRIGIDA A TI". Las dirigidas a OTRA wallet no avisan.
//
// Solo avisa: no envia nada a la plataforma ni firma nada.
//
// Env (todas opcionales):
//   VERDIKTA_HUNTER_ADDRESS   wallet que cobra (por defecto la MetaMask Account 1 del usuario)
//   VERDIKTA_ETH_USD          precio de ETH para el aproximado en USD (por defecto 2470)
//   VERDIKTA_FEED_URL         por si cambia la URL

import fs from 'node:fs/promises';
import path from 'node:path';

const FEED_URL = process.env.VERDIKTA_FEED_URL || 'https://bounties.verdikta.org/feed.xml';
const HUNTER = (process.env.VERDIKTA_HUNTER_ADDRESS || '0x589952a6cD216F6971dAc0506DD695B8E5eF69C7').toLowerCase();
const ETH_USD = Number(process.env.VERDIKTA_ETH_USD || 2470);

const decode = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export function parseFeed(xml) {
  return String(xml).split('<entry>').slice(1).map((e) => {
    const id = (e.match(/<id>bounty-(\d+)/) || [])[1];
    const title = decode((e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]).trim();
    const summary = decode((e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1]).trim();
    const updated = (e.match(/<updated>([^<]+)/) || [])[1] || '';
    const status = ((e.match(/<category term="([^"]+)"/) || [])[1] || '').toUpperCase();
    const eth = Number((title.match(/^([\d.]+)\s*ETH/i) || [])[1]);
    return { id: Number(id), title, summary, updated, status, eth: Number.isFinite(eth) ? eth : null };
  }).filter((x) => x.id);
}

// 'mine' = dirigida a nuestra wallet; 'other' = dirigida a otra; 'open' = para cualquiera.
export function classify(b) {
  const text = `${b.title}\n${b.summary}`.toLowerCase();
  if (text.includes(HUNTER)) return 'mine';
  if (/directed bounty|targeted to|aimed at a single wallet|only 0x[0-9a-f]{4,}/i.test(text)) return 'other';
  return 'open';
}

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

/**
 * @param send       async (message, opts?) => any   (p. ej. sendNotification)
 * @param stateFile  ruta del JSON donde se guardan los ids ya vistos
 * @param opts.baseline  true (por defecto): la primera vez solo se memorizan los ids, sin avisar
 * @returns { checked, fresh, notified, error? }
 */
export async function checkVerdiktaFeed(send, stateFile, { baseline = true, fetchImpl = fetch } = {}) {
  let xml;
  try {
    const res = await fetchImpl(FEED_URL, { headers: { 'user-agent': 'bounty-radar/verdikta_watch' } });
    if (!res.ok) return { checked: 0, fresh: 0, notified: 0, error: `HTTP ${res.status}` };
    xml = await res.text();
  } catch (e) {
    return { checked: 0, fresh: 0, notified: 0, error: e.message };
  }
  const entries = parseFeed(xml);
  if (!entries.length) return { checked: 0, fresh: 0, notified: 0, error: 'feed sin entradas' };

  const state = await readJson(stateFile, null);
  const seen = new Set((state?.ids || []).map(Number));
  const firstRun = !state;
  const fresh = entries.filter((b) => !seen.has(b.id));

  let notified = 0;
  const retry = new Set();
  if (!(firstRun && baseline)) {
    for (const b of fresh) {
      if (b.status !== 'OPEN') continue;            // ya adjudicada/cerrada: nada que hacer
      const kind = classify(b);
      if (kind === 'other') continue;               // dirigida a otra wallet
      const usd = b.eth != null ? ` (~$${(b.eth * ETH_USD).toFixed(0)})` : '';
      const head = kind === 'mine'
        ? '🎯 VERDIKTA: BOUNTY DIRIGIDA A TI'
        : '⚡ VERDIKTA PRIORITARIO: bounty nueva abierta (hay competencia, el primero que pasa gana)';
      const msg = [
        head,
        `• #${b.id} ${b.title.slice(0, 150)}${usd}`,
        `• https://bounties.verdikta.org/bounty/${b.id}`,
        '',
        b.summary.replace(/\s+/g, ' ').slice(0, 450),
        '',
        kind === 'mine'
          ? 'Esta es la via que mejor ha pagado. Lee el umbral y la rubrica en la pagina antes de enviar.'
          : 'Mira el umbral. Metodo que gano 6 de 7: publicar, adjuntar el texto completo en .md + capturas, Start Evaluation, Finalize.',
      ].join('\n');
      // Prioritario: suena aunque sea de noche. Las tandas de Verdikta se adjudican en horas.
      const r = await send(msg, { priority: true }).catch((e) => ({ ok: false, err: e.message }));
      if (r?.ok === false) { retry.add(b.id); continue; } // se reintenta en la proxima pasada
      notified++;
    }
  }

  // Todo lo visto se memoriza, salvo lo que no se pudo avisar (se reintenta).
  for (const b of entries) if (!retry.has(b.id)) seen.add(b.id);
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ updated_at: new Date().toISOString(), ids: [...seen] }, null, 2), 'utf8');
  return { checked: entries.length, fresh: fresh.length, notified, firstRun };
}

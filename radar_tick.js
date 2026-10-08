// radar_tick.js — Una pasada del radar (pensada para GitHub Actions, cron cada 10 min).
//
// Solo AVISA por Telegram: no reclama, no comenta, no abre PRs, no toca wallets.
// El trabajo (PR a mano) lo hace el usuario.
//
// Pasos: 1) vigilar PRs/issues puntuales (pr_watch)  2) buscar bounties nuevas
// (fetch_bounties, filtros relajados)  3) avisar de las que no se vieron antes.
//
// Config por env (todas opcionales):
//   RADAR_MIN_USD=15  RADAR_MAX_USD=3000  RADAR_QUALITY_MIN=1  RADAR_MAX_COMMENTS=40
//   RADAR_FRESH_HOURS=72  RADAR_MAX_AGE_DAYS=30  RADAR_MAX_MSGS=6  RADAR_DRY=1 (no envia)

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { sendNotification as realSend } from './telegram.js';
import { checkWatchedPRs } from './pr_watch.js';
import { checkVerdiktaFeed } from './verdikta_watch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(__dirname, 'sandbox_workspace');
const BOUNTIES_FILE = path.join(WORKSPACE, 'bounties_found.json');
const SEEN_FILE = path.join(WORKSPACE, 'radar_seen.json');
const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const env = (k, d) => Number(process.env[k] ?? d);
const MIN_USD = env('RADAR_MIN_USD', 15);
const MAX_USD = env('RADAR_MAX_USD', 3000);
const QUALITY_MIN = env('RADAR_QUALITY_MIN', 1);
const MAX_COMMENTS = env('RADAR_MAX_COMMENTS', 40);
const FRESH_HOURS = env('RADAR_FRESH_HOURS', 72);
const MAX_AGE_DAYS = env('RADAR_MAX_AGE_DAYS', 30);
const MAX_MSGS = env('RADAR_MAX_MSGS', 6);
const DRY = process.env.RADAR_DRY === '1';

const send = DRY ? async (m, o) => { console.log('[DRY]' + (o?.silent ? ' (silencioso)' : '') + ' ' + m + '\n'); return { ok: true }; } : realSend;
const log = (msg, meta = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...meta }));

// Repos que ya conocemos y cuyo pago nunca se confirmo (se avisa igual, con etiqueta).
const KNOWN_REPO_NOTES = [
  [/^susu-labs\//i, 'SUSU-LABS: el pago nunca se confirmo y los rivales mergean en horas; probabilidad baja'],
  [/^sampled-labs\//i, 'sampled-labs: repo de 1 dia con 100+ bounties, nadie dice como paga; pregunta antes de trabajar'],
];

const FUNDING_Q_RE = /(funded|sponsor|who (?:pays|will pay|approves)|commercial terms|payment (?:terms|method)|payout (?:method|terms)|is the (?:advertised )?(?:\$|usd)?\s?\d+)/i;

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}
async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}

function runFetch() {
  return new Promise((resolve) => {
    const args = [
      path.join(__dirname, 'fetch_bounties.js'),
      '--min', String(MIN_USD), '--max', String(MAX_USD),
      '--quality-min', String(QUALITY_MIN), '--max-comments', String(MAX_COMMENTS),
      '--max-age-days', String(MAX_AGE_DAYS), '--max-repos', '150',
      '--fresh-hours', String(FRESH_HOURS),
    ];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const killer = setTimeout(() => child.kill('SIGKILL'), 6 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, err: e.message }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ ok: code === 0, code, stderrTail: stderr.slice(-400) }); });
  });
}

function gh(pathname) {
  const r = spawnSync('gh', ['api', pathname], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// ¿Hay varios hunters preguntando si esta financiada y nadie del proyecto responde?
function assessFunding(repo, number) {
  if (!repo || !number) return { doubts: 0, unconfirmed: false };
  const issue = gh(`repos/${repo}/issues/${number}`);
  const comments = gh(`repos/${repo}/issues/${number}/comments?per_page=100`);
  if (!issue || !Array.isArray(comments)) return { doubts: 0, unconfirmed: false };
  const author = String(issue.user?.login || '').toLowerCase();
  const isMaint = (c) => /^(OWNER|MEMBER|COLLABORATOR)$/.test(c.author_association || '') ||
    String(c.user?.login || '').toLowerCase() === author;
  const qs = comments.filter((c) => !isMaint(c) && /\?/.test(c.body || '') && FUNDING_Q_RE.test(c.body || ''));
  if (!qs.length) return { doubts: 0, unconfirmed: false };
  const firstQ = Math.min(...qs.map((c) => new Date(c.created_at).getTime()));
  const answered = comments.some((c) => isMaint(c) && new Date(c.created_at).getTime() > firstQ);
  const botOk = comments.some((c) => /algora|opire|\[bot\]/i.test(c.user?.login || '') && /\$\s?\d/.test(c.body || ''));
  return { doubts: qs.length, unconfirmed: qs.length >= 2 && !answered && !botOk };
}

// Normaliza los dos formatos que produce fetch_bounties (bounties y human_only).
function normalize(b, humanWhy = null) {
  return {
    id: String(b.id),
    repo: b.repository?.full_name || b.repo || '',
    number: b.number,
    title: String(b.title || ''),
    url: b.url || '',
    amount: b.amount_usd ?? b.amount ?? null,
    currency: b.currency || 'USD',
    comments: b.comments ?? b.comments_count ?? null,
    created_at: b.created_at || null,
    body: String(b.body || ''),
    q: b.repo_quality_score ?? null,
    score: b.bounty_score ?? 0,
    signals: b.repo_quality_signals || {},
    payout_hints: b.payout_hints || [],
    humanWhy,
  };
}

function risksOf(n, funding) {
  const s = n.signals;
  const r = [];
  if (typeof s.age_days === 'number' && s.age_days < 14) r.push(`repo de solo ${s.age_days} dias`);
  if (typeof s.stars === 'number' && s.stars <= 2) r.push(`${s.stars} estrellas`);
  if (s.fresh_bait) r.push('patron de repo-cebo (nuevo y ya con bounties)');
  if (s.merged_prs_120d === 0) r.push('sin PRs mergeados en 120 dias');
  if (funding.unconfirmed) r.push(`${funding.doubts} personas preguntan si esta financiada y nadie del proyecto responde`);
  for (const [re, note] of KNOWN_REPO_NOTES) if (re.test(n.repo)) r.push(note);
  return r;
}

function ageText(iso) {
  if (!iso) return '?';
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  return h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} dias`;
}

function format(n, risks) {
  const tier = risks.length === 0 && (n.q ?? 0) >= 3 ? 'BUENA PINTA' : risks.length >= 3 ? 'CON CAUTELA' : 'REVISAR';
  return [
    `🔔 BOUNTY NUEVA [${tier}] — ${n.amount != null ? '$' + n.amount : '$?'} ${n.currency}`,
    `• ${n.repo}#${n.number}`,
    `• ${n.title.slice(0, 160)}`,
    `• ${n.url}`,
    `• Edad: ${ageText(n.created_at)} | Comentarios: ${n.comments ?? '?'} | Repo: ${n.signals.stars ?? '?'}★, ${n.signals.age_days ?? '?'} dias, q=${n.q ?? '?'}`,
    `• Pago mencionado: ${n.payout_hints.length ? n.payout_hints.join(', ') : 'no especifica'}`,
    n.humanWhy ? `• Nota: el filtro lo marco "para humanos" (${n.humanWhy})` : null,
    `• Riesgos: ${risks.length ? risks.join('; ') : 'ninguno evidente'}`,
    '',
    n.body.replace(/\s+\n/g, '\n').slice(0, 700),
    '',
    'Siguiente paso: lee el issue y, si hay duda de pago, pregunta como y cuando pagan ANTES de invertir horas. Revisa PRs rivales abiertos.',
  ].filter((l) => l !== null).join('\n').slice(0, 3900);
}

// Latido diario: cuantas pasadas automaticas hubo en 24 h (esperadas: 144 con cron cada 10 min).
async function heartbeat(itemsCount) {
  const repo = process.env.GITHUB_REPOSITORY;
  let line = 'no pude consultar las ejecuciones';
  if (repo) {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const r = spawnSync('gh', ['api', '--paginate',
      `repos/${repo}/actions/workflows/radar.yml/runs?event=schedule&per_page=100&created=>=${since}`,
      '--jq', '.workflow_runs[] | (.conclusion // "en_curso")'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status === 0) {
      const c = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
      const ok = c.filter((x) => x === 'success').length;
      const bad = c.filter((x) => x === 'failure' || x === 'timed_out').length;
      line = `${c.length} pasadas automaticas en 24 h (${ok} ok, ${bad} con error) de ~144 posibles = ${Math.round((c.length / 144) * 100)}%`;
    }
  }
  await send([
    '💓 Latido diario del radar (GitHub Actions)',
    `• ${line}`,
    `• Bounties en memoria: ${itemsCount} vistas (ultimos 30 dias)`,
    '• Referencia: 100-144 pasadas al dia es normal; GitHub atrasa o salta algunas. Menos de ~60, o ninguna, = revisar la pestaña Actions.',
    '• Si no ves este mensaje manana, el radar se cayo.',
  ].join('\n')).catch(() => {});
}

async function main() {
  if (process.env.RADAR_TEST === '1') {
    const r = await send('✅ Radar en la nube activo (GitHub Actions). Prueba de envio; si lees esto, los avisos llegan.');
    log('test_sent', { ok: r?.ok });
    if (r?.ok === false) process.exitCode = 1;
    return;
  }
  await fs.mkdir(WORKSPACE, { recursive: true });
  await checkWatchedPRs(send).catch((e) => log('pr_watch_threw', { err: e.message }));
  // Bounties de Verdikta (feed publico, sin clave): nuevas abiertas y dirigidas a nuestra wallet.
  await checkVerdiktaFeed(send, path.join(WORKSPACE, 'verdikta_seen.json'))
    .then((r) => log('verdikta_feed', r))
    .catch((e) => log('verdikta_feed_threw', { err: e.message }));

  const fr = await runFetch();
  if (!fr.ok) { log('fetch_failed', { code: fr.code, err: fr.err, tail: fr.stderrTail }); process.exitCode = 1; return; }
  const payload = await readJson(BOUNTIES_FILE, {});
  const items = [
    ...(Array.isArray(payload.bounties) ? payload.bounties : []).map((b) => normalize(b)),
    ...(Array.isArray(payload.human_only) ? payload.human_only : []).map((b) => normalize(b, b.why || 'reservada a humanos')),
  ];

  const seenDoc = await readJson(SEEN_FILE, null);
  const firstRun = !seenDoc;
  const seen = { ...(seenDoc?.ids || {}) };
  const now = Date.now();
  for (const [id, ts] of Object.entries(seen)) if (now - Number(ts) > SEEN_TTL_MS) delete seen[id];

  const fresh = [];
  for (const n of items) {
    if (!seen[n.id]) fresh.push(n);
    seen[n.id] = seen[n.id] || now;
  }
  fresh.sort((a, b) => (b.q ?? 0) - (a.q ?? 0) || (b.amount ?? 0) - (a.amount ?? 0));

  if (firstRun && process.env.RADAR_NO_BASELINE !== '1') {
    log('baseline', { total: items.length });
    await writeJson(SEEN_FILE, { updated_at: new Date().toISOString(), ids: seen });
    return;
  }

  // Repos-cebo (nuevos, sin estrellas y sin PRs mergeados): UN solo resumen SILENCIOSO
  // por pasada, sin detalle por issue. Son granjas que publican decenas de "bounties"
  // sin decir quien paga (visto 2026-10-08: 20+ avisos de golpe a las 3 am).
  const isBait = (n) => n.signals.fresh_bait ||
    (typeof n.signals.age_days === 'number' && n.signals.age_days < 14 &&
     (n.signals.stars ?? 0) <= 2 && n.signals.merged_prs_120d === 0);
  const bait = fresh.filter(isBait);
  const real = fresh.filter((n) => !isBait(n));
  let sent = 0;
  if (bait.length) {
    const repos = [...new Set(bait.map((n) => n.repo))];
    const total = bait.reduce((a, n) => a + (Number(n.amount) || 0), 0);
    const top = [...bait].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 5);
    const msg = [
      `🪤 ${bait.length} bounties nuevas de repos-cebo en ${repos.length} repos (suman $${total} en titulos)`,
      '• Repos de pocos dias, 0 estrellas y sin PRs mergeados: ninguna dice quien paga. Resumen silencioso, sin detalle por issue.',
      ...top.map((n) => `  - $${n.amount ?? '?'} ${n.repo}#${n.number}`),
      bait.length > top.length ? `  ... y ${bait.length - top.length} mas` : null,
    ].filter(Boolean).join('\n').slice(0, 3900);
    const res = await send(msg, { silent: true }).catch((e) => ({ ok: false, err: e.message }));
    if (res?.ok === false) { for (const n of bait) delete seen[n.id]; log('notify_failed', { kind: 'bait', err: res.err }); }
    else { sent++; log('notified_bait', { count: bait.length, repos: repos.length }); }
  }

  // Un mismo repo (no cebo) con 3+ bounties nuevas de golpe: un solo aviso agrupado.
  const byRepo = new Map();
  for (const n of real) byRepo.set(n.repo, [...(byRepo.get(n.repo) || []), n]);
  const grouped = new Set();
  for (const [repo, list] of byRepo) {
    if (list.length < 3) continue;
    const s = list[0].signals;
    const total = list.reduce((a, n) => a + (Number(n.amount) || 0), 0);
    const msg = [
      `🔔 ${list.length} BOUNTIES NUEVAS EN UN MISMO REPO — ${repo} (suman $${total} en titulos)`,
      `• Repo: ${s.stars ?? '?'}★, ${s.age_days ?? '?'} dias${s.fresh_bait ? ', patron de repo-cebo (nuevo y ya con muchas bounties)' : ''}`,
      `• Ninguna dice quien paga ni como: pregunta en UNA y espera respuesta antes de trabajar`,
      ...list.map((n) => `  - $${n.amount ?? '?'} ${n.title.slice(0, 90)}\n    ${n.url}`),
    ].join('\n').slice(0, 3900);
    const res = await send(msg).catch((e) => ({ ok: false, err: e.message }));
    if (res?.ok === false) { for (const n of list) delete seen[n.id]; log('notify_failed', { repo, err: res.err }); }
    else { sent++; log('notified_group', { repo, count: list.length }); }
    for (const n of list) grouped.add(n.id);
  }

  const overflow = [];
  for (const n of real) {
    if (grouped.has(n.id)) continue;
    if (sent >= MAX_MSGS) { overflow.push(n); continue; }
    const funding = assessFunding(n.repo, n.number);
    const res = await send(format(n, risksOf(n, funding))).catch((e) => ({ ok: false, err: e.message }));
    if (res?.ok === false) { delete seen[n.id]; log('notify_failed', { id: n.id, err: res.err }); continue; } // reintenta en el proximo ciclo
    sent++;
    log('notified', { id: n.id, repo: n.repo, number: n.number, amount: n.amount });
  }
  if (overflow.length) {
    await send(`🔔 ${overflow.length} bounties nuevas mas (tope de ${MAX_MSGS} avisos por pasada):\n` +
      overflow.map((n) => `• $${n.amount ?? '?'} ${n.repo}#${n.number} ${n.url}`).join('\n')).catch(() => {});
  }
  await writeJson(SEEN_FILE, { updated_at: new Date().toISOString(), ids: seen });
  log('tick_done', { total: items.length, fresh: fresh.length, sent, overflow: overflow.length });
}

main()
  .then(async () => {
    if (process.env.RADAR_HEARTBEAT !== '1') return;
    const seenDoc = await readJson(SEEN_FILE, { ids: {} });
    await heartbeat(Object.keys(seenDoc.ids || {}).length);
  })
  .catch((e) => { log('radar_crashed', { err: e.message }); process.exit(1); });

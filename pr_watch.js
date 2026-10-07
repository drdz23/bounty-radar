// pr_watch.js — Monitoreo directo de PRs puntuales (no del radar de bounties).
//
// El usuario pide seguir un PR especifico (ej. verdikta#44) y que CUALQUIER
// respuesta nueva (comentario, review, merge, cierre) le llegue por Telegram
// de forma clara. Esto es independiente del flujo de bounties: se agrega una
// entrada a sandbox_workspace/pr_watchlist.json y bounty_watch.js llama a
// checkWatchedPRs() en cada tick (cada 10 min) sin gastar llamadas API extra
// significativas (1-2 requests por PR seguido).
//
// Estado de "ya visto" en sandbox_workspace/pr_watch_seen.json — evita avisar
// dos veces el mismo comentario/review.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(__dirname, 'sandbox_workspace');
const WATCHLIST_FILE = path.join(WORKSPACE, 'pr_watchlist.json');
const SEEN_FILE = path.join(WORKSPACE, 'pr_watch_seen.json');
const GH = 'https://api.github.com';

function resolveGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function ghFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-wallet-mcp/pr_watch',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

async function writeJsonAtomic(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

export async function addWatchedPR(owner, repo, number, { label = null } = {}) {
  const list = await readJson(WATCHLIST_FILE, []);
  const key = `${owner}/${repo}#${number}`;
  if (!list.some((w) => `${w.owner}/${w.repo}#${w.number}` === key)) {
    list.push({ owner, repo, number, label, addedAt: new Date().toISOString() });
    await writeJsonAtomic(WATCHLIST_FILE, list);
  }
  return key;
}

export async function removeWatchedPR(owner, repo, number) {
  const list = await readJson(WATCHLIST_FILE, []);
  const key = `${owner}/${repo}#${number}`;
  const next = list.filter((w) => `${w.owner}/${w.repo}#${w.number}` !== key);
  await writeJsonAtomic(WATCHLIST_FILE, next);
  return next.length !== list.length;
}

function fmtEvent(w, kind, item) {
  const base = `${w.owner}/${w.repo}#${w.number}${w.label ? ` (${w.label})` : ''}`;
  const url = `https://github.com/${w.owner}/${w.repo}/pull/${w.number}`;
  if (kind === 'comment') {
    return [
      `PR ${base} — nuevo comentario`,
      `De: ${item.user?.login}`,
      String(item.body || '').slice(0, 500),
      item.html_url || url,
    ].join('\n');
  }
  if (kind === 'review') {
    const stateEs = { APPROVED: 'APROBÓ', CHANGES_REQUESTED: 'PIDIÓ CAMBIOS', COMMENTED: 'comentó' }[item.state] || item.state;
    return [
      `PR ${base} — review: ${stateEs}`,
      `De: ${item.user?.login}`,
      String(item.body || '').slice(0, 500),
      item.html_url || url,
    ].join('\n');
  }
  if (kind === 'state') {
    const what = item.merged ? 'MERGEADO 🎉' : item.state === 'closed' ? 'CERRADO sin mergear' : item.state;
    return [`PR ${base} — ${what}`, url].join('\n');
  }
  return `PR ${base} — actividad nueva\n${url}`;
}

export async function checkWatchedPRs(sendNotification) {
  const list = await readJson(WATCHLIST_FILE, []);
  if (!list.length) return;
  const token = resolveGithubToken();
  const seenDoc = await readJson(SEEN_FILE, {});

  for (const w of list) {
    const key = `${w.owner}/${w.repo}#${w.number}`;
    const isNew = !seenDoc[key];
    const seen = seenDoc[key] || { comments: [], reviews: [], state: null, merged: false };
    // La primera vez que se ve un item se registra en silencio: solo avisa lo que llegue DESPUES.
    const notify = isNew ? async () => {} : sendNotification;
    try {
      // Puede ser un PR o un issue (p. ej. un bounty donde preguntamos como pagan):
      // si /pulls/N no existe, se vigilan solo los comentarios.
      const [pr, comments, reviews] = await Promise.all([
        ghFetch(`${GH}/repos/${w.owner}/${w.repo}/pulls/${w.number}`, token).catch(() => null),
        ghFetch(`${GH}/repos/${w.owner}/${w.repo}/issues/${w.number}/comments?per_page=100`, token),
        ghFetch(`${GH}/repos/${w.owner}/${w.repo}/pulls/${w.number}/reviews`, token).catch(() => []),
      ]);

      for (const c of comments) {
        if (seen.comments.includes(c.id)) continue;
        await notify(fmtEvent(w, 'comment', c));
        seen.comments.push(c.id);
      }
      for (const r of reviews) {
        if (!r.body && r.state === 'COMMENTED') continue; // review vacía (solo comentarios inline ya cubiertos aparte)
        if (seen.reviews.includes(r.id)) continue;
        await notify(fmtEvent(w, 'review', r));
        seen.reviews.push(r.id);
      }
      if (pr && (seen.state !== pr.state || (pr.merged && !seen.merged))) {
        // Evita el aviso "OPEN" inicial la primera vez que se agrega el PR.
        if (seen.state !== null) await notify(fmtEvent(w, 'state', pr));
        seen.state = pr.state;
        seen.merged = !!pr.merged;
      }
    } catch (e) {
      // No tirar el ciclo del radar por un PR que falle (rate limit, 404, etc.)
      console.warn(`[pr_watch] fallo revisando ${key}: ${e.message}`);
    }
    seenDoc[key] = seen;
  }
  await writeJsonAtomic(SEEN_FILE, seenDoc);
}

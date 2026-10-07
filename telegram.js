// telegram.js
// Wrapper limpio del Bot API de Telegram.
//
// - Si TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no estan en .env, hace fallback a
//   un mock en stdout (util para desarrollo y CI).
// - Dedup: si el mismo mensaje (normalizado) se envia mas de MAX_DUP_PER_MIN
//   veces en 60s, se descarta silenciosamente. Evita spam cuando el orquestador
//   entra en un bucle.
// - Errores de red NO matan el proceso: se loguean y se devuelven al caller.

import dotenv from "dotenv";
import { setTimeout as wait } from "node:timers/promises";

dotenv.config();

const MAX_DUP_PER_MIN = Number(process.env.TELEGRAM_MAX_DUP_PER_MIN || 5);
const RETRY_ATTEMPTS  = Number(process.env.TELEGRAM_RETRY_ATTEMPTS  || 2);
const RETRY_BASE_MS   = Number(process.env.TELEGRAM_RETRY_BASE_MS   || 400);

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

const recentHashes = []; // [{ h, ts }]
function trackAndCheckDuplicate(text) {
  const h = simpleHash(text);
  const now = Date.now();
  while (recentHashes.length && (now - recentHashes[0].ts) > 60_000) recentHashes.shift();
  const sameWindow = recentHashes.filter((x) => x.h === h).length;
  if (sameWindow >= MAX_DUP_PER_MIN) return true;
  recentHashes.push({ h, ts: now });
  return false;
}

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

async function postMessage(text) {
  if (!token || !chatId) {
    console.log("[TELEGRAM MOCK]:", text);
    return { ok: true, mock: true };
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // SIN parse_mode: "Markdown". Los mensajes incluyen nombres de repo/rama y
  // títulos de issue con `_`, `*`, backticks sin balancear → la API devolvía
  // HTTP 400 "can't parse entities" y la notificación se perdía en silencio.
  // Enviamos texto plano (quitamos los marcadores markdown cosméticos).
  const plainText = String(text).replace(/[*`]/g, "");
  const body = JSON.stringify({
    chat_id: chatId,
    text: plainText,
    disable_web_page_preview: true,
  });
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (r.ok) return { ok: true };
      const detail = await r.text().catch(() => "");
      lastErr = `HTTP ${r.status}: ${detail.slice(0, 200)}`;
    } catch (e) {
      lastErr = e.message || String(e);
    }
    if (attempt < RETRY_ATTEMPTS) await wait(RETRY_BASE_MS * (attempt + 1));
  }
  console.error("[TELEGRAM ERROR]:", lastErr);
  return { ok: false, err: lastErr };
}

/**
 * Envia una notificacion a Telegram.
 * Devuelve { ok, deduped, mock, err? }.
 * Nunca lanza.
 */
export async function sendNotification(message) {
  if (typeof message !== "string" || !message.trim()) {
    return { ok: false, deduped: false, err: "empty_message" };
  }
  if (trackAndCheckDuplicate(message)) {
    return { ok: true, deduped: true };
  }
  return postMessage(message);
}

export default { sendNotification };

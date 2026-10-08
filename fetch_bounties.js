import 'dotenv/config';
// fetch_bounties.js — Descubridor de bounties (v2)
//
// =====================================================================
// ESTRATEGIA
// =====================================================================
// 1) Fuente = búsqueda de issues de GitHub (API documentada y estable) por
//    varias variantes de label "bounty" + montos en el título.
// 2) Blocklist de GRANJAS: repos y patrones de "dale star por 1 token",
//    "[Bounty][Bounty][Bounty]...", airdrops, engagement farming.
// 3) FILTRO DE CALIDAD DE REPO (la palanca nº1 para tasa de merge real):
//    se evalúa cada repo candidato una vez —con caché— sobre señales
//    objetivas: actividad de mantenedores, si mergea PRs externos,
//    CONTRIBUTING, backlog razonable, no archivado/fork, lenguaje.
// 4) Scoring valor/dificultad + rango de monto, igual que antes.
//
// Salida: sandbox_workspace/bounties_found.json (mismo esquema que consume
// orchestrator.js / bounty_pipeline.js). NUNCA bounties mock.
//
// Algora/Gitcoin: sus APIs públicas están caídas o sin documentar. Si
// quieres una bounty concreta de Algora, pásala a mano por --repo en el
// orquestador o siembra bounties_found.json.
// =====================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(__dirname, 'sandbox_workspace', 'bounties_found.json');
const CACHE_PATH = path.join(__dirname, 'sandbox_workspace', 'repo_quality_cache.json');

// ── CLI ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const getStr = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const MIN_USD = getArg('--min', 50);
const MAX_USD = getArg('--max', 5000);
const MIN_SCORE = getArg('--min-score', 1.0);
const OUT_PATH = getStr('--out', DEFAULT_OUT);
const PER_PAGE = getArg('--per-page', 100);
// Por defecto EXIGIMOS monto explícito (payout verificable). --allow-unknown-amount
// lo relaja (útil para plataformas que ponen el monto fuera del texto del issue).
const STRICT_AMOUNT = !args.includes('--allow-unknown-amount');
// Cuántos repos únicos evaluar por ciclo (cada uno = ~3 llamadas API).
// 150 con margen de sobra: assessRepoQuality gasta ~2 llamadas core/repo
// (repo info + closed-pulls), 150×2=300/ciclo sobre 5000/hora — ni de lejos
// toca el límite (~6% a 6 ciclos/hora). Antes con 40 se evaluaba solo ~15%
// de los ~260-330 candidatos que la propia búsqueda encontraba cada ciclo,
// y en ORDEN ARBITRARIO (el de llegada de la API) — una bounty real de $300
// podía caer en el candidato #200 y nunca evaluarse. Ver ordenamiento por
// prioridad más abajo antes del slice.
const MAX_REPOS_ASSESS = getArg('--max-repos', 150);
// Issues con más comentarios que esto = disputadas (muchos /attempt, PRs
// competidores). Aunque hagamos un parche perfecto, la bounty se la lleva
// otro. El valor real del agente está en llegar PRONTO, no a la pila.
const MAX_COMMENTS = getArg('--max-comments', 15);
// Solo issues creadas en las últimas N horas (0 = sin límite). Para la
// estrategia "cázala fresca antes de que se forme la cola".
const FRESH_HOURS = getArg('--fresh-hours', 0);
// Tope DURO de antigüedad (días). Incluso sin --fresh-hours nunca tocamos
// un issue viejísimo: para entonces está reclamado o adjudicado. 0 = sin tope.
const MAX_AGE_DAYS = getArg('--max-age-days', 45);
// Umbral de calidad de repo [ver assessRepoQuality]. 3 = conservador.
const QUALITY_MIN = getArg('--quality-min', 3);
const QUALITY_TTL_MS = getArg('--quality-ttl-ms', 7 * 24 * 60 * 60 * 1000);
// Idiomas aceptados (primary language del repo). null también pasa.
// El sandbox Docker ejecuta JS/TS (bun/npm) y Python (pytest). Para Go/Rust/
// Foundry hay que añadir toolchain en Dockerfile.bounty-sandbox +
// audit_engine.detectEcosystem, o sus bounties caen en needs_review.
const ALLOWED_LANGS = new Set(['JavaScript', 'TypeScript', 'HTML', 'CSS', 'Vue', 'Svelte', 'MDX', 'Python', 'Rust', 'Go']);

// Deny-list Python: ML / GPU / científico pesado. El sandbox no tiene GPU ni
// puede instalar torch/cuda/etc. — reclamar estas = fallo garantizado.
const PY_HEAVY_RE =
  /\b(pytorch|torch|tensorflow|\bkeras\b|\bjax\b|cuda|cudnn|\bgpu\b|nvidia|transformers|huggingface|\bvllm\b|llama\.cpp|diffusers|xformers|deepspeed|bitsandbytes|onnxruntime-gpu|triton-lang|megatron)\b/i;

// Deny-list Rust: web3/blockchain que necesita toolchains extra que el sandbox
// no tiene (anchor, cargo-build-sbf, cargo-contract, substrate/polkadot) o
// que compila targets embebidos. `cargo test` a secas cubre CLIs y libs.
const RUST_HEAVY_RE =
  /\b(anchor-lang|anchor-spl|solana-program|cargo-build-sbf|sbf|bpf|cargo-contract|ink!|substrate|polkadot-sdk|frame-support|near-sdk|cosmwasm|soroban-sdk|no_std|embedded-hal|riscv|wasm32-unknown)\b/i;

// Deny-list Go: monorepos/forks gigantes cuyo `go build ./...` en frío revienta
// el timeout y el disco del sandbox (geth, cosmos, k8s, etcd…).
const GO_HEAVY_RE =
  /\b(go-ethereum|geth\b|cosmos-sdk|tendermint|cometbft|kubernetes\/kubernetes|\betcd\b|hashicorp\/(vault|consul|nomad|terraform)|prometheus\/prometheus|grafana\/grafana|containerd|moby\/moby|istio\b)\b/i;

// ── Señales de "esta bounty ya no está disponible" o "no es tarea de código" ──
const AWARDED_RE = /\b(awarded to|assigned to\s+@|winner\s*[:=]|bounty (?:has been |is )?(?:claimed|awarded|paid)|paid ?out to|closed to (?:new )?submissions|no longer (?:accepting|available)|solution (?:selected|chosen))\b/i;
const NON_CODE_RE = /(findings?\s+report|write[- ]?ups?\b|\binvestigat(?:e|ion|ing)\b|research\s+report|benchmark\s+report|\bproposal\b|design\s+doc|\bRFC\b|\bsurvey\b|audit\s+report|end-to-end test\b.*\breport\b|clean full run)/i;
const CODE_SIGNAL_RE = /\b(fix|bug|error|crash|regression|implement|add support|broken|fails?|failing|exception|stack ?trace|patch|refactor|typo|incorrect|unexpected|does ?n'?t work|not working|repro)\b/i;
// Etiquetas que indican que la bounty YA está resuelta/pagada/adjudicada.
// (fundsflow#6 traía "Bounty Paid ✅" y aun así pasó el filtro de texto.)
const DONE_LABEL_RE = /(bounty\s*paid|✅|paid\b|payout|completed?\b|resolved\b|claimed\b|awarded\b|assigned\b|in[\s-]?progress|\bwip\b|competition|contested|in[\s-]?review)/i;
const labelNames = (it) => (it.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name) || '').filter(Boolean);

const GH = 'https://api.github.com';

// ── EXCLUSIÓN PERMANENTE: protocolos en producción (defensa en profundidad) ──
const EXCLUDED_PRODUCTION_REPOS = new Set([
  'ethereum-optimism/optimism', 'ethereum/go-ethereum', 'wevm/viem',
  'scaffold-eth/scaffold-eth-2', 'walletconnect/web3modal',
  'filecoin-project/filecoin-client', 'protocolguild/membership',
  'Uniswap/v3-core', 'Uniswap/v4-core', 'aerodrome-finance/contracts',
  'solana-labs/solana', 'foundry-rs/foundry', 'aave/aave-v3-core',
  'aave/aave-v3-periphery', 'compound-finance/compound-protocol',
  'makerdao/dss', 'sushiswap/sushiswap', 'curvefi/curve-contract',
  'balancer/balancer-core', 'pancakeswap/pancake-smart-contracts',
  'yearn/yearn-vaults', 'lidofinance/lido-dao', 'rocket-pool/rocketpool',
  'prysmaticlabs/prysm', 'consensys/teku', 'sigp/lighthouse',
  'ethereum/web3.py', 'ethereumjs/ethereumjs-monorepo', 'hyperledger/besu',
]);

// ── GRANJAS conocidas — descarte inmediato ────────────────────────────
const SPAM_REPOS = new Set([
  'scottcjn/rustchain-bounties',
  'auscaster/frantic-board',
  'zhangjiayang6835-cyber/bounty-plaza',
  'securebananalabs/bug-bounty',
  'cuentaprueba244w-dotcom/tentoftrials',
  'xevrion/v2-agent-playground',
  'illbnm/homelab-stack',
]);

// Dueños (orgs/usuarios) cuya actividad es sistemáticamente granja-cebo:
// muchos repos con "[Bounty] test X" y ritmo de merges impropio. Descarte
// de CUALQUIER repo suyo. (Uuriko/dasha-* marcado merge_farm; Ikalus1988/
// MisakaNet reaparece cada ciclo con tareas de relleno.)
// Dueños confirmados como granja-cebo (0-2★, días de antigüedad, repos "test",
// merge_farm, redes de repos autogenerados) o esquemas de auto-pago.
//   - uuriko            : dasha-* (repo creado el mismo día que el issue, "bounty loop")
//   - scottcjn          : rustchain-bounties + ram-coffers/beacon-skill
//   - meshpilot-agi     : merge_farm, 2 días de antigüedad
//   - musicjapanllc     : repo llamado literalmente "test", merge_farm
//   - nexaitechau       : 20 repos autogenerados en 2 días, todos 0★ (nex-*, org-157-algora-io-algora)
//   - bishopbethel      : fundsflow — funda bounties vía DevAsign y se paga a SÍ MISMO
//   - ikalus1988        : MisakaNet — proyecto REAL (433★) pero TODAS sus bounties
//                         son status:competition + dependientes de la CLI `dsh` +
//                         "corre esto y reporta" (matriz multi-OS). No son diffs
//                         y el sandbox no puede verificarlas. NON_CODE_RE no las
//                         pilla ("test suite"). Su programa de bounties no encaja.
// NO está: lilly-protocol (49★, org real con 44 bounties pagadas — el anti-burst
// ya evita las ráfagas de 20-agentes/$100, que es lo indeseable).
const SPAM_OWNERS = new Set([
  'uuriko',
  'scottcjn',
  'meshpilot-agi',
  'musicjapanllc',
  'nexaitechau',
  'bishopbethel',
  'ikalus1988',
  // engurulabory: repo de 0★/19 días, "AEC™/KârMatik™" — un solo usuario
  // simulando un "agente económico autónomo"; resurge cada tanto sin bounty
  // real (el monto lo saca de una cifra mencionada en el cuerpo sobre OTRO repo).
  'engurulabory',
  // podzemniytip: issue "arreglé un bug, ¿me pagás $X si lo aceptás?" auto-
  // declarado "not a claim on an existing bounty" + un 2º bot ajeno (OgK1lua)
  // spameando 7 comentarios idénticos — granja-cebo para bounty-hunters.
  'podzemniytip',
]);

// Un repo que vuelca MUCHAS issues "[Bounty: $X]" de golpe en un solo fetch es
// una granja cebando agentes (Lilly-Protocol soltó 22 a la vez). Se descartan
// todas las de ese repo en la pasada.
const BURST_MAX_PER_REPO = Number(getArg('--burst-max', 6));

// ── ORGS DE CONFIANZA — empresas dev-tool que pagan bounties de verdad ──
// Se buscan sus repos directamente (labels no estándar / monto en Algora),
// se saltan el gate de calidad y NO exigen monto explícito en el issue.
// Los filtros DUROS (spam, ya-adjudicada, assignee, no-código) siguen.
const TRUSTED_REPOS = new Set([
  'documenso/documenso', 'appwrite/appwrite', 'triggerdotdev/trigger.dev',
  'novuhq/novu', 'twentyhq/twenty', 'tldraw/tldraw', 'coollabsio/coolify',
  'unkeyed/unkey', 'infisical/infisical', 'windmill-labs/windmill',
  'activepieces/activepieces', 'teableio/teable', 'refinedev/refine',
  'medusajs/medusa', 'payloadcms/payload', 'directus/directus',
  'hoppscotch/hoppscotch', 'lightdash/lightdash', 'openstatushq/openstatus',
  'dittofeed/dittofeed', 'maybe-finance/maybe', 'elie222/inbox-zero',
  'rivet-gg/rivet', 'boxyhq/saas-starter-kit', 'toeverything/affine',
].map((r) => r.toLowerCase()));

// Fragmenta los repos de confianza en grupos para queries `repo:a repo:b …`.
// Sólo con SEÑAL REAL de bounty (label Algora o comando `/bounty $`); un issue
// suelto en un repo de confianza NO es una bounty.
function trustedRepoQueries() {
  const repos = [...TRUSTED_REPOS];
  const chunks = [];
  for (let i = 0; i < repos.length; i += 8) chunks.push(repos.slice(i, i + 8));
  const out = [];
  for (const c of chunks) {
    const scope = c.map((r) => `repo:${r}`).join(' ');
    out.push(`is:issue is:open ${scope} label:"💎 Bounty"`);
    out.push(`is:issue is:open ${scope} "/bounty $" in:comments`);
  }
  return out;
}

// Patrones de engagement farming + "granjas-cebo para agentes autónomos"
// (repos creados para atraer bots de bounty-hunting) en owner/repo, título o cuerpo.
const SPAM_RE =
  /(bounty[-_ ]?(plaza|farm|hub|pool|fleet|bot|radar|lens)|[-_/]bounties\b|universal[-_ ]?bounty|agent[-_ ]?(bounties|playground|fleet)|rustchain|frantic[-_ ]?board|tent[-_ ]?of[-_ ]?trials|\bRTC\b|\bBoTTube\b|elyan[-_ ]?labs|clawhub|airdrop|engagement[-_ ]?(pool|reward)|test[-_ ]?repo\b|openbuild[-_ ]?gallery|(star|follow|retweet|subscribe|join)\s+(our|the|my|3|five|\d+)\s+(repo|repos|channel|discord|telegram|account))/i;

// Contenido-cebo: tareas "meta" sobre bounties, referidos/afiliados y
// rellenos genéricos que abundan en granjas para agentes.
const BAIT_CONTENT_RE =
  /(grants?\s*(?:&|and)\s*bounties|bounty\s+(?:activity|program|explorer|dashboard|vertical|leaderboard)|responsible\s+disclosure\s+(?:program|policy)|referral\s+code|affiliate\s+link|credit\s+to\s+the\s+reader|悬赏)/i;

// "Propuestas especulativas" — issues que PARECEN un fix con bounty pero son
// en realidad un cold-pitch: "arreglé esto, ¿me pagás $X si lo aceptás?".
// No hay bounty real detrás (nadie la fondeó), así que aunque el cuerpo tenga
// señales de código y hasta un monto en $, hay que rechazarla igual. Visto en
// podzemniytip/shipradar#1 (auto-declarado "This is a proposal, not a claim
// on an existing bounty", + un segundo bot -OgK1lua- spameando 7 comentarios
// idénticos — huele a granja diseñada para atraer bounty-hunters autónomos).
const SPECULATIVE_PITCH_RE =
  /(not a claim on an? existing bounty|this is a proposal,?\s*not\b|would you sponsor|payable\s+(?:after|upon)\s+acceptance|please confirm the payment method|prepared\s+(?:and\s+tested\s+)?with an? AI\s+(?:coding\s+)?assistant)/i;

// "Payout requests" — un CONTRIBUYENTE (no nosotros) pidiéndole al maintainer
// que le PAGUE por PRs que YA MERGEÓ. No es una tarea abierta: no hay nada
// que programar, el "$1,295" es la factura de otra persona por trabajo
// terminado. Visto en Movalabs-crew/mova-store#434/#435 (título
// "[Payout Request] Consolidated Bounty Claim for N Merged PRs (@user — $X)"),
// nuestro fetcher lo tomó como bounty de $1,295 y el agente comentó un claim
// en el hilo de facturación de otra persona.
// Aviso de OTRO agente/bot informando que ÉL YA reclamó una bounty en una
// plataforma externa (on-chain, poidh.xyz, etc.) — no es una tarea abierta,
// es solo un "heads up" para el issuer de esa plataforma. Nada que hacer,
// nada que reclamar. Visto en picsoritdidnthappen/poidh-app#1530/#1532 y
// jpfraneto/menloapp#7: "Onchain claim tx: 0x...", "awaiting issuer
// acceptance", "submitted by an autonomous AI agent operated by the
// claimant" — el agente comentó "quiero trabajar en esto" en avisos ajenos.
const THIRD_PARTY_CLAIM_NOTICE_RE =
  /onchain claim\b|awaiting (?:issuer )?acceptance|submitted (?:by|as) an? autonomous ai agent|open claims? on .* bount(?:y|ies).*awaiting review|reward signal\b|ranked opportunit|not guaranteed payouts|no task is automatically claimed/i;

const PAYOUT_REQUEST_RE =
  /^\s*\[payout request\]|consolidated\s+(?:bounty\s+)?claim\s+for\s+\d+\s+merged\s+prs|payout\s+request\s*:\s*consolidated/i;

// Bounties REALES pero reservadas a humanos ("HUMAN ONLY", "NO AI"). El agente
// no las puede tomar (y reclamarlas viola la regla del dueño), pero no se
// descartan en silencio: van a `human_only` y el radar avisa por Telegram.
const HUMAN_ONLY_RE =
  /(humans?\s+only|only\s+humans?\b|no\s+(?:automated\s+\w+|ai|a\.i\.|bots?|llms?)\b|no\s+ai[- ]generated|not\s+(?:for|open\s+to)\s+(?:ai|bots?|agents?)\b|for\s+a\s+human\s+to\b|(?:ai|bots?|agents?)\s+(?:are\s+)?not\s+(?:allowed|eligible))/i;

function toHumanEntry(b, why, comments = null) {
  const text = `${b.title}\n${b.body || ''}`;
  const currency = /(?:€|\bEUR(?:OS?)?\b)/i.test(text) ? 'EUR'
    : /\bUSDC\b/i.test(text) ? 'USDC'
    : /\bUSDT\b/i.test(text) ? 'USDT' : 'USD';
  const payout_hints = [...new Set((text.match(/\b(paypal|usdc|usdt|crypto|bitcoin|btc|eth|wise|stripe|polar|venmo|algora|opire|bank transfer|wire transfer)\b/gi) || []).map((s) => s.toLowerCase()))];
  return {
    id: b.id, number: b.number, title: b.title, url: b.url,
    repo: b.repository?.full_name, amount: b.amount_usd, currency,
    comments, created_at: b.created_at,
    body: String(b.body || '').slice(0, 1500),
    why, payout_hints,
    repo_quality_score: b.repo_quality_score, repo_quality_signals: b.repo_quality_signals,
  };
}

// Repeticiones tipo "[Bounty] [Bounty] [Bounty] ..." → spam.
function tagSpam(title) {
  const tags = (String(title || '').match(/\[(bounty|funding|reward)\]/gi) || []).length;
  return tags >= 3;
}

// Señal ESTRUCTURAL (no depende de una frase concreta): un issue que enlaza
// a issues de 3+ repos AJENOS distintos es el reporte/digest de OTRO bot
// cazador de bounties listando SUS hallazgos — no una tarea sobre este repo.
// Visto en vivo: ariahendrawan-sudo/project-a#2 ("Bounty Scout"), un digest
// semanal con una tabla que enlazaba issues de 10 repos distintos y traía
// montos $ reales de ESAS bounties ajenas, no de este issue. Como generaliza
// por estructura (no por texto), cubre variantes futuras sin depender de que
// el bot de turno use las mismas palabras que el anterior.
function isDigestOrReport(body, ownRepo) {
  const matches = String(body || '').match(/github\.com\/([^\/\s)]+\/[^\/\s)]+)\/issues\/\d+/gi) || [];
  const own = String(ownRepo || '').toLowerCase();
  const distinctOtherRepos = new Set(
    matches
      .map((m) => (m.match(/github\.com\/([^\/\s)]+\/[^\/\s)]+)\/issues\/\d+/i) || [])[1])
      .filter(Boolean)
      .map((r) => r.toLowerCase())
      .filter((r) => r !== own)
  );
  return distinctOtherRepos.size >= 3;
}

// ── GitHub helpers ────────────────────────────────────────────────────
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghFetch(url, token, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'agent-wallet-mcp/fetch_bounties',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      const waitMs = Math.min(Math.max(reset - Date.now(), 2000), 30_000);
      console.warn(`[fetch_bounties] rate-limit ${res.status}, esperando ${Math.round(waitMs / 1000)}s`);
      if (attempt < retries) { await sleep(waitMs); continue; }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`GitHub HTTP ${res.status}`);
      err.status = res.status;
      err.body = body.slice(0, 300);
      throw err;
    }
    return res.json();
  }
  throw new Error('ghFetch: reintentos agotados');
}

// ── Clasificador LLM de última línea (hallazgo #6 de la auditoría) ────
// Los regexes (SPECULATIVE_PITCH_RE, PAYOUT_REQUEST_RE, SPAM_RE...) son
// reactivos: cada patrón nuevo de granja/estafa se detectó DESPUÉS de que
// ya pasó, cuando alguien (yo) lo notó y escribió un regex a mano. Esto no
// generaliza — la próxima variante de "no es una bounty real" que use
// palabras distintas se cuela igual.
//
// Este paso corre SOLO sobre la lista final corta (post todo-lo-demás,
// típicamente 0-5 candidatos por ciclo) — una sola llamada LLM que evalúa
// todos juntos, así el costo es insignificante (~1 llamada barata cada
// 10 min, no por cada una de las ~300 candidatas crudas).
//
// Fail-open a propósito: si el LLM falla, no arma bien el JSON, o no hay
// LLM_API_KEY, NO bloquea nada — los filtros regex ya hicieron su trabajo;
// esto es una red de seguridad extra, no un gate del que dependa el pipeline.
async function classifyBountiesWithLLM(bounties, humanSink = []) {
  if (!bounties.length) return bounties;
  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return bounties;

  const SYSTEM = `Sos un filtro anti-fraude para un agente autónomo que caza bounties de código reales en GitHub.
Te paso una lista de issues que YA pasaron filtros de palabras clave. Tu trabajo es la última línea de defensa: decidir si cada una es una bounty REAL, FONDEADA, y RECLAMABLE por un tercero — o si es otra cosa.

Marcá real_bounty=false si es cualquiera de estos patrones (u otro con el mismo espíritu, aunque use palabras distintas):
- Un CONTRIBUYENTE pidiéndole al maintainer que le PAGUE por trabajo que YA mergeó (factura/reconciliación, no una tarea abierta).
- Una PROPUESTA especulativa: "arreglé esto, ¿me pagarías $X si lo aceptás?" — sin bounty confirmada de antemano.
- Una granja/cebo para agentes autónomos: jerga inventada tipo "agente económico verificado", auto-reportes de un solo usuario, repos de días de antigüedad simulando actividad.
- Una tarea que menciona un monto en $ que en realidad describe OTRO issue/repo, no el suyo propio.
- Cualquier issue donde el monto en dólares no está claramente asociado a UNA RECOMPENSA por resolver ESE issue específico.

Si la bounty es real pero está reservada a humanos (excluye explícitamente IA/bots/agentes) o exige una tarea que un agente de código no puede hacer (juzgar, opinar, decidir, revisar de forma subjetiva), marcá real_bounty=true y human_only=true (el usuario la hará a mano).

Marcá real_bounty=true solo si hay una señal clara y directa de que resolver ESE issue paga esa cantidad (label de plataforma tipo Algora/Opire, comentario del maintainer confirmando el monto, o un formato de bounty estándar y coherente).

Ante la duda genuina, marcá real_bounty=true (preferí un falso positivo — que ya lo filtran otras capas — a bloquear una bounty real).

Respondé SOLO con un array JSON, sin texto extra: [{"i": <índice>, "real_bounty": true|false, "human_only": true|false, "reason": "<motivo en <15 palabras>"}]`;

  const items = bounties.map((b, i) =>
    `${i}) repo=${b.repository?.full_name} monto=$${b.amount_usd ?? '?'} título="${String(b.title || '').slice(0, 150)}"\ncuerpo: ${String(b.body || '').slice(0, 500).replace(/\n+/g, ' ')}`
  ).join('\n\n');

  // Mismos modelos que ya usa brain.js (misma cuenta/cuota) — nunca inventar
  // un nombre de modelo hardcodeado: gemini-2.5-flash y gemini-2.0-flash ya
  // están retirados (404) al momento de escribir esto. gemini-3.6-flash a
  // veces satura (503 "high demand"), de ahí el fallback + 2 intentos.
  const models = [...new Set([
    process.env.LLM_MODEL || 'gemini-3.6-flash',
    process.env.LLM_MODEL_FALLBACK || 'gemini-3.5-flash',
  ])];

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    let lastErr = null;
    for (const model of models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const ctrl = AbortSignal.timeout(20_000);
          const result = await ai.models.generateContent({
            model,
            contents: items,
            config: {
              systemInstruction: SYSTEM, maxOutputTokens: 3072, temperature: 0.1,
              responseMimeType: 'application/json',
            },
            signal: ctrl,
          });
          const text = result?.text || result?.response?.text?.() || '';
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (!jsonMatch) throw new Error('respuesta sin JSON: ' + text.slice(0, 200));
          const verdicts = JSON.parse(jsonMatch[0]);
          const byIndex = new Map(verdicts.map((v) => [Number(v.i), v]));
          const kept = [];
          for (let i = 0; i < bounties.length; i++) {
            const v = byIndex.get(i);
            if (v && v.human_only === true && v.real_bounty !== false) {
              console.log(`  🧑 LLM: solo humanos ${bounties[i].repository?.full_name}#${bounties[i].number}: ${v.reason || 'sin motivo'}`);
              humanSink.push({ b: bounties[i], why: `LLM: ${v.reason || 'reservada a humanos'}` });
              continue;
            }
            if (v && v.real_bounty === false) {
              console.log(`  🤖 LLM descarta ${bounties[i].repository?.full_name}#${bounties[i].number}: ${v.reason || 'sin motivo'}`);
              continue;
            }
            kept.push(bounties[i]);
          }
          return kept;
        } catch (e) {
          lastErr = e;
          const saturated = /503|UNAVAILABLE|high demand|overloaded/i.test(e.message || '');
          if (!saturated) break; // error real (no JSON, timeout, etc.) — no insistir con el mismo modelo
        }
      }
    }
    throw lastErr || new Error('clasificador LLM: sin modelos disponibles');
  } catch (e) {
    console.warn(`[fetch_bounties] clasificador LLM falló (fail-open, no bloquea nada): ${e.message}`);
    return bounties;
  }
}

// ── Inferencia de monto (idéntico a v1) ───────────────────────────────
const AMOUNT_RE =
  /(?:\$\s?|USDC\s|USD\s|EUR\s|€\s?|DAI\s)?(\d{1,6}(?:[.,]\d{1,3})?)\s?(?:\$|USDC|USD|EUR|€|DAI)\b/i;
// El símbolo/moneda es OBLIGATORIO (antes era `\$?` — opcional). Con eso,
// "poidh bounty 1396" (donde 1396 es el ID del bounty en poidh.xyz, no un
// monto) se leía como $1396. Visto en vivo: picsoritdidnthappen/poidh-app
// #1530/#1532 y jpfraneto/menloapp#7 — issues de OTRO bot avisando que YA
// reclamó un bounty en poidh.xyz, sin pedir nada a nadie. El agente terminó
// comentando "quiero trabajar en esto" en avisos ajenos (limpiado a mano).
const AMOUNT_LABEL_RE =
  /(?:bounty|reward|payout|prize|pay)\s*(?::|=|of|is|≈|-)?\s*(?:\$|USDC?\b|EUR\b|€|DAI\b)\s?(\d{1,6}(?:[.,]\d{1,2})?)/i;

function inferUsd({ title = '', body = '' }) {
  const text = `${title}\n${body}`;
  const m = text.match(AMOUNT_LABEL_RE) || text.match(AMOUNT_RE);
  if (!m) return null;
  const n = Number(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function estimateDifficulty({ body = '' }) {
  const text = String(body || '');
  const fileMentions = text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html|vue|svelte)\b/g) || [];
  const filesModified = Math.min(fileMentions.length, 20);
  const codeFences = text.match(/```[\s\S]*?```/g) || [];
  const diffSizeKb = Math.min(codeFences.reduce((s, b) => s + b.length, 0) / 1024, 50);
  const f = Math.log(1 + filesModified) * Math.log(2 + diffSizeKb);
  return Math.max(1, Math.min(10, f));
}

function computeBountyScore(amountUsd, difficulty) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
  if (!Number.isFinite(difficulty) || difficulty <= 0) return amountUsd;
  return Number((amountUsd / difficulty).toFixed(2));
}

const inRange = (usd) => typeof usd === 'number' && usd >= MIN_USD && usd <= MAX_USD;

// ── Caché de calidad de repo ─────────────────────────────────────────
async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
async function saveCache(cache) {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.rename(tmp, CACHE_PATH);
  } catch (e) {
    console.warn(`[fetch_bounties] no se pudo guardar caché: ${e.message}`);
  }
}

// ── FILTRO DE CALIDAD DE REPO ───────────────────────────────────────
// Devuelve { ok, score, signals } tras evaluar señales objetivas.
// El monto NO influye aquí (el monto no predice el merge; el repo sí).
const QUALITY_CACHE_VERSION = 2;
async function assessRepoQuality(fullName, token, cache) {
  const key = fullName.toLowerCase();

  // Orgs de confianza: saltan el gate de calidad (sabemos que son legítimas
  // y activas). Los filtros duros de spam/adjudicada/no-código se aplican
  // igual en el pre-filtro y en normalizeIssue.
  if (TRUSTED_REPOS.has(key)) {
    const r = { ok: true, score: 9, signals: { trusted: true }, assessed_at: Date.now() };
    cache[key] = r;
    return r;
  }

  const cached = cache[key];
  // v = version del algoritmo: al cambiar las reglas se reevaluan los repos ya cacheados.
  if (cached && cached.v === QUALITY_CACHE_VERSION && Date.now() - (cached.assessed_at || 0) < QUALITY_TTL_MS) {
    return cached;
  }

  const signals = {};
  let score = 0;
  let hardFail = false;
  try {
    const repo = await ghFetch(`${GH}/repos/${fullName}`, token);

    // ── Descartes DUROS (no importa el resto de señales) ──
    if (repo.archived || repo.disabled) { signals.archived = true; hardFail = true; }
    if (repo.fork) { signals.fork = true; hardFail = true; }
    if (repo.open_issues_count > 5000) { signals.issue_flood = repo.open_issues_count; hardFail = true; }
    if (SPAM_RE.test(`${fullName} ${repo.description || ''}`)) { signals.spam = true; hardFail = true; }

    const pushedDaysAgo = (Date.now() - new Date(repo.pushed_at).getTime()) / 86_400_000;
    signals.pushed_days_ago = Math.round(pushedDaysAgo);
    if (pushedDaysAgo <= 30) score += 2;
    else if (pushedDaysAgo <= 90) score += 0;
    else score -= 3;

    signals.language = repo.language || null;
    // Lenguaje explícito fuera de la lista → el sandbox no lo puede testear.
    // (language:null NO descarta — suele ser monorepo/docs con TS debajo.)
    if (repo.language && !ALLOWED_LANGS.has(repo.language)) { signals.lang_off = true; hardFail = true; }
    // Python ML/GPU pesado → el sandbox no puede instalar torch/cuda/etc.
    if (repo.language === 'Python' && PY_HEAVY_RE.test(`${fullName} ${repo.description || ''}`)) {
      signals.py_heavy = true; hardFail = true;
    }
    // Rust web3/embebido → necesita toolchains que el sandbox no trae.
    if (repo.language === 'Rust' && RUST_HEAVY_RE.test(`${fullName} ${repo.description || ''}`)) {
      signals.rust_heavy = true; hardFail = true;
    }
    // Go: monorepo gigante → build en frío revienta el sandbox.
    if (repo.language === 'Go' && GO_HEAVY_RE.test(`${fullName} ${repo.description || ''}`)) {
      signals.go_heavy = true; hardFail = true;
    }

    signals.open_issues = repo.open_issues_count;
    if (repo.open_issues_count != null && repo.open_issues_count < 600) score += 1;
    else if (repo.open_issues_count > 1500) score -= 2;

    signals.stars = repo.stargazers_count;

    // Repo recién creado + pocas estrellas + con bounties = probable cebo.
    const ageDays = (Date.now() - new Date(repo.created_at).getTime()) / 86_400_000;
    signals.age_days = Math.round(ageDays);
    if (ageDays < 21 && (repo.stargazers_count ?? 0) < 15) { signals.fresh_bait = true; score -= 2; }

    // ¿mergea PRs externos recientemente? señal fuerte de "sí revisan".
    let mergedCount = 0;
    try {
      const pulls = await ghFetch(
        `${GH}/repos/${fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=20`,
        token
      );
      const now = Date.now();
      mergedCount = (Array.isArray(pulls) ? pulls : []).filter(
        (p) => p.merged_at && now - new Date(p.merged_at).getTime() < 120 * 86_400_000
      ).length;
      signals.merged_prs_120d = mergedCount;
      // En un repo de menos de 30 dias y casi sin estrellas, los merges NO son historial:
      // las granjas se mergean sus propios PRs el dia que nacen (visto 2026-10-08:
      // Tributary-Labs/tributary-channels, 4 merges el mismo dia -> q=5).
      const mergesCount = ageDays < 30 && (repo.stargazers_count ?? 0) <= 5 ? 0 : mergedCount;
      if (mergesCount !== mergedCount) signals.merges_ignored_new_repo = true;
      if (mergesCount >= 3) score += 3;
      else if (mergesCount >= 1) score += 1;
      else score -= 1;
    } catch { signals.pulls_err = true; }

    // AVALANCHA DE BOUNTIES: 30+ issues abiertos con titulo "[Bounty: $N]" en un repo
    // con casi ninguna estrella = granja (decenas de cuentas creando 3 issues c/u).
    if ((repo.stargazers_count ?? 0) <= 5 && (repo.open_issues_count ?? 0) >= 30) {
      try {
        const issues = await ghFetch(`${GH}/repos/${fullName}/issues?state=open&per_page=100`, token);
        const n = (Array.isArray(issues) ? issues : [])
          .filter((i) => !i.pull_request && /\[bounty:?\s*\$\s?\d/i.test(i.title || '')).length;
        signals.bounty_titles = n;
        if (n >= 30) { signals.bounty_flood = true; signals.fresh_bait = true; score -= 3; }
      } catch { /* sin dato: no penaliza */ }
    }

    // GRANJA DE MERGES para cebar agentes: repo sin estrellas pero que mergea
    // muchísimos PRs y es reciente. Ningún repo legítimo de 0-1 estrellas
    // mergea 8+ PRs externos en 4 meses.
    if ((repo.stargazers_count ?? 0) <= 2 && mergedCount >= 6 && ageDays < 400) {
      signals.merge_farm = true; hardFail = true;
    }
    // Segundo escalón: repo con pocas estrellas pero throughput de PRs
    // imposible para su tamaño (18-20 merges/120d con <20 estrellas). Los
    // repos legítimos con ese ritmo tienen cientos de estrellas.
    if ((repo.stargazers_count ?? 0) <= 20 && mergedCount >= 15 &&
        ageDays < 600 && (repo.open_issues_count ?? 0) < 250) {
      signals.merge_farm_hi = true; hardFail = true;
    }

    // CONTRIBUTING.md (raíz o .github)
    try {
      await ghFetch(`${GH}/repos/${fullName}/contents/CONTRIBUTING.md`, token);
      signals.contributing = true; score += 1;
    } catch {
      try {
        await ghFetch(`${GH}/repos/${fullName}/contents/.github/CONTRIBUTING.md`, token);
        signals.contributing = true; score += 1;
      } catch { signals.contributing = false; }
    }
  } catch (e) {
    signals.repo_err = e.status || e.message;
    hardFail = true;
  }

  if (hardFail) score = -99;
  const result = { ok: !hardFail && score >= QUALITY_MIN, score, signals, assessed_at: Date.now(), v: QUALITY_CACHE_VERSION };
  cache[key] = result;
  return result;
}

// ── Búsqueda de issues ──────────────────────────────────────────────
async function searchIssues(token) {
  let queries = [
    'is:issue is:open label:bounty',
    'is:issue is:open label:"💰 Bounty"',
    'is:issue is:open label:"💎 Bounty"',        // Algora
    'is:issue is:open label:"🏴‍☠️ bounty"',
    'is:issue is:open label:"💵 Bounty"',        // Opire / varios
    'is:issue is:open label:"💵 Reward"',
    'is:issue is:open label:"help wanted 💵"',   // Polar-style
    'is:issue is:open label:"Algora: Bounty"',
    'is:issue is:open label:"good first issue" label:paid',  // perfil ideal
    'is:issue is:open bounty in:title',
    'is:issue is:open "/bounty $" in:comments',  // comando Algora/Opire
    'is:issue is:open "I\'ll pay" in:comments',  // oferta del mantenedor
    ...trustedRepoQueries(),                     // orgs conocidas que pagan
  ];
  // Modo fresco: la propia búsqueda se limita a issues recientes → menos
  // ruido y menos evaluaciones de calidad. GitHub `created:` va por día.
  if (FRESH_HOURS > 0) {
    const since = new Date(Date.now() - FRESH_HOURS * 3_600_000).toISOString().slice(0, 10);
    queries = queries.map((q) => `${q} created:>=${since}`);
  }
  const byId = new Map();
  for (const q of queries) {
    for (let page = 1; page <= 2; page++) {
      const url = `${GH}/search/issues?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}&page=${page}&sort=updated&order=desc`;
      let json;
      try {
        json = await ghFetch(url, token);
      } catch (e) {
        console.warn(`[fetch_bounties] search falló q=${q} page=${page}: ${e.message}`);
        break;
      }
      const items = Array.isArray(json.items) ? json.items : [];
      for (const it of items) {
        if (it.pull_request) continue;
        byId.set(it.id, it);
      }
      if (items.length < PER_PAGE) break;
      await sleep(1500); // 30 req/min search rate-limit
    }
  }
  return [...byId.values()];
}

function repoFromIssue(it) {
  return it.repository_url ? it.repository_url.replace('https://api.github.com/repos/', '') : null;
}

// Para issues sin monto en título/cuerpo: mira los comentarios buscando un
// `/bounty $X`, `bounty: $X`, o una oferta explícita del mantenedor.
// Devuelve el USD encontrado o null. Prioriza `/bounty $X` (canónico Algora).
async function amountFromComments(repoFull, number, token) {
  try {
    const url = `${GH}/repos/${repoFull}/issues/${number}/comments?per_page=40&sort=created&direction=desc`;
    const arr = await ghFetch(url, token);
    const comments = (Array.isArray(arr) ? arr : []);
    // 1) Confirmación de bot de plataforma (Algora / Opire) — la señal fuerte:
    //    "💰 $100 bounty …", "Bounty of $100 …", etc. posteado por *-bot / *[bot].
    const BOT_AMOUNT_RE = /(?:💰|bounty(?:\s+of)?|reward(?:\s+of)?)\D{0,12}\$\s?(\d{1,6}(?:[.,]\d{1,2})?)\b|\$\s?(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:bounty|reward)\b/i;
    for (const c of comments) {
      const login = String(c.user?.login || '').toLowerCase();
      if (!/algora|opire|\bbot\b|\[bot\]/.test(login)) continue;
      const m = String(c.body || '').match(BOT_AMOUNT_RE);
      const n = m && Number((m[1] || m[2]).replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
      if (Number.isFinite(n) && n > 0) return n;
    }
    // 2) Comando `/bounty $X` de un humano — SOLO si es un comando real:
    //    al principio de una línea, sin condicional ("if you'd /bounty $100",
    //    "please /bounty $50", "should /bounty…") que sea una PETICIÓN, no un pago.
    for (const c of comments) {
      const b = String(c.body || '');
      const m = b.match(/^[ \t>]*\/bounty\s+\$?\s?(\d{1,6}(?:[.,]\d{1,2})?)\b/im);
      if (!m) continue;
      const line = (b.match(/^.*\/bounty.*$/im) || [''])[0];
      if (/\b(if|would|should|could|please|can you|hope|suggest|propose|recommend|wish|maybe|ideally)\b/i.test(line)) continue;
      const n = Number(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* noop */ }
  return null;
}

// ── Normalización (mismo esquema que consume el orquestador) ─────────
function normalizeIssue(it, repoQuality, enrichedUsd = null) {
  const repoFullName = repoFromIssue(it);
  const labels = (it.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
  const body = it.body || '';
  const amount_usd = inferUsd({ title: it.title, body }) ?? (typeof enrichedUsd === 'number' ? enrichedUsd : null);
  const difficulty = estimateDifficulty({ body });
  const score = computeBountyScore(amount_usd ?? 0, difficulty);

  const spam =
    SPAM_REPOS.has(String(repoFullName).toLowerCase()) ||
    SPAM_OWNERS.has(String(repoFullName).split('/')[0].toLowerCase()) ||
    tagSpam(it.title) ||
    SPAM_RE.test(`${repoFullName} ${it.title} ${body.slice(0, 400)}`) ||
    BAIT_CONTENT_RE.test(`${it.title}\n${body.slice(0, 600)}`) ||
    SPECULATIVE_PITCH_RE.test(body) || // cuerpo completo: la frase clave suele ir al final
    PAYOUT_REQUEST_RE.test(it.title) || PAYOUT_REQUEST_RE.test(body) ||
    THIRD_PARTY_CLAIM_NOTICE_RE.test(it.title) || THIRD_PARTY_CLAIM_NOTICE_RE.test(body) ||
    isDigestOrReport(body, repoFullName);

  const trusted = TRUSTED_REPOS.has(String(repoFullName).toLowerCase());
  // trusted salta el gate de CALIDAD, no el de monto: un bounty real siempre
  // trae cifra (en el issue o en un `/bounty $X`, que el enriquecedor recupera).
  const amountOk = typeof amount_usd === 'number' || !STRICT_AMOUNT;
  const doneLabel = labels.some((n) => DONE_LABEL_RE.test(n)) ||
    (it.assignee || (Array.isArray(it.assignees) && it.assignees.length > 0));
  const originValid = !spam && !doneLabel && !!repoQuality?.ok && amountOk &&
    !EXCLUDED_PRODUCTION_REPOS.has(repoFullName);

  let reason = null;
  if (spam) reason = 'engagement_farm';
  else if (doneLabel) reason = 'already_paid_or_assigned';
  else if (EXCLUDED_PRODUCTION_REPOS.has(repoFullName)) reason = 'excluded_production_repo';
  else if (!repoQuality?.ok) reason = `low_repo_quality(score=${repoQuality?.score})`;
  else if (!amountOk) reason = 'amount_not_explicit';

  return {
    id: String(it.id),
    number: it.number,
    title: it.title,
    // El cuerpo del issue es contexto CRÍTICO para el generador de parches.
    body: String(body || '').slice(0, 8000),
    url: it.html_url,
    repository: { full_name: repoFullName },
    amount_usd,
    currency: 'USDC',
    status: 'open',
    claimed: false,
    labels,
    source_platform: trusted ? 'github-search:trusted-org' : 'github-search',
    trusted,
    difficulty_estimate: Number(difficulty.toFixed(2)),
    bounty_score: score,
    repo_quality_score: repoQuality?.score ?? null,
    repo_quality_signals: repoQuality?.signals ?? null,
    origin_valid: originValid,
    origin_rejection_reason: originValid ? null : reason,
    origin_rejection_detail: originValid ? null : JSON.stringify(repoQuality?.signals || {}),
    created_at: it.created_at,
    updated_at: it.updated_at,
    mock: false,
  };
}

// ── Salida ─────────────────────────────────────────────────────────
async function writePayload(bounties, meta = {}) {
  const payload = {
    fetched_at: new Date().toISOString(),
    source: 'github-search+repo-quality',
    filter: {
      min_usd: MIN_USD, max_usd: MAX_USD, min_score: MIN_SCORE,
      quality_min: QUALITY_MIN, strict_amount: STRICT_AMOUNT,
    },
    count: bounties.length,
    bounties,
    ...meta,
  };
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmp, OUT_PATH);

  console.log('───────────────────────────────────────────────────────');
  console.log(`Bounties válidas (post-filtro): ${bounties.length}`);
  bounties.slice(0, 12).forEach((b, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. $${(b.amount_usd ?? 0).toFixed(0)} ` +
      `score=${b.bounty_score} q=${b.repo_quality_score} ` +
      `${b.repository.full_name}#${b.number} — ${String(b.title).slice(0, 60)}`
    );
  });
  console.log('───────────────────────────────────────────────────────');
  console.log(`Guardado en: ${OUT_PATH}`);
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const token = resolveGithubToken();
  console.log(`Rango: $${MIN_USD}-$${MAX_USD} | score>=${MIN_SCORE} | calidad>=${QUALITY_MIN}`);
  console.log(`Token GitHub: ${token ? 'presente' : 'AUSENTE'}`);
  if (!token) {
    await writePayload([], { upstream_error: { message: 'GITHUB_TOKEN ausente' } });
    process.exit(1);
  }

  let raw;
  try {
    raw = await searchIssues(token);
  } catch (e) {
    console.error(`[fetch_bounties] búsqueda falló: ${e.message}`);
    await writePayload([], { upstream_error: { message: e.message, status: e.status ?? null } });
    process.exit(1);
  }
  console.log(`Issues candidatas: ${raw.length}`);

  // Pre-filtro barato ANTES de gastar llamadas de calidad.
  const cache = await loadCache();
  const humanCandidates = [];
  const drop = { human_only: 0, spam: 0, excluded: 0, contested: 0, stale: 0, assigned: 0, awarded: 0, done_label: 0, non_code: 0, py_heavy: 0, rust_heavy: 0, go_heavy: 0, out_of_range: 0, no_repo: 0 };
  const prelim = raw
    .map((it) => ({ it, repo: repoFromIssue(it) }))
    .filter(({ it, repo }) => {
      if (!repo) { drop.no_repo++; return false; }
      if (SPAM_REPOS.has(repo.toLowerCase())) { drop.spam++; return false; }
      if (SPAM_OWNERS.has(repo.split('/')[0].toLowerCase())) { drop.spam++; return false; }
      if (EXCLUDED_PRODUCTION_REPOS.has(repo)) { drop.excluded++; return false; }
      if (tagSpam(it.title)) { drop.spam++; return false; }
      if (SPAM_RE.test(`${repo} ${it.title}`)) { drop.spam++; return false; }
      if (BAIT_CONTENT_RE.test(`${it.title}\n${String(it.body || '').slice(0, 600)}`)) { drop.spam++; return false; }
      if (SPECULATIVE_PITCH_RE.test(String(it.body || ''))) { drop.spam++; return false; }
      if (PAYOUT_REQUEST_RE.test(it.title) || PAYOUT_REQUEST_RE.test(String(it.body || ''))) { drop.spam++; return false; }
      if (THIRD_PARTY_CLAIM_NOTICE_RE.test(it.title) || THIRD_PARTY_CLAIM_NOTICE_RE.test(String(it.body || ''))) { drop.spam++; return false; }
      if (isDigestOrReport(String(it.body || ''), repo)) { drop.spam++; return false; }
      // Disputada: demasiados comentarios (attempts / PRs competidores).
      if ((it.comments ?? 0) > MAX_COMMENTS) { drop.contested++; return false; }
      // Ya tiene a alguien asignado → el mantenedor eligió; no competimos.
      if (it.assignee || (Array.isArray(it.assignees) && it.assignees.length > 0)) { drop.assigned++; return false; }
      // Etiqueta de "ya pagada / resuelta / en progreso por otro".
      if (labelNames(it).some((n) => DONE_LABEL_RE.test(n))) { drop.done_label++; return false; }
      const ageH = (Date.now() - new Date(it.created_at).getTime()) / 3_600_000;
      if (FRESH_HOURS > 0 && ageH > FRESH_HOURS) { drop.stale++; return false; }
      if (MAX_AGE_DAYS > 0 && ageH / 24 > MAX_AGE_DAYS) { drop.stale++; return false; }
      // Texto: ¿ya adjudicada? ¿es un informe/investigación en vez de un fix?
      const hay = `${it.title}\n${String(it.body || '').slice(0, 800)}`;
      if (AWARDED_RE.test(hay)) { drop.awarded++; return false; }
      const humanMatch = hay.match(HUMAN_ONLY_RE);
      if (humanMatch) {
        const hUsd = inferUsd({ title: it.title, body: it.body || '' });
        if (hUsd != null && inRange(hUsd)) humanCandidates.push({ it, repo, why: `el issue dice "${humanMatch[0]}"` });
        drop.human_only++;
        return false;
      }
      if (NON_CODE_RE.test(hay) && !CODE_SIGNAL_RE.test(hay)) { drop.non_code++; return false; }
      if (PY_HEAVY_RE.test(hay)) { drop.py_heavy++; return false; }
      if (RUST_HEAVY_RE.test(hay)) { drop.rust_heavy++; return false; }
      if (GO_HEAVY_RE.test(`${repo} ${hay}`)) { drop.go_heavy++; return false; }
      const usd = inferUsd({ title: it.title, body: it.body || '' });
      // Si hay monto y está fuera de rango → fuera. Si NO hay monto, lo
      // dejamos pasar: puede estar en los comentarios (se busca luego).
      if (usd != null && !inRange(usd)) { drop.out_of_range++; return false; }
      return true;
    });
  console.log(`Tras pre-filtro: ${prelim.length}  descartes=${JSON.stringify(drop)}`);

  // Anti-burst: un repo NO de confianza con demasiadas issues en una sola
  // pasada = granja soltando cebo en masa. Se descarta el repo entero.
  {
    const perRepo = {};
    for (const p of prelim) perRepo[p.repo] = (perRepo[p.repo] || 0) + 1;
    const bursty = new Set(Object.entries(perRepo)
      .filter(([r, n]) => n > BURST_MAX_PER_REPO && !TRUSTED_REPOS.has(r.toLowerCase()))
      .map(([r]) => r));
    if (bursty.size) {
      const before = prelim.length;
      for (let i = prelim.length - 1; i >= 0; i--) if (bursty.has(prelim[i].repo)) prelim.splice(i, 1);
      console.log(`Anti-burst: descartados ${before - prelim.length} de ${[...bursty].join(', ')}`);
    }
  }

  // Evaluar calidad por repo único (con caché). Las orgs de confianza se
  // evalúan siempre (coste 0, no gastan API); el resto va con tope — pero
  // el tope ahora se aplica DESPUÉS de ordenar por prioridad, no en el orden
  // arbitrario en que la API de búsqueda devolvió los resultados. Prioridad:
  // 1) mayor monto inferible (gratis, es solo regex sobre título/cuerpo que
  //    ya tenemos en memoria) 2) issue más reciente como desempate. Así, si
  // el tope sigue sin alcanzar para todos los candidatos de un ciclo, los
  // que se quedan afuera son los de menor señal, no los primeros en llegar.
  const uniqRepos = [...new Set(prelim.map((p) => p.repo))];
  const repoPriority = new Map();
  for (const p of prelim) {
    const usd = inferUsd({ title: p.it.title, body: p.it.body || '' }) ?? 0;
    const createdMs = Date.parse(p.it.created_at || 0) || 0;
    const cur = repoPriority.get(p.repo);
    if (!cur || usd > cur.usd || (usd === cur.usd && createdMs > cur.createdMs)) {
      repoPriority.set(p.repo, { usd, createdMs });
    }
  }
  const byPriorityDesc = (a, b) => {
    const pa = repoPriority.get(a) || { usd: 0, createdMs: 0 };
    const pb = repoPriority.get(b) || { usd: 0, createdMs: 0 };
    return (pb.usd - pa.usd) || (pb.createdMs - pa.createdMs);
  };
  const repos = [
    ...uniqRepos.filter((r) => TRUSTED_REPOS.has(r.toLowerCase())),
    ...uniqRepos.filter((r) => !TRUSTED_REPOS.has(r.toLowerCase())).sort(byPriorityDesc).slice(0, MAX_REPOS_ASSESS),
  ];
  const quality = {};
  let assessed = 0;
  for (const repo of repos) {
    quality[repo] = await assessRepoQuality(repo, token, cache);
    assessed++;
    const q = quality[repo];
    console.log(`  [${assessed}/${repos.length}] ${repo} → q=${q.score} ${q.ok ? 'OK' : 'descartado'} ${JSON.stringify(q.signals)}`);
  }
  // Bounties solo-humanos: se evalúa el repo (barato, pocas por ciclo) y se
  // descartan solo las granjas duras; el resto se manda al usuario con sus riesgos.
  const humanOnly = [];
  for (const h of humanCandidates.slice(0, 5)) {
    const q = quality[h.repo] || await assessRepoQuality(h.repo, token, cache);
    const n = normalizeIssue(h.it, q);
    if (n.origin_rejection_reason === 'engagement_farm' || (q.score ?? 0) <= -90) continue;
    humanOnly.push(toHumanEntry(n, h.why, h.it.comments ?? null));
  }
  await saveCache(cache);

  // Enriquecer monto desde comentarios SOLO para los que pasaron calidad y
  // no tienen monto en título/cuerpo (tope de llamadas).
  let enriched = 0;
  for (const p of prelim) {
    if (enriched >= 25) break;
    const q = quality[p.repo];
    if (!q || !q.ok) continue;
    if (inferUsd({ title: p.it.title, body: p.it.body || '' }) != null) continue;
    p.enrichedUsd = await amountFromComments(p.repo, p.it.number, token);
    if (p.enrichedUsd != null) { enriched++; console.log(`  $ desde comentarios: ${p.repo}#${p.it.number} → $${p.enrichedUsd}`); }
  }

  const normalized = prelim
    .filter((p) => quality[p.repo]) // solo repos evaluados
    .map((p) => normalizeIssue(p.it, quality[p.repo], p.enrichedUsd));

  const accepted = normalized
    .filter((b) => b.origin_valid === true)
    .filter((b) => inRange(b.amount_usd) || (b.amount_usd == null && !STRICT_AMOUNT))
    // El score valor/dificultad sólo aplica si conocemos el monto.
    .filter((b) => b.amount_usd == null || (b.bounty_score ?? 0) >= MIN_SCORE)
    // Orden: mejor repo primero, luego mejor ratio valor/dificultad.
    .sort((a, b) =>
      (b.repo_quality_score ?? 0) - (a.repo_quality_score ?? 0) ||
      (b.bounty_score ?? 0) - (a.bounty_score ?? 0));

  const rejected = normalized.filter((b) => b.origin_valid === false);
  const breakdown = {};
  for (const r of rejected) breakdown[r.origin_rejection_reason] = (breakdown[r.origin_rejection_reason] || 0) + 1;
  console.log(`Rechazadas: ${rejected.length} ${JSON.stringify(breakdown)}`);

  // Última línea de defensa: un LLM barato revisa la lista corta final por
  // si el patrón de fraude/granja es nuevo y ningún regex lo cubre todavía.
  const humanFromLlm = [];
  const finalList = await classifyBountiesWithLLM(accepted, humanFromLlm);
  if (finalList.length !== accepted.length) {
    console.log(`Clasificador LLM: ${accepted.length - finalList.length} descartada(s) de ${accepted.length}`);
  }
  for (const { b, why } of humanFromLlm) {
    if (!humanOnly.some((h) => h.id === b.id)) humanOnly.push(toHumanEntry(b, why));
  }
  console.log(`Solo-humanos (para avisar al usuario): ${humanOnly.length}`);

  await writePayload(finalList, { assessed_repos: assessed, candidates: raw.length, human_only: humanOnly });
}

main().catch((err) => {
  console.error('Error fatal:', err.message || err);
  process.exit(1);
});

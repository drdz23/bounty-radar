# bounty-radar

Radar de bounties de GitHub que **solo avisa por Telegram** (no reclama, no comenta, no abre PRs, no toca wallets).
Corre en GitHub Actions cada 10 min (`.github/workflows/radar.yml`); el estado (ids ya avisados, cache de calidad
de repos, watchlist de PRs/issues) se guarda en la rama `state`.

## Secrets (Settings > Secrets and variables > Actions)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (obligatorios para recibir avisos)
- `RADAR_GH_TOKEN` (opcional): PAT de lectura publica para subir el limite de la API de GitHub.

## Filtros (relajados, vars `RADAR_*` en radar_tick.js)
min $15, max $3000, calidad de repo >= 1, hasta 40 comentarios, frescas 72 h, max 30 dias de antiguedad.
Siguen duros: anti-granja, ya adjudicada, con assignee, no es codigo, monto explicito en el titulo.
Las "solo humanos" tambien se avisan. 3+ bounties del mismo repo se agrupan en un solo mensaje.

## Vigilar un PR o issue
Editar `pr_watchlist.json` en la rama `state` (o `seed/` antes del primer run): `{owner, repo, number, label}`.
Avisa de comentarios, reviews y merge/cierre nuevos.

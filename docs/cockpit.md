# Cockpit (pantalla para mirar mientras transmites)

`/cockpit` es una pantalla densa, sin menús, para una **tablet** o un **segundo monitor**. Funciona igual si transmites a una plataforma
o a varias a la vez (TikTok + Twitch): los espectadores se suman y se desglosan por plataforma, y el chat y la actividad llegan mezclados
con la insignia de cada una.

## Qué muestra

| Zona | Contenido |
|---|---|
| Barra superior | EN VIVO + duración, espectadores totales, cada plataforma con su estado, espectadores y **tendencia** (▲/▼ vs. hace 5 min), y la salud de OBS u otras apps (`fps`, `drops`, «sin señal») desde el heartbeat |
| Gráfica | espectadores de los últimos 30 min por plataforma |
| Ritmo | mensajes/min y likes/min con su mini gráfica y flecha (calentándose / enfriándose), seguidores y donado en la sesión |
| Meta | barra de progreso de la meta de donaciones (USD) con las donaciones de la sesión en curso |
| Top donadores | los 5 mayores de la sesión (se suman entre plataformas) |
| Chat | unificado; **resalta** donadores, menciones al canal, preguntas, mods, suscriptores y gente nueva; filtro «solo importantes»; toca un mensaje para silenciar/borrar/expulsar |
| Actividad | donaciones, seguidores, suscripciones, raids y compartidos |
| Momentos | raids, picos de espectadores y donaciones grandes (automáticos) y los que marques tú |

## Controles

- **Marcar momento** (necesita `chat.moderate`): guarda el instante para recuperar el clip después; aparece también en el detalle de la sesión.
- **Silenciar avisos**: oculta los avisos en pantalla y las notificaciones nativas **en este dispositivo** mientras transmites (las alertas siguen guardándose).
- **Pantalla encendida** (tablet): impide que se apague (Screen Wake Lock; se recuerda la preferencia).
- **Pantalla completa** y **modo compacto** (`/cockpit?compact=1`, para un panel estrecho: sin gráfica ni top de donadores).
- En pantallas estrechas (tablet vertical, móvil) se organiza en pestañas **Chat · Actividad · Datos**.

## Cómo se decide qué es «importante» en el chat

Reglas en `apps/web/src/lib/highlight.ts` (con tests): donador de la sesión > mención (`@canal` o su nombre) > pregunta (`?`/`¿`) > mod > suscriptor > primera vez.
Un mensaje de alguien nuevo sin nada más no cuenta como importante.

## Marcadores automáticos

Los detecta el servidor aunque no tengas el cockpit abierto (`apps/api/src/ingest/markers.ts`):

- **Raid**: siempre.
- **Donación grande**: a partir de `MARKER_BIG_DONATION_USD` (10 por defecto) en equivalente USD.
- **Pico de espectadores**: sube ≥ 25 % y ≥ 10 espectadores sobre el mínimo de los últimos 3 min; máx. uno cada 5 min por canal.

## Meta de donaciones

La fija quien tenga `alerts.manage` (owner/admin) desde el propio cockpit. Se guarda por organización; el progreso es el equivalente en USD de
las donaciones de la **sesión en curso** (las monedas de TikTok y los bits usan la estimación configurable, ver `TIKTOK_USD_CENTS_PER_COIN`).

## Datos nuevos en el servidor

Migración `0002_cockpit.sql` (se aplica sola): tablas `stream_marker` y `tenant_pref`, ambas con RLS por tenant.
Endpoints: `GET/POST /api/t/:id/markers`, `DELETE /markers/:id`, `GET/PUT /goal`; evento SSE `marker`.

# ADR 0007 — Analíticas e historial (Fase 6)

## Qué se hizo
- `Aggregator` en el pipeline de ingest: agrega **por hora** y vuelca por **upsert aditivo** a `stats_hourly` y `stats_daily`.
- API (`analytics.view`): `/analytics/overview` (serie + totales + periodo anterior), `/analytics/sessions` (+ detalle con línea de
  tiempo), `/analytics/top-donors`.
- Retención: ya cubierta por el borrado de particiones de `event` (ADR 0002); las estadísticas agregadas se conservan.
- UI `/history`: tarjetas con variación vs periodo anterior, gráfica (líneas para viewers, barras apiladas para el resto, tabla
  alternativa), sesiones paginadas, top donadores; `/history/[id]` con detalle de sesión.

## Cómo probarlo
`bun test apps/api/test/analytics.test.ts` · `bun scripts/screenshot.ts .shots` (genera `07-history.png`).

## Decisiones
1. El agregador ve **todos** los eventos (incluidos los `viewer_count` que la persistencia muestrea a 1/30 s), así que pico y
   media por hora son exactos aunque el histórico crudo esté muestreado.
2. **Upsert aditivo**: pico = `greatest`, media = ponderada por nº de muestras, el resto suma. Si el volcado falla, los
   deltas se devuelven al agregador (sin duplicar ni perder). El día se deriva agrupando las horas UTC.
3. **Todo en UTC**: las conexiones fuerzan `TimeZone=UTC` (un test reveló que la TZ del servidor cambiaba qué filas entraban
   en un rango) y los rangos diarios comparan `date` con `date`.
4. `donations_minor` = **equivalente en USD** (`usdMinorEstimate`, o el importe si ya es USD). Las divisas fiat distintas de USD
   no se convierten (no hay tasas de cambio) y no suman al total; el desglose real por moneda está en `event`/top donadores.
5. Comparativa: el periodo anterior tiene la misma duración; ≤ 3 días se muestra por hora, más por día.
6. Las consultas sobre `event` van acotadas por `occurred_at` para que Postgres pode particiones.
7. El detalle de sesión usa los `viewer_count` persistidos (1 muestra / 30 s por canal).

## Bugs encontrados durante la fase
- `Date` como parámetro de `sql` crudo no lo serializa postgres.js → ISO + `::timestamptz`.
- TZ de sesión de Postgres (ver 3).

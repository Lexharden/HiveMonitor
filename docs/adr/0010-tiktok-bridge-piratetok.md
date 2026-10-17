# ADR 0010 — Puente de TikTok con `piratetok-live-rs` (proveedor por defecto)

Sustituye la decisión de proveedor del [ADR 0005](0005-fase4-tiktok.md) (el resto de ese ADR sigue vigente).

## Contexto
`tiktok-live-connector` depende de un servicio de firma de terceros (Euler Stream): sin API key el límite es muy bajo y, con varios
tenants, acabaría siendo de pago. `PirateTok/live-rs` (licencia 0BSD) se conecta directamente a TikTok: sin servicio de firma, sin API key.

## Decisión
- **`apps/tiktok-bridge`**: binario Rust pequeño (1,4 MB) sobre `piratetok-live-rs 0.3`. Un proceso por canal; emite un evento JSON por
  línea en stdout y termina con códigos de salida (10 sin directo · 11 usuario inexistente · 12 bloqueo/límite · 13 otro · 20 conexión perdida).
  Cierra stdin → termina (nunca quedan procesos huérfanos). Agrega las rachas de regalos con `GiftStreakTracker` (solo se emite el total final).
- **`packages/adapters/src/tiktok/bridge.ts`**: lanza el puente y traduce sus líneas a la misma interfaz `TikTokClientLike` que ya usaba el
  adaptador. Normalización, backoff, supervisor, alertas y analíticas no cambian.
- **`TIKTOK_PROVIDER=bridge` (por defecto) | `connector`**: `connector` queda como respaldo (requiere `TIKTOK_SIGN_API_KEY`).
- El ejecutable se busca en `TIKTOK_BRIDGE_PATH`, junto al binario de HiveMonitor o en el PATH. `TIKTOK_PROXY` opcional.

## Verificado
Clippy limpio; 37 tests del paquete (puente falso + binario real). Con TikTok real: canal sin directo → `offline` (salida 10),
usuario inexistente → `error` (11). Binario de HiveMonitor compilado + puente real: la conexión queda `offline` y reintenta sin
contar como fallo. **No se pudo probar con un directo activo** (hace falta un streamer en vivo).

## Hallazgos
- Con `bun build --minify` se renombran las clases y se perdía el reconocimiento de errores por nombre (un canal sin directo salía como
  `error`). Se compila con `--minify-whitespace --minify-syntax` y los errores del puente fijan `name` de forma explícita.
- Un `ExitCode` devuelto desde `main` no termina el proceso mientras la lectura bloqueante de stdin siga viva: se usa `process::exit`.

## Despliegue
`scripts/build-binary.ts` compila también el puente para el SO del equipo (`dist/tiktok-bridge[.exe]`); el `Containerfile` añade una etapa
Rust y lo copia junto al binario. La compilación cruzada del puente (otras arquitecturas) exige su propia toolchain: CI lo construye en linux-x64.
Imagen final `distroless/cc`: **no verificado** que traiga `libssl3` (el puente usa TLS nativo); si falta, usar `distroless/base` + `libstdc++`.

## Riesgos
Ambas librerías son no oficiales y TikTok puede romperlas; `live-rs` es joven (v0.3). Si TikTok limita la IP del servidor, usar `TIKTOK_PROXY`.

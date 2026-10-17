# ADR 0001 — Monorepo y versiones

## Decisiones
- Bun workspaces (`apps/*`, `packages/*`), paquetes con scope `@hivemonitor/*`.
- Identificador Tauri `com.yafeldev.hivemonitor` (el guion no es válido en paquetes Android).
- `frontendDist` = `../../web/build` (salida de adapter-static), no `../../web`.
- SvelteKit 3: la configuración (adapter) va en `sveltekit({...})` dentro de `vite.config.ts`;
  `svelte.config.js` ya no está soportado. `tsconfig.json` extiende `$app/tsconfig`.
- TypeScript fijado a 6.x en `apps/web`: SvelteKit 3.1 requiere la API JS de TypeScript,
  que TypeScript 7 (port nativo) no expone. Revisar al actualizar SvelteKit.
- Tailwind v4 con `@tailwindcss/vite`.
- Tauri: se usa `bun --filter @hivemonitor/web <script>` en before*Command (`bun --cwd` no funciona en este contexto).

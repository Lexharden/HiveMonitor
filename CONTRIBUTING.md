# Contribuir

## Ramas

| Rama             | Propósito                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `main`           | Producción. Siempre desplegable; solo recibe merges desde `release/*` y `hotfix/*`. Cada versión lleva etiqueta `vX.Y.Z`. |
| `develop`        | Integración. Aquí se fusionan las ramas de trabajo (PR).                                                                  |
| `feature/<tema>` | Funcionalidad nueva, nace de `develop`.                                                                                   |
| `fix/<tema>`     | Corrección no urgente, nace de `develop`.                                                                                 |
| `release/X.Y.Z`  | Preparación de versión (versión, CHANGELOG), nace de `develop`; se fusiona a `main` y de vuelta a `develop`.              |
| `hotfix/<tema>`  | Corrección urgente sobre producción, nace de `main`; se fusiona a `main` y `develop`.                                     |

Recomendado en GitHub: proteger `main` y `develop` (PR obligatorio, CI en verde).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/es/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`; alcance opcional (`feat(api): …`).

## Antes de abrir un PR

```bash
bun run ci      # eslint + prettier + tipos + tests
```

Cambios de esquema: nueva migración `packages/db/migrations/NNNN_*.sql` (nunca editar una ya aplicada) y actualizar `schema.ts`.
Decisiones relevantes: añadir un ADR en `docs/adr/`.

## Versionado

SemVer. Para publicar: rama `release/X.Y.Z` → actualizar `version` en `package.json` y `CHANGELOG.md` → PR a `main` → etiqueta `vX.Y.Z`.

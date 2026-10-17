# Cliente de escritorio y Android (Tauri 2)

La app Tauri es **solo un cliente**: no ejecuta lógica de servidor ni conectores. En el primer inicio pide la **URL del servidor**
(se guarda con `plugin-store`) y se autentica con un token bearer.

Identificador: `com.yafeldev.hivemonitor` (los guiones no son válidos en paquetes Android).

## Servidor: permitir el origen de Tauri

En el `.env` del servidor (`CORS_ORIGINS`): `http://tauri.localhost` y `https://tauri.localhost` (Windows/Android),
`tauri://localhost` (macOS/Linux). Sin esto el navegador embebido no podrá llamar a la API.

## Escritorio (Windows / macOS / Linux)

Requisitos: Bun, Rust estable y las dependencias de Tauri de tu sistema
(Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`; Windows: WebView2 y MSVC Build Tools).

```bash
bun install
cd apps/desktop
bun run tauri dev          # desarrollo (lanza Vite en :1420)
bun run tauri build        # instaladores en src-tauri/target/release/bundle/
```

Extras nativos (degradan con elegancia en navegador): icono en la **bandeja** (cerrar la ventana la oculta; «Salir» en el menú),
**inicio automático** (Ajustes → arranca oculto con `--minimized`) y **notificaciones del sistema** para alertas con ese canal.
`cargo clippy -- -D warnings` y `cargo fmt --check` deben pasar (los ejecuta CI).

## Android

Requisitos: JDK 17, Android SDK + NDK (`ANDROID_HOME`, `NDK_HOME`), targets de Rust
`aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.

```bash
cd apps/desktop
bun run tauri android init
bun run tauri android dev                 # emulador/dispositivo
bun run tauri android build --apk         # APK (sin firmar)
```

- Firma: crea un keystore y configúralo en `src-tauri/gen/android/app/build.gradle.kts` (no lo subas al repositorio).
- Servidor `http://` en LAN: Android bloquea el tráfico en claro por defecto; usa HTTPS (recomendado).
- Zonas seguras y tablets: el CSS ya usa `env(safe-area-inset-*)`.
- Inicio de sesión social desde Tauri abre el navegador del sistema, pero el retorno por deep link no está implementado:
  en el cliente nativo usa correo y contraseña.

## Seguridad en Tauri

CSP estricta en `tauri.conf.json` (Tauri inyecta los hashes de sus scripts); `connect-src` es amplio (`https: wss: http: ws:`) porque
el servidor es configurable. Capabilities mínimas: `store`, `notification`, `opener` (solo http/https) y, solo en escritorio, `autostart`.
El token se guarda en el store de la app; mejora futura: llavero del sistema (Stronghold/keyring).

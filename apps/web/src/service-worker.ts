/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { version } from "$app/env";
import { assets, immutable } from "$app/manifest";

declare const self: ServiceWorkerGlobalScope;

const CACHE = `hivemonitor-${version}`;
const ASSETS = [...immutable.map((f) => f.path), ...assets.map((f) => f.path), "/"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Nunca se interceptan la API, SSE ni WebSocket: siempre red
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/healthz" || url.pathname === "/readyz") return;

  // Navegaciones: la app es una SPA, se sirve el shell cacheado si no hay red
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/").then((r) => r ?? Response.error())));
    return;
  }
  // Recursos versionados: caché primero
  event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
});

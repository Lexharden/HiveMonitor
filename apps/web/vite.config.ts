import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-static";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [tailwindcss(), sveltekit({
      // Modo SPA (sin SSR): lo sirve la API y lo empaqueta Tauri
      adapter: adapter({ fallback: "index.html" }),
    }),
  ],

  // Opciones pensadas para Tauri; no afectan al modo navegador.
  clearScreen: false,
  server: {
    // Tauri espera un puerto fijo
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // En desarrollo la API corre en otro puerto: se sirve bajo el mismo origen (cookies sin CORS)
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://127.0.0.1:3000", ws: true, changeOrigin: false },
      "/healthz": process.env.API_URL ?? "http://127.0.0.1:3000",
    },
    watch: { ignored: ["**/apps/desktop/**"] },
  },
});

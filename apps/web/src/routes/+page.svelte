<script lang="ts">
  // Detecta si corre dentro de Tauri; en navegador degrada con elegancia.
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
</script>

<main class="grid min-h-screen place-items-center bg-zinc-950 text-zinc-100">
  <div class="text-center">
    <h1 class="text-3xl font-bold">HiveMonitor</h1>
    <p class="mt-2 text-zinc-400">
      Modo: {isTauri ? "Tauri (nativo)" : "Navegador"}
    </p>
  </div>
</main>

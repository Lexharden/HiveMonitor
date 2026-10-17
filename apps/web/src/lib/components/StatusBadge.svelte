<script lang="ts">
  import type { ConnectionStatus } from "@hivemonitor/client";
  import { t } from "#lib/i18n.ts";

  let { status, queued = false }: { status: ConnectionStatus; queued?: boolean } = $props();

  // El estado nunca se comunica solo por color: cada uno lleva icono y texto.
  const style: Record<ConnectionStatus, { cls: string; icon: string }> = {
    live: { cls: "text-good", icon: "M12 8a4 4 0 100 8 4 4 0 000-8z" },
    connecting: { cls: "text-warn", icon: "M12 4v4m0 8v4m8-8h-4M8 12H4" },
    offline: { cls: "text-fg-3", icon: "M6 12h12" },
    error: { cls: "text-bad", icon: "M6 6l12 12M18 6L6 18" },
    rate_limited: { cls: "text-warn", icon: "M12 7v6m0 4h.01" },
  };
  const s = $derived(style[status]);
</script>

<span class="inline-flex items-center gap-1.5 text-xs font-medium {s.cls}">
  <svg viewBox="0 0 24 24" class="size-3.5" fill={status === "live" ? "currentColor" : "none"} stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
    <path d={s.icon} />
  </svg>
  {queued ? t("status.queued") : t(`status.${status}` as const)}
</span>

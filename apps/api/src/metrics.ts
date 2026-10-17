import { timingSafeEqual } from "node:crypto";
import type { AppDeps } from "./context.ts";

/** Contadores HTTP en memoria (etiquetas de baja cardinalidad: método y clase de estado). */
class HttpCounters {
  private readonly counts = new Map<string, number>();
  observe(method: string, status: number): void {
    const key = `${method}|${Math.floor(status / 100)}xx`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  entries(): [string, string, number][] {
    return [...this.counts].map(([k, v]) => {
      const [method, cls] = k.split("|") as [string, string];
      return [method, cls, v];
    });
  }
}

export const httpCounters = new HttpCounters();

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.toLowerCase().startsWith("bearer ")) return false;
  const given = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Métricas en formato de texto de Prometheus. */
export function renderMetrics(deps: Pick<AppDeps, "ingest" | "bus">): string {
  const lines: string[] = [];
  const metric = (name: string, help: string, type: "gauge" | "counter", samples: [Record<string, string>, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) {
      const l = Object.entries(labels)
        .map(([k, val]) => `${k}="${esc(val)}"`)
        .join(",");
      lines.push(`${name}${l ? `{${l}}` : ""} ${v}`);
    }
  };

  const mem = process.memoryUsage();
  const sup = deps.ingest.supervisor.stats();
  const pipe = deps.ingest.pipeline.stats();

  metric("hivemonitor_uptime_seconds", "Tiempo activo del proceso", "gauge", [[{}, Math.round(process.uptime())]]);
  metric("process_resident_memory_bytes", "Memoria residente", "gauge", [[{}, mem.rss]]);
  metric("hivemonitor_heap_used_bytes", "Heap usado", "gauge", [[{}, mem.heapUsed]]);
  const statuses = ["connecting", "live", "offline", "error", "rate_limited"];
  metric(
    "hivemonitor_connections",
    "Conexiones de plataformas por estado",
    "gauge",
    statuses.map((s) => [{ status: s }, sup.byStatus[s] ?? 0]),
  );
  metric("hivemonitor_connect_queue", "Conexiones esperando cupo de connect()", "gauge", [[{}, sup.queued]]);
  metric("hivemonitor_rate_limit_hits_total", "Rate limits recibidos de plataformas (servicio de firma, Helix)", "counter", [
    [{}, sup.rateLimitHits],
  ]);
  metric("hivemonitor_event_queue_pending", "Eventos pendientes de persistir", "gauge", [[{}, pipe.pending]]);
  metric("hivemonitor_events_persisted_total", "Eventos persistidos", "counter", [[{}, pipe.persisted]]);
  metric("hivemonitor_events_dropped_total", "Eventos descartados (cola saturada o rechazados por la base de datos)", "counter", [
    [{}, pipe.dropped],
  ]);
  metric("hivemonitor_persist_errors_total", "Fallos de persistencia reintentados", "counter", [[{}, pipe.flushErrors]]);
  const subs = (deps.bus as { subscriberCount?: () => number }).subscriberCount?.();
  if (subs !== undefined) metric("hivemonitor_bus_subscribers", "Suscriptores en tiempo real (SSE)", "gauge", [[{}, subs]]);
  metric(
    "hivemonitor_http_requests_total",
    "Peticiones HTTP",
    "counter",
    httpCounters.entries().map(([method, status, v]) => [{ method, status }, v]),
  );
  return lines.join("\n") + "\n";
}

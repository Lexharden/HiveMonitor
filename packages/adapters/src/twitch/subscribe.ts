import type { Helix } from "./helix.ts";
import { HelixError } from "./helix.ts";
import { SUBSCRIPTIONS } from "./types.ts";

export interface SubscribeResult {
  ids: string[];
  /** Tipos omitidos (por falta de alcance o rechazo de Twitch) */
  skipped: { type: string; reason: string }[];
}

/**
 * Crea las suscripciones de EventSub de un canal sobre el transporte indicado.
 * Las opcionales se omiten si falta el alcance o Twitch las rechaza (degradación elegante);
 * las requeridas (estado del directo) hacen fallar la conexión.
 */
export async function subscribeAll(
  helix: Helix,
  token: string,
  transport: Record<string, string>,
  broadcasterId: string,
  scopes: string[],
): Promise<SubscribeResult> {
  const out: SubscribeResult = { ids: [], skipped: [] };
  for (const s of SUBSCRIPTIONS) {
    if (s.scope && !scopes.includes(s.scope)) {
      out.skipped.push({ type: s.type, reason: `falta el alcance ${s.scope}` });
      continue;
    }
    try {
      const r = await helix.createSubscription(token, {
        type: s.type,
        version: s.version,
        condition: s.condition(broadcasterId),
        transport,
      });
      const id = r.data[0]?.id;
      if (id) out.ids.push(id);
    } catch (err) {
      // 409 = ya existía (reconexión): se acepta
      if (err instanceof HelixError && err.status === 409) continue;
      if (s.required) throw err;
      out.skipped.push({ type: s.type, reason: (err as Error).message });
    }
  }
  return out;
}

export async function unsubscribeAll(helix: Helix, token: string, ids: string[]): Promise<void> {
  await Promise.allSettled(ids.map((id) => helix.deleteSubscription(token, id)));
}

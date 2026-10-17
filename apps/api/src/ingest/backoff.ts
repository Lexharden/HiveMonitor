export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Fuente de aleatoriedad en [0,1); inyectable para tests. */
  random?: () => number;
}

/**
 * Backoff exponencial con "equal jitter": la mitad del retardo es fija y la otra
 * mitad aleatoria, lo que evita reconexiones sincronizadas sin perder crecimiento.
 * `attempt` empieza en 1.
 */
export function backoffDelay(attempt: number, { baseMs, maxMs, random = Math.random }: BackoffOptions): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Aplica ±`ratio` de jitter a un retardo fijo. */
export function jitter(ms: number, ratio = 0.2, random: () => number = Math.random): number {
  return Math.round(ms * (1 - ratio + random() * 2 * ratio));
}

/**
 * Qué mensajes del chat merecen atención mientras transmites. Función pura (sin estado) para poder probarla.
 */
export type HighlightKind = "donor" | "mod" | "sub" | "first" | "question" | "mention";

export interface HighlightInput {
  userId?: string | null;
  text: string;
  badges?: readonly string[];
}

export interface HighlightContext {
  /** Quienes han donado en esta sesión. */
  donorIds: ReadonlySet<string>;
  /** Es la primera vez que escribe en esta sesión. */
  isFirst: boolean;
  /** Nombres de tus canales (en minúsculas): una mención directa es importante. */
  channelNames: readonly string[];
}

const MOD_BADGES = new Set(["moderator", "broadcaster", "vip", "staff"]);
const SUB_BADGES = new Set(["subscriber", "founder", "sub_gifter"]);

/** Prioridad de visualización (la primera es la más importante). */
export const HIGHLIGHT_ORDER: readonly HighlightKind[] = ["donor", "mention", "question", "mod", "sub", "first"];

export function classify(msg: HighlightInput, ctx: HighlightContext): HighlightKind[] {
  const kinds = new Set<HighlightKind>();
  const text = msg.text.toLowerCase();

  if (msg.userId && ctx.donorIds.has(msg.userId)) kinds.add("donor");
  if (msg.badges?.some((b) => MOD_BADGES.has(b))) kinds.add("mod");
  if (msg.badges?.some((b) => SUB_BADGES.has(b))) kinds.add("sub");
  if (ctx.isFirst) kinds.add("first");
  // Pregunta: signo de interrogación (¿ o ?) en un mensaje con algo de contenido
  if (/[?¿]/.test(msg.text) && msg.text.trim().length >= 6) kinds.add("question");
  // Mención: @canal o el nombre del canal como palabra
  for (const name of ctx.channelNames) {
    if (!name) continue;
    if (text.includes(`@${name}`) || new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(name)}($|[^\\p{L}\\p{N}_])`, "u").test(text)) {
      kinds.add("mention");
      break;
    }
  }
  return HIGHLIGHT_ORDER.filter((k) => kinds.has(k));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Filtro «solo importantes»: cualquier resaltado salvo «primera vez» a solas (un desconocido saludando no cuenta). */
export const isImportant = (kinds: readonly HighlightKind[]) => kinds.some((k) => k !== "first");

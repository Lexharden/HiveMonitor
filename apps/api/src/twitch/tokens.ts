import { eq } from "drizzle-orm";
import type { TwitchCredentials, TwitchTokenService } from "@hivemonitor/adapters";
import { schema, type Database } from "@hivemonitor/db";
import type { Encryptor } from "../crypto.ts";
import type { Logger } from "../logger.ts";
import { TokenRevokedError, fetchAppToken, refreshTokens, validateToken, type TwitchOAuthConfig } from "./oauth.ts";

const REFRESH_MARGIN_MS = 5 * 60_000;
const VALIDATE_EVERY_MS = 60 * 60_000;

/**
 * Gestiona los tokens de Twitch de cada conexión: renueva antes de que expiren, valida cada hora
 * (requisito de Twitch), deduplica renovaciones simultáneas y persiste cifrado en la base de datos.
 */
export class TwitchTokenManager implements TwitchTokenService {
  private readonly inflight = new Map<string, Promise<TwitchCredentials>>();
  private readonly lastValidated = new Map<string, number>();
  private app?: { token: string; expiresAt: number };
  private appInflight?: Promise<string>;

  constructor(private readonly o: { oauth: TwitchOAuthConfig; adminDb: Database; encryptor: Encryptor; logger: Logger }) {}

  async ensureFresh(connectionId: string, current: TwitchCredentials): Promise<TwitchCredentials> {
    const now = Date.now();
    const expiring = current.expiresAt - now < REFRESH_MARGIN_MS;
    const stale = now - (this.lastValidated.get(connectionId) ?? 0) > VALIDATE_EVERY_MS;
    if (!expiring && !stale) return current;

    const running = this.inflight.get(connectionId);
    if (running) return running;
    const p = this.refreshOrValidate(connectionId, current, expiring).finally(() => this.inflight.delete(connectionId));
    this.inflight.set(connectionId, p);
    return p;
  }

  private async refreshOrValidate(id: string, cur: TwitchCredentials, mustRefresh: boolean): Promise<TwitchCredentials> {
    if (!mustRefresh) {
      const ok = await validateToken(this.o.oauth, cur.accessToken).catch(() => true); // fallo de red ≠ token inválido
      if (ok) {
        this.lastValidated.set(id, Date.now());
        return cur;
      }
    }
    try {
      const t = await refreshTokens(this.o.oauth, cur.refreshToken, cur.scopes);
      const next: TwitchCredentials = { ...cur, ...t };
      await this.persist(id, next);
      this.lastValidated.set(id, Date.now());
      return next;
    } catch (err) {
      if (err instanceof TokenRevokedError) await this.markRevoked(id);
      throw err;
    }
  }

  async persist(id: string, creds: TwitchCredentials): Promise<void> {
    const blob = this.o.encryptor.encrypt(JSON.stringify(creds));
    await this.o.adminDb
      .update(schema.platformConnection)
      .set({ credentialsEnc: blob, keyVersion: this.o.encryptor.keyVersion, updatedAt: new Date() })
      .where(eq(schema.platformConnection.id, id));
  }

  /** El usuario retiró el acceso: se deshabilita la conexión para no reintentar en bucle. */
  private async markRevoked(id: string): Promise<void> {
    this.o.logger.warn({ connection: id }, "autorización de Twitch revocada: conexión deshabilitada");
    await this.o.adminDb
      .update(schema.platformConnection)
      .set({
        enabled: false,
        status: "error",
        lastError: "Autorización de Twitch revocada. Vuelve a conectar el canal.",
        updatedAt: new Date(),
      })
      .where(eq(schema.platformConnection.id, id));
  }

  /** Token de aplicación (client credentials), en caché hasta poco antes de expirar. */
  async appToken(): Promise<string> {
    if (this.app && this.app.expiresAt - Date.now() > 60_000) return this.app.token;
    this.appInflight ??= fetchAppToken(this.o.oauth)
      .then((t) => {
        this.app = t;
        return t.token;
      })
      .finally(() => (this.appInflight = undefined));
    return this.appInflight;
  }

  /** Fuerza un nuevo token de aplicación (p. ej. tras un 401). */
  invalidateAppToken() {
    this.app = undefined;
  }
}

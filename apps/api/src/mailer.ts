import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export interface InvitationMail {
  email: string;
  role: string;
  organizationName: string;
  link: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Envío de invitaciones por correo (SMTP). Opcional: sin `SMTP_URL` la invitación sigue siendo válida
 * y el enlace se muestra en el panel para compartirlo a mano. Devuelve null si no hay SMTP configurado.
 */
export function createMailer(
  config: Pick<Config, "SMTP_URL" | "MAIL_FROM">,
  logger: Logger,
): ((m: InvitationMail) => Promise<void>) | null {
  if (!config.SMTP_URL) return null;
  let transport: Promise<{ sendMail(o: Record<string, unknown>): Promise<unknown> }> | undefined;
  const get = () =>
    (transport ??= import("nodemailer").then(
      (n) => n.createTransport(config.SMTP_URL!) as unknown as { sendMail(o: Record<string, unknown>): Promise<unknown> },
    ));
  return async (m) => {
    const org = esc(m.organizationName);
    await (
      await get()
    ).sendMail({
      from: config.MAIL_FROM ?? "HiveMonitor <no-reply@localhost>",
      to: m.email,
      subject: `Invitación a ${m.organizationName} en HiveMonitor`,
      text: `Te han invitado a unirte a «${m.organizationName}» en HiveMonitor.\n\nAcepta la invitación: ${m.link}\n\nSi no esperabas este correo, ignóralo.`,
      html: `<p>Te han invitado a unirte a <b>${org}</b> en HiveMonitor.</p><p><a href="${esc(m.link)}">Aceptar invitación</a></p><p style="color:#666">Si no esperabas este correo, ignóralo.</p>`,
    });
    logger.info({ to: "[oculto]", org: m.organizationName }, "invitación enviada por correo");
  };
}

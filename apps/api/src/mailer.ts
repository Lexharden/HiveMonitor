import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export interface InvitationMail {
  email: string;
  role: string;
  organizationName: string;
  link: string;
}

export interface RawMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Envío de correos de HiveMonitor. Existe solo si hay SMTP configurado (o se inyecta uno en tests). */
export interface Mailer {
  send(mail: RawMail): Promise<void>;
  invitation(m: InvitationMail): Promise<void>;
  verifyEmail(to: string, name: string, link: string): Promise<void>;
  resetPassword(to: string, name: string, link: string): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const layout = (title: string, body: string, button: { label: string; link: string }) =>
  `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">` +
  `<h2 style="margin:0 0 12px">${esc(title)}</h2><p>${body}</p>` +
  `<p style="margin:24px 0"><a href="${esc(button.link)}" style="background:#2a78d6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(button.label)}</a></p>` +
  `<p style="color:#666;font-size:13px">Si el botón no funciona, copia este enlace en tu navegador:<br>${esc(button.link)}</p>` +
  `<p style="color:#666;font-size:13px">Si no esperabas este correo, ignóralo.</p></div>`;

/** Construye el `Mailer` a partir de un transporte (SMTP real o falso en pruebas). */
export function mailerFrom(send: (m: RawMail) => Promise<void>): Mailer {
  return {
    send,
    invitation: (m) =>
      send({
        to: m.email,
        subject: `Invitación a ${m.organizationName} en HiveMonitor`,
        text: `Te han invitado a unirte a «${m.organizationName}» en HiveMonitor.\n\nAcepta la invitación: ${m.link}\n\nSi no esperabas este correo, ignóralo.`,
        html: layout("Invitación a HiveMonitor", `Te han invitado a unirte a <b>${esc(m.organizationName)}</b>.`, {
          label: "Aceptar invitación",
          link: m.link,
        }),
      }),
    verifyEmail: (to, name, link) =>
      send({
        to,
        subject: "Confirma tu correo en HiveMonitor",
        text: `Hola ${name},\n\nConfirma tu correo para activar tu cuenta: ${link}\n\nEl enlace caduca en 1 hora.`,
        html: layout("Confirma tu correo", `Hola ${esc(name)}, confirma tu correo para activar tu cuenta. El enlace caduca en 1 hora.`, {
          label: "Confirmar correo",
          link,
        }),
      }),
    resetPassword: (to, name, link) =>
      send({
        to,
        subject: "Restablece tu contraseña de HiveMonitor",
        text: `Hola ${name},\n\nPara elegir una contraseña nueva abre este enlace: ${link}\n\nCaduca en 1 hora. Si no lo pediste tú, ignora este correo: tu contraseña no cambia.`,
        html: layout("Restablece tu contraseña", `Hola ${esc(name)}, usa este enlace para elegir una contraseña nueva. Caduca en 1 hora.`, {
          label: "Elegir contraseña nueva",
          link,
        }),
      }),
  };
}

/** Mailer SMTP (nodemailer, carga perezosa). Devuelve null si no hay `SMTP_URL`. */
export function createMailer(config: Pick<Config, "SMTP_URL" | "MAIL_FROM">, logger: Logger): Mailer | null {
  if (!config.SMTP_URL) return null;
  let transport: Promise<{ sendMail(o: Record<string, unknown>): Promise<unknown> }> | undefined;
  const get = () =>
    (transport ??= import("nodemailer").then(
      (n) => n.createTransport(config.SMTP_URL!) as unknown as { sendMail(o: Record<string, unknown>): Promise<unknown> },
    ));
  return mailerFrom(async (m) => {
    await (await get()).sendMail({ from: config.MAIL_FROM ?? "HiveMonitor <no-reply@localhost>", ...m });
    logger.info({ subject: m.subject }, "correo enviado"); // sin destinatario en el log
  });
}

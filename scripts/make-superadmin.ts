/**
 * Marca a un usuario EXISTENTE como superadmin (flag global).
 * Uso: DATABASE_URL=... bun scripts/make-superadmin.ts correo@dominio.com [--revoke]
 *
 * No existe forma de volverse superadmin desde la API: evita que alguien que
 * registre un correo antes que tú obtenga privilegios.
 */
import postgres from "postgres";

const [email, flag] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!email || !url) {
  console.error("Uso: DATABASE_URL=... bun scripts/make-superadmin.ts <correo> [--revoke]");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });
const value = flag !== "--revoke";
const rows = await sql`update "user" set is_superadmin = ${value} where lower(email) = lower(${email}) returning id`;
await sql.end();
if (rows.length === 0) {
  console.error(`No existe un usuario con el correo ${email}. Regístrate primero.`);
  process.exit(1);
}
console.log(`${email}: superadmin = ${value}`);

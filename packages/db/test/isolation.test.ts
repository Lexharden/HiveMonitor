import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, withTenant, schema, type DbHandle } from "../src/index.ts";
import { startTestPostgres, type TestPostgres } from "../src/testing.ts";

/** Los query builders de Drizzle son thenables; los convertimos en Promise real. */
const fails = (q: PromiseLike<unknown>) => expect((async () => await q)()).rejects.toThrow();

let pg: TestPostgres;
let admin: DbHandle;
let app: DbHandle;

const A = "org_a";
const B = "org_b";

beforeAll(async () => {
  pg = await startTestPostgres();
  admin = createDb(pg.adminUrl, { max: 2 });
  app = createDb(pg.appUrl, { max: 2 });
  await admin.db.insert(schema.user).values({ id: "u1", name: "U", email: "u@x.dev" });
  await admin.db.insert(schema.organization).values([
    { id: A, name: "A", slug: "a" },
    { id: B, name: "B", slug: "b" },
  ]);
  await withTenant(app.db, A, async (tx) => {
    await tx.insert(schema.platformConnection).values({ id: "c_a", tenantId: A, platform: "tiktok", channelId: "chan_a" });
    await tx
      .insert(schema.event)
      .values({ id: "e_a", tenantId: A, platform: "tiktok", channelId: "chan_a", type: "chat", occurredAt: new Date() });
  });
  await withTenant(app.db, B, async (tx) => {
    await tx.insert(schema.platformConnection).values({ id: "c_b", tenantId: B, platform: "twitch", channelId: "chan_b" });
    await tx
      .insert(schema.event)
      .values({ id: "e_b", tenantId: B, platform: "twitch", channelId: "chan_b", type: "chat", occurredAt: new Date() });
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await admin?.close();
  await pg?.stop();
});

describe("aislamiento entre tenants (RLS)", () => {
  test("cada tenant solo ve sus filas", async () => {
    const a = await withTenant(app.db, A, (tx) => tx.select().from(schema.platformConnection));
    const b = await withTenant(app.db, B, (tx) => tx.select().from(schema.platformConnection));
    expect(a.map((r) => r.id)).toEqual(["c_a"]);
    expect(b.map((r) => r.id)).toEqual(["c_b"]);
    const ev = await withTenant(app.db, A, (tx) => tx.select().from(schema.event));
    expect(ev.map((r) => r.id)).toEqual(["e_a"]);
  });

  test("sin contexto de tenant no se ve nada", async () => {
    const rows = await app.db.select().from(schema.platformConnection);
    expect(rows).toHaveLength(0);
  });

  test("filtrar por tenant_id ajeno devuelve vacío aunque se pida explícitamente", async () => {
    const rows = await withTenant(app.db, A, (tx) => tx.execute(`select * from platform_connection where tenant_id = '${B}'` as never));
    expect(rows.length).toBe(0);
  });

  test("no se puede insertar filas para otro tenant", async () => {
    await expect(
      withTenant(app.db, A, (tx) =>
        tx.insert(schema.platformConnection).values({ id: "evil", tenantId: B, platform: "tiktok", channelId: "x" }),
      ),
    ).rejects.toThrow();
  });

  test("no se puede actualizar ni borrar filas de otro tenant", async () => {
    const upd = await withTenant(app.db, A, (tx) =>
      tx.update(schema.platformConnection).set({ status: "error" }).returning({ id: schema.platformConnection.id }),
    );
    expect(upd.map((r) => r.id)).toEqual(["c_a"]); // la de B no se toca
    const del = await withTenant(app.db, A, (tx) => tx.delete(schema.event).returning({ id: schema.event.id }));
    expect(del.map((r) => r.id)).toEqual(["e_a"]);
    const left = await admin.db.select().from(schema.event);
    expect(left.map((r) => r.id)).toEqual(["e_b"]);
  });

  test("hive_app no tiene acceso a las tablas de autenticación", async () => {
    await fails(app.db.select().from(schema.user));
    await fails(app.db.select().from(schema.member));
  });

  test("audit_log es de solo inserción, incluso para el propietario", async () => {
    await withTenant(app.db, A, (tx) => tx.insert(schema.auditLog).values({ id: "au1", tenantId: A, action: "test" }));
    await fails(admin.db.delete(schema.auditLog));
    await fails(withTenant(app.db, A, (tx) => tx.update(schema.auditLog).set({ action: "x" })));
  });

  test("hive_app no puede cambiar la suspensión del tenant", async () => {
    await admin.db.insert(schema.tenantSettings).values({ tenantId: A });
    await expect(withTenant(app.db, A, (tx) => tx.update(schema.tenantSettings).set({ suspended: true }))).rejects.toThrow();
  });

  test("token de heartbeat se resuelve a su tenant vía función SECURITY DEFINER", async () => {
    await withTenant(app.db, B, (tx) =>
      tx.insert(schema.heartbeatToken).values({ id: "hb1", tenantId: B, tokenHash: "hash123", label: "obs" }),
    );
    const [row] = await app.sql`select resolve_heartbeat_token('hash123') as t`;
    expect(row?.t).toBe(B);
    const [none] = await app.sql`select resolve_heartbeat_token('nope') as t`;
    expect(none?.t).toBeNull();
  });
});

describe("particiones de eventos", () => {
  test("ensure/drop de particiones", async () => {
    const sql = postgres(pg.adminUrl, { max: 1 });
    const parts = await sql`select count(*)::int as n from pg_inherits where inhparent = 'event'::regclass`;
    expect(parts[0]?.n).toBeGreaterThanOrEqual(4); // default + mes pasado, actual y 2 siguientes
    await sql`select ensure_event_partitions(0, 0)`;
    // una partición vieja se elimina por retención
    await sql`create table event_2020_01 partition of event for values from ('2020-01-01') to ('2020-02-01')`;
    const [r] = await sql`select drop_old_event_partitions(60) as n`;
    expect(r?.n).toBe(1);
    await sql.end();
  });
});

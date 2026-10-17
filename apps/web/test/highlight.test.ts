import { describe, expect, test } from "bun:test";
import { classify, isImportant } from "../src/lib/highlight.ts";

const ctx = (over: Partial<Parameters<typeof classify>[1]> = {}) => ({
  donorIds: new Set<string>(),
  isFirst: false,
  channelNames: ["mi_canal"],
  ...over,
});

describe("resaltado del chat", () => {
  test("un mensaje normal no se resalta", () => {
    expect(classify({ userId: "1", text: "jajaja qué bueno" }, ctx())).toEqual([]);
    expect(isImportant([])).toBe(false);
  });

  test("donadores de la sesión, moderadores y suscriptores", () => {
    expect(classify({ userId: "7", text: "gracias" }, ctx({ donorIds: new Set(["7"]) }))).toContain("donor");
    expect(classify({ userId: "1", text: "hola", badges: ["moderator"] }, ctx())).toEqual(["mod"]);
    expect(classify({ userId: "1", text: "hola", badges: ["subscriber"] }, ctx())).toEqual(["sub"]);
    expect(classify({ userId: "1", text: "hola", badges: ["broadcaster"] }, ctx())).toContain("mod");
  });

  test("preguntas: con ? o ¿ y algo de contenido; un «?» suelto no cuenta", () => {
    expect(classify({ userId: "1", text: "¿qué juego es este?" }, ctx())).toEqual(["question"]);
    expect(classify({ userId: "1", text: "como se llama?" }, ctx())).toEqual(["question"]);
    expect(classify({ userId: "1", text: "?" }, ctx())).toEqual([]);
    expect(classify({ userId: "1", text: "ok?" }, ctx())).toEqual([]);
  });

  test("menciones al canal: @canal o su nombre como palabra, sin falsos positivos por subcadenas", () => {
    expect(classify({ userId: "1", text: "@mi_canal saluda" }, ctx())).toEqual(["mention"]);
    expect(classify({ userId: "1", text: "hola MI_CANAL!" }, ctx())).toEqual(["mention"]);
    expect(classify({ userId: "1", text: "visita mi_canal_falso" }, ctx())).toEqual([]);
    expect(classify({ userId: "1", text: "x" }, ctx({ channelNames: [""] }))).toEqual([]);
    // nombres con caracteres especiales de regex no rompen la búsqueda
    expect(classify({ userId: "1", text: "hola c++ fans" }, ctx({ channelNames: ["c++"] }))).toEqual(["mention"]);
  });

  test("varios resaltados se devuelven por prioridad: donador > mención > pregunta > mod > sub > primera vez", () => {
    const kinds = classify(
      { userId: "7", text: "@mi_canal ¿cuándo juegas otra vez?", badges: ["moderator", "subscriber"] },
      ctx({ donorIds: new Set(["7"]), isFirst: true }),
    );
    expect(kinds).toEqual(["donor", "mention", "question", "mod", "sub", "first"]);
  });

  test("«solo importantes»: la primera vez a solas no cuenta, pero sí acompañada", () => {
    expect(isImportant(["first"])).toBe(false);
    expect(isImportant(["first", "question"])).toBe(true);
    expect(isImportant(["donor"])).toBe(true);
  });
});

import { bumpDonor, usdOf } from "../src/lib/donors.ts";

describe("top de donadores en vivo", () => {
  const p = (usd: number) => ({ amountMinor: usd * 2, currency: "TIKTOK_COIN", usdMinorEstimate: usd });
  test("acumula por donador, ordena por USD y limita a 5", () => {
    let list: ReturnType<typeof bumpDonor> = [];
    list = bumpDonor(list, { id: "a", name: "Ana" }, p(300));
    list = bumpDonor(list, { id: "b", name: "Beto" }, p(900));
    list = bumpDonor(list, { id: "a", name: "Ana" }, p(400));
    expect(list.map((d) => [d.name, d.usdMinor])).toEqual([
      ["Beto", 900],
      ["Ana", 700],
    ]);
    expect(list[1]!.byCurrency).toEqual({ TIKTOK_COIN: 1400 });
    for (const id of ["c", "d", "e", "f", "g"]) list = bumpDonor(list, { id, name: id }, p(50));
    expect(list).toHaveLength(5);
    expect(list[0]!.name).toBe("Beto");
  });
  test("no muta la lista original y desempata por cantidad cuando no hay estimación en USD", () => {
    const base = bumpDonor([], { id: "a", name: "Ana" }, { amountMinor: 10, currency: "BITS" });
    const next = bumpDonor(base, { id: "b", name: "Beto" }, { amountMinor: 99, currency: "BITS" });
    expect(base).toHaveLength(1);
    expect(next.map((d) => d.name)).toEqual(["Beto", "Ana"]);
  });
  test("usdOf: estimación, USD directo, o 0", () => {
    expect(usdOf({ amountMinor: 5, currency: "BITS", usdMinorEstimate: 5 })).toBe(5);
    expect(usdOf({ amountMinor: 500, currency: "USD" })).toBe(500);
    expect(usdOf({ amountMinor: 500, currency: "EUR" })).toBe(0);
  });
});

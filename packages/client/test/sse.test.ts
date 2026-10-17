import { expect, test } from "bun:test";
import { parseSse } from "../src/index.ts";

function streamOf(...chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}
async function all(s: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const m of parseSse(s)) out.push(m);
  return out;
}

test("parsea eventos partidos entre chunks, comentarios y CRLF", async () => {
  const out = await all(streamOf(": hi\n\nevent: ev", 'ent\nid: 7\ndata: {"a":1}\n\n', "event: ping\r\ndata: \r\n\r\n"));
  expect(out).toEqual([
    { event: "event", data: { a: 1 }, id: "7" },
    { event: "ping", data: "", id: undefined },
  ]);
});
test("datos multilínea se concatenan", async () => {
  const out = await all(streamOf("data: a\ndata: b\n\n"));
  expect(out[0]!.data).toBe("a\nb");
});

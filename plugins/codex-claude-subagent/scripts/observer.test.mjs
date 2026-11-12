import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readObserverRecords } from "../lib/observer.mjs";

const token = "CODEX_CLAUDE_SUBAGENT_REQUEST_clreq_unit_1";
const session = "11111111-1111-4111-8111-111111111111";
const turn = "22222222-2222-4222-8222-222222222222";
async function harness(suffix, failWrite = false) {
  const handlers = new Map();
  const records = [];
  const module = await import(`../observer/hooks/register.mjs?test=${suffix}`);
  module.register((name, fn) => handlers.set(name, fn));
  const api = {
    env: { get: async (name) => (name.endsWith("_DIR") ? "/private-test" : "generation") },
    fs: {
      write: async (_file, text) => {
        if (failWrite) throw new Error("unwritable");
        records.push(JSON.parse(text));
      },
    },
    session: { id: async () => session, version: async () => ({ version: "2.1.322" }), model: async () => "fable" },
  };
  return { handlers, records, api };
}
const h = await harness("normal");
let forwarded = 0;
const next = async () => {
  forwarded += 1;
  return { unchanged: true };
};
assert.deepEqual(await h.handlers.get("session.start")(h.api, {}, next), { unchanged: true });
await h.handlers.get("turn.start")(
  h.api,
  { text: `Codex–Claude Subagent correlation token: ${token}\nReview`, turnId: turn },
  next,
);
await h.handlers.get("classic.Stop")(h.api, { background_tasks: [], session_crons: [{}] }, async () => ({
  block: "continue",
}));
await h.handlers.get("turn.complete")(
  h.api,
  { turnId: turn, agentId: "child", reason: "answer", answer: "child" },
  next,
);
assert.equal(h.records.filter((e) => e.kind === "turn.complete").length, 0, "child event completed parent");
await h.handlers.get("classic.Stop")(h.api, { background_tasks: [], session_crons: [{}] }, async () => ({}));
await h.handlers.get("turn.complete")(
  h.api,
  { turnId: turn, reason: "answer", isAborted: false, answer: "final", usage: { model: "actual-model" } },
  next,
);
const complete = h.records.at(-1);
assert.equal(complete.request_token, token);
assert.equal(complete.turn_id, turn);
assert.equal(complete.stop.blocked, false);
assert.equal(complete.stop.background_tasks_pending, 0);
assert.equal(complete.stop.session_crons_pending, 1);
assert.equal(complete.last_api_model, "actual-model");
assert.equal(complete.answer, "final");
assert.equal(forwarded, 4, "observer replayed a next handler");

const truncationMarker =
  "\n[codex-claude-subagent: native answer truncated to at most 64,000 UTF-16 code units; the rest is not in this field and may or may not be in the terminal log]";
for (const [name, answer, prefix, truncated] of [
  ["exact-limit", "a".repeat(64000), "a".repeat(64000), false],
  ["over-limit", "b".repeat(64001), "b".repeat(64000), true],
  ["surrogate-boundary", "c".repeat(63999) + "🙂suffix", "c".repeat(63999), true],
  ["non-string", { answer: "not a string" }, "", false],
  ["empty", "", "", false],
]) {
  // Exercise the actual registered hook, not the integration fake's clip copy.
  const clipping = await harness(name);
  const event = { turnId: turn, reason: "answer", isAborted: false, answer };
  const result = { unchanged: name };
  assert.equal(await clipping.handlers.get("turn.complete")(clipping.api, event, async () => result), result);
  assert.equal(event.answer, answer, `${name}: input event changed`);
  assert.equal(clipping.records.length, 1);
  const record = clipping.records[0];
  assert.equal(record.answer_truncated, truncated, name);
  assert.equal(record.answer, prefix + (truncated ? truncationMarker : ""), name);
  assert(prefix.length <= 64000, `${name}: prefix exceeds limit`);
  if (name === "surrogate-boundary") assert.equal(prefix.length, 63999);
  if (truncated) assert(record.answer.includes("at most 64,000 UTF-16 code units"));
}

const failed = await harness("write-failure", true);
let calls = 0;
const original = { original: true };
assert.equal(
  await failed.handlers.get("session.start")(failed.api, {}, async () => {
    calls += 1;
    return original;
  }),
  original,
);
assert.equal(calls, 1, "write failure replayed next");
await assert.rejects(
  () =>
    failed.handlers.get("turn.complete")(failed.api, {}, async () => {
      calls += 1;
      throw new Error("downstream");
    }),
  /downstream/,
);
assert.equal(calls, 2, "downstream failure replayed next");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-observer-test-"));
try {
  const event = { schema: 1, seq: 1, generation: "g", session_id: session, kind: "ready" };
  const file = path.join(dir, "event-00000001.json");
  fs.writeFileSync(file, '{"schema":1');
  const partial = readObserverRecords(dir, "g", 0);
  assert.equal(partial.length, 0);
  assert.equal(partial.pending, true);
  fs.writeFileSync(path.join(dir, "event-00000002.json"), JSON.stringify({ ...event, seq: 2 }));
  const skipped = readObserverRecords(dir, "g", 0);
  assert.equal(skipped.length, 1);
  assert(skipped.skipped_sequences.includes(1));
  assert.equal(readObserverRecords(dir, "g", 2).pending, false, "skipped partial record relocked input");
  fs.rmSync(path.join(dir, "event-00000002.json"));
  fs.writeFileSync(file, JSON.stringify(event));
  assert.equal(readObserverRecords(dir, "wrong-generation", 0).length, 0);
  assert.equal(readObserverRecords(dir, "g", 1).length, 0);
  assert.equal(readObserverRecords(dir, "g", 0).length, 1);
  fs.writeFileSync(path.join(dir, "event-00000002.json"), JSON.stringify({ ...event, seq: 9 }));
  assert.equal(readObserverRecords(dir, "g", 0).length, 1, "filename/sequence mismatch accepted");
  fs.symlinkSync(file, path.join(dir, "event-00000003.json"));
  assert.equal(readObserverRecords(dir, "g", 0).length, 1, "symlink accepted");
  fs.rmSync(file);
  fs.writeFileSync(path.join(dir, "event-00000002.json"), JSON.stringify({ ...event, seq: 2 }));
  assert.equal(readObserverRecords(dir, "g", 0)[0].event.seq, 2, "missing record blocked later evidence");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
const pagedDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-observer-pages-"));
try {
  const total = 8193;
  for (let seq = 1; seq <= total; seq += 1) {
    fs.writeFileSync(
      path.join(pagedDir, `event-${String(seq).padStart(8, "0")}.json`),
      JSON.stringify({
        schema: 1,
        seq,
        generation: "pages",
        session_id: session,
        kind: seq === total ? "turn.complete" : "turn.start",
      }),
    );
  }
  const firstPage = readObserverRecords(pagedDir, "pages", 0);
  assert.equal(firstPage.length, 4096);
  assert.equal(firstPage.at(-1).event.seq, 4096);
  const secondPage = readObserverRecords(pagedDir, "pages", firstPage.at(-1).event.seq);
  assert.equal(secondPage.length, 4096, "consumed records starved the next observer page");
  assert.equal(secondPage[0].event.seq, 4097);
  assert.equal(secondPage.at(-1).event.seq, 8192);
  const finalPage = readObserverRecords(pagedDir, "pages", secondPage.at(-1).event.seq);
  assert.equal(finalPage.length, 1);
  assert.equal(finalPage[0].event.seq, total);
  assert.equal(finalPage[0].event.kind, "turn.complete", "completion beyond the page limit was lost");
  const exhausted = readObserverRecords(pagedDir, "pages", total);
  assert.equal(exhausted.length, 0);
  assert.equal(exhausted.pending, false);
} finally {
  fs.rmSync(pagedDir, { recursive: true, force: true });
}
console.log("native observer tests passed");

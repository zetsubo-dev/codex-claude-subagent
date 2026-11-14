import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readObserverRecords } from "../lib/observer.mjs";
import { createHash } from "node:crypto";
import { createObserverFixture, deferred, waitForFile } from "./fixtures/observer-fixture.mjs";

const token = "CODEX_CLAUDE_SUBAGENT_REQUEST_clreq_unit_1";
const session = "11111111-1111-4111-8111-111111111111";
const turn = "22222222-2222-4222-8222-222222222222";
const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-capture-test-"));
async function harness(suffix, options = {}) {
  return createObserverFixture({ directory: path.join(captureRoot, suffix), sessionId: session, ...options });
}

async function getterErrors() {
  for (const [name, fail] of [
    [
      "sync-throw",
      () => {
        throw new Error("session getter failed");
      },
    ],
    ["async-reject", () => Promise.reject(new Error("session getter failed"))],
  ]) {
    const blocked = deferred();
    const release = deferred();
    const directory = path.join(captureRoot, `getter-${name}`);
    let getterCalls = 0;
    const observer = await harness(`getter-${name}`, {
      getSessionId: () => {
        getterCalls += 1;
        if (getterCalls === 2) return fail();
        return Promise.resolve(session);
      },
      beforeWrite: async (file) => {
        if (path.basename(file) === "event-00000001.json") {
          blocked.resolve();
          await release.promise;
        }
      },
    });
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    let starting;
    let capturing;
    let following;
    try {
      starting = observer.call("turn.start", {
        text: `Codex–Claude Subagent correlation token: ${token}`,
        turnId: turn,
      });
      await blocked.promise;
      const event = Object.freeze({ turnId: turn, reason: "answer", answer: `FAILED_${name}_日本語🙂` });
      const original = { unchanged: name };
      let nextCalls = 0;
      capturing = observer.call("turn.complete", event, async (forwarded) => {
        nextCalls += 1;
        assert.equal(forwarded, event);
        return original;
      });
      await new Promise(setImmediate);
      const getterFailedWhileBlocked = getterCalls === 2;
      const answer = `AFTER_GETTER_ERROR_${name}_日本語🙂_終`;
      following = observer.call("turn.complete", { turnId: "after-getter-error", reason: "answer", answer });
      release.resolve();
      const [, result] = await Promise.all([starting, capturing, following]);
      await new Promise(setImmediate);
      assert.equal(getterFailedWhileBlocked, true, `${name}: getter failure was deferred past the blocked write`);
      assert.deepEqual(unhandled, [], `${name}: queued getter failure caused an unhandled rejection`);
      assert.equal(nextCalls, 1, `${name}: getter failure changed next invocation count`);
      assert.equal(result, original, `${name}: getter failure changed the next result`);
      assert.deepEqual(
        observer.records().map((record) => record.seq),
        [1, 3],
        `${name}: failed sequence was written`,
      );
      assert.deepEqual(
        fs.readdirSync(directory).sort(),
        ["answer-00000003-0001.txt", "event-00000001.json", "event-00000003.json"],
        `${name}: failed sequence or answer parts reached disk`,
      );
      const completed = observer.records().at(-1);
      assert.equal(completed.kind, "turn.complete");
      assert.equal(completed.session_id, session);
      assert.equal(completed.turn_id, "after-getter-error");
      assert.equal(completed.request_token, token);
      assert.equal(completed.answer_capture.kind, "text");
      assert.equal(completed.answer_capture.sha256, createHash("sha256").update(answer).digest("hex"));
      assert.equal(fs.readFileSync(path.join(directory, "answer-00000003-0001.txt"), "utf8"), answer);
    } finally {
      release.resolve();
      await Promise.allSettled([starting, capturing, following]);
      process.off("unhandledRejection", onUnhandled);
    }
  }
}

async function clearIdentity(queued = false) {
  const nextSession = "33333333-3333-4333-8333-333333333333";
  const nextTurn = "44444444-4444-4444-8444-444444444444";
  const nextToken = `${token}_after_clear`;
  const blocked = deferred();
  const release = deferred();
  const oldAnswer = "BEFORE_CLEAR_日本語🙂_終";
  const newAnswer = "AFTER_CLEAR_日本語🙂_終";
  const observer = await harness(queued ? "clear-queued" : "clear", {
    beforeWrite: async (file, text) => {
      if (queued && /event-/.test(file) && JSON.parse(text).kind === "turn.start") {
        blocked.resolve();
        await release.promise;
      }
    },
  });
  await observer.call("session.start");
  const starting = observer.call("turn.start", {
    text: `Codex–Claude Subagent correlation token: ${token}`,
    turnId: turn,
  });
  if (queued) await blocked.promise;
  else await starting;
  await observer.observe("before-clear-model", "xhigh");
  await observer.call("classic.Stop", { background_tasks: [{}], session_crons: [] });
  const capturing = observer.call("turn.complete", { turnId: turn, reason: "answer", answer: oldAnswer });
  if (queued) await Promise.resolve();
  else await capturing;
  observer.setSessionId(nextSession);
  const cleared = observer.call("classic.SessionStart", { source: "clear", session_id: nextSession });
  const following = observer.call("turn.start", {
    text: `Codex–Claude Subagent correlation token: ${nextToken}`,
    turnId: nextTurn,
  });
  release.resolve();
  await Promise.all([starting, capturing, cleared, following]);
  await observer.observe("after-clear-model", "xhigh");
  await observer.call("classic.Stop", { background_tasks: [], session_crons: [] });
  await observer.call("turn.complete", { turnId: nextTurn, reason: "answer", answer: newAnswer });
  const records = observer.records();
  const old = records.find((record) => record.kind === "turn.complete" && record.turn_id === turn);
  assert.equal(old.session_id, session, "queued old capture inherited the post-clear session UUID");
  assert.equal(old.request_token, token, "queued old capture inherited the post-clear request token");
  assert.equal(old.observed.model, "before-clear-model");
  assert.equal(old.stop.background_tasks_pending, 1);
  assert.equal(old.answer_capture.sha256, createHash("sha256").update(oldAnswer).digest("hex"));
  const started = records.find((record) => record.kind === "turn.start" && record.turn_id === nextTurn);
  assert.equal(started.session_id, nextSession, "post-clear turn.start retained the old session UUID");
  assert.equal(started.request_token, nextToken);
  const completed = records.find((record) => record.kind === "turn.complete" && record.turn_id === nextTurn);
  assert.equal(completed.session_id, nextSession, "post-clear turn.complete retained the old session UUID");
  assert.equal(completed.request_token, nextToken);
  assert.equal(completed.observed.model, "after-clear-model");
  assert.equal(completed.stop.background_tasks_pending, 0);
  assert.equal(completed.answer_capture.sha256, createHash("sha256").update(newAnswer).digest("hex"));
}

async function fileBarrier() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-file-barrier-test-"));
  const watch = fs.watch;
  const timeoutMs = 100;
  let timer;
  try {
    fs.watch = () => ({ close() {} });
    const existing = path.join(directory, "existing");
    fs.writeFileSync(existing, "ready");
    assert.equal(await waitForFile(existing, timeoutMs), existing);

    const missing = path.join(directory, "missing");
    await assert.rejects(waitForFile(missing, timeoutMs), {
      message: `Timed out waiting for fixture barrier ${missing}`,
    });
    assert.equal(fs.existsSync(missing), false);

    const empty = path.join(directory, "empty");
    fs.writeFileSync(empty, "");
    let emptySettled = false;
    const emptyWaiting = Promise.allSettled([waitForFile(empty, timeoutMs)]).then((outcomes) => {
      emptySettled = true;
      return outcomes;
    });
    await new Promise((resolve) => {
      timer = setTimeout(resolve, 40);
    });
    assert.equal(emptySettled, false, "Empty fixture barrier must remain pending until content is written");
    fs.writeFileSync(empty, "ready");
    const [filledOutcome] = await emptyWaiting;
    assert.equal(filledOutcome.status, "fulfilled", filledOutcome.reason?.message);
    assert.equal(filledOutcome.value, empty);

    const created = path.join(directory, "created");
    const waiting = waitForFile(created, timeoutMs);
    timer = setTimeout(() => fs.writeFileSync(created, "ready"), 30);
    const [outcome] = await Promise.allSettled([waiting]);
    assert.equal(
      outcome.status,
      "fulfilled",
      `File created after waiting began must resolve; file_exists=${fs.existsSync(created)}; ${outcome.reason?.message ?? ""}`,
    );
    assert.equal(outcome.value, created);
  } finally {
    clearTimeout(timer);
    fs.watch = watch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
if (only) {
  assert(
    ["clear", "clear-queued", "getter-errors", "file-barrier"].includes(only),
    `Unknown observer test group ${only}`,
  );
  try {
    if (only === "file-barrier") await fileBarrier();
    else if (only === "getter-errors") await getterErrors();
    else await clearIdentity(only === "clear-queued");
  } finally {
    fs.rmSync(captureRoot, { recursive: true, force: true });
  }
  console.log(`${only} observer identity tests passed`);
  process.exit(0);
}

try {
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
  assert.equal(h.records().filter((e) => e.kind === "turn.complete").length, 0, "child event completed parent");
  await h.handlers.get("classic.Stop")(h.api, { background_tasks: [], session_crons: [{}] }, async () => ({}));
  await h.handlers.get("turn.complete")(
    h.api,
    { turnId: turn, reason: "answer", isAborted: false, answer: "final", usage: { model: "actual-model" } },
    next,
  );
  const complete = h.records().at(-1);
  assert.equal(complete.request_token, token);
  assert.equal(complete.turn_id, turn);
  assert.equal(complete.stop.blocked, false);
  assert.equal(complete.stop.background_tasks_pending, 0);
  assert.equal(complete.stop.session_crons_pending, 1);
  assert.equal(complete.last_api_model, "actual-model");
  assert.equal(complete.answer_capture.kind, "text");
  assert.equal(h.writes.at(-2).text, "final");
  assert(!Object.hasOwn(complete, "answer"));
  assert.equal(forwarded, 4, "observer replayed a next handler");

  for (const [name, answer] of [
    ["exact-limit", "a".repeat(64000)],
    ["over-limit", "b".repeat(64001)],
    ["surrogate-inline", "c".repeat(63999) + "🙂suffix"],
    ["surrogate-part", "日".repeat(262143) + "🙂suffix"],
    ["over-native-write-limit", "日本語🙂".repeat(400000) + "TAIL_終"],
    ["bom-first", "\ufeff日本語🙂終"],
    ["lone-surrogate", "before\ud800after"],
    ["bom-lone-surrogate", "\ufeffbefore\ud800after"],
    ["non-string", { answer: "not a string" }],
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
  ]) {
    const capture = await harness(name);
    const event = { turnId: turn, reason: "answer", isAborted: false, answer };
    const result = { unchanged: name };
    assert.equal(await capture.call("turn.complete", event, async () => result), result);
    assert.equal(event.answer, answer, `${name}: input event changed`);
    assert.equal(capture.records().length, 1);
    const record = capture.records()[0];
    assert.equal(record.schema, 2);
    assert(!Object.hasOwn(record, "answer") && !Object.hasOwn(record, "answer_truncated"));
    const descriptor = record.answer_capture;
    if (typeof answer !== "string") {
      assert.equal(descriptor.kind, "invalid", name);
      assert.equal(descriptor.type, typeof answer, name);
    } else if (answer === "") {
      assert.equal(descriptor.kind, "empty");
    } else {
      const parts = capture.writes.filter(({ file }) => /answer-/.test(file));
      const bytes = Buffer.concat(parts.map(({ file }) => fs.readFileSync(file)));
      assert.equal(descriptor.kind, "text");
      assert.equal(descriptor.parts, parts.length);
      assert.equal(descriptor.bytes, Buffer.byteLength(answer));
      assert.equal(descriptor.utf16, answer.length);
      assert.equal(descriptor.sha256, createHash("sha256").update(answer).digest("hex"));
      assert.equal(descriptor.lossless, !name.includes("lone-surrogate"), name);
      assert(bytes.equals(Buffer.from(answer)), `${name}: native capture bytes changed`);
      for (const part of parts) {
        assert(part.text.length <= 262144);
        if (name !== "lone-surrogate") assert(!/[\ud800-\udbff]$/.test(part.text), `${name}: split surrogate pair`);
      }
      assert(/event-/.test(capture.writes.at(-1).file), "event was published before parts");
    }
  }

  const blocked = deferred();
  const release = deferred();
  let blockedOnce = false;
  const snapshot = await harness("snapshot", {
    beforeWrite: async (file) => {
      if (!blockedOnce && /answer-/.test(file)) {
        blockedOnce = true;
        blocked.resolve();
        await release.promise;
      }
    },
  });
  await snapshot.call("turn.start", { text: `Codex–Claude Subagent correlation token: ${token}`, turnId: turn });
  await snapshot.observe("original-model", "xhigh");
  await snapshot.call("classic.Stop", { background_tasks: [{}], session_crons: [] });
  const beforeChild = snapshot.records().length;
  const childResult = { child: "unchanged" };
  assert.equal(
    await snapshot.call(
      "turn.start",
      { text: "child prompt", turnId: "child-turn", agentId: "child-agent" },
      async () => childResult,
    ),
    childResult,
  );
  assert.equal(snapshot.records().length, beforeChild, "subagent turn.start wrote a main-loop event");
  const capturing = snapshot.call("turn.complete", { turnId: turn, reason: "answer", answer: "日".repeat(300000) });
  await blocked.promise;
  const later = snapshot.call("turn.start", { text: "manual followup", turnId: "later-turn" });
  release.resolve();
  await Promise.all([capturing, later]);
  const frozen = snapshot.records().find((record) => record.kind === "turn.complete");
  assert.equal(frozen.request_token, token, "async part writes changed the original token");
  assert.equal(frozen.turn_id, turn);
  assert.equal(frozen.stop.background_tasks_pending, 1);
  assert.equal(frozen.observed.effort, "xhigh");

  const failedPart = await harness("part-failure", {
    beforeWrite: async (file) => {
      if (/answer-/.test(file)) throw new Error("native write denied");
    },
  });
  const passThrough = {};
  assert.equal(
    await failedPart.call("turn.complete", { answer: "日".repeat(20000) }, async () => passThrough),
    passThrough,
  );
  assert.equal(failedPart.records()[0].answer_capture.kind, "capture_failed");
  assert(failedPart.records()[0].answer_capture.preview.length <= 16000);

  const failed = await harness("write-failure", {
    beforeWrite: async () => {
      throw new Error("unwritable");
    },
  });
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
  await getterErrors();
  await clearIdentity();
  await clearIdentity(true);
  await fileBarrier();
} finally {
  fs.rmSync(captureRoot, { recursive: true, force: true });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-observer-test-"));
try {
  const event = { schema: 2, seq: 1, generation: "g", session_id: session, kind: "ready" };
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
  fs.writeFileSync(file, JSON.stringify({ ...event, schema: 1 }));
  assert.equal(readObserverRecords(dir, "g", 0).length, 0, "old observer schema did not fail closed");
  fs.writeFileSync(file, JSON.stringify(event));
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
        schema: 2,
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

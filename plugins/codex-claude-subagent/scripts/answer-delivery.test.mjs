import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createDeliveryFixture, reconstruct, hash } from "./fixtures/delivery-fixture.mjs";

const tool = "claude_interactive_read_answer";
const registryPath = (fixture) => path.join(fixture.stateDir, "interactive-sessions.json");
const registry = (fixture) => JSON.parse(fs.readFileSync(registryPath(fixture), "utf8"));
const answerFile = (fixture, ref) => {
  const [, id, generation, seq] = ref.split(".");
  return path.join(fixture.stateDir, "answers", id, `${generation}.${seq}.answer`);
};
const sessionArgs = (session) => ({ cwd: session.cwd, interactive_id: session.view.interactive_id });

async function expectCode(client, args, code) {
  const result = await client.raw(tool, args);
  assert.equal(result.isError, true, `expected ${code}`);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.code ?? value.error?.code, code, JSON.stringify(value));
}

function textPaths(value, sentinel, at = "") {
  if (typeof value === "string") return value.includes(sentinel) ? [at] : [];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    ["output_tail", "chunks"].includes(key) ? [] : textPaths(child, sentinel, at ? `${at}.${key}` : key),
  );
}

function rekeyViaSessionStart(session, sessionId, source) {
  const settings = JSON.parse(fs.readFileSync(session.meta.settings, "utf8"));
  let calls = 0;
  for (const group of settings.hooks.SessionStart) {
    for (const hook of group.hooks) {
      if (hook.type !== "command") continue;
      const result = spawnSync(hook.command, {
        shell: true,
        input: JSON.stringify({ session_id: sessionId, cwd: session.cwd, hook_event_name: "SessionStart", source }),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      calls += 1;
    }
  }
  assert(calls > 0, "rekey fixture did not invoke the real SessionStart bridge");
}

async function reconstruction() {
  const fixture = createDeliveryFixture();
  try {
    const client = await fixture.connect();
    const available = await client.request("tools/list");
    assert(
      available.tools.some(({ name }) => name === tool),
      "read_answer is absent. The lead must rebuild the shared bundle before integration tests.",
    );
    const session = await fixture.start(client);
    const original = "BEGIN_" + "日本語🙂".repeat(60000) + "_TAIL_SENTINEL_終";
    assert.equal(Buffer.byteLength(original), 780024);
    assert.equal(hash(original), "73a3486852919a34b41484eab1fd32d990a1d15434b191b68b09fc188b378ed8");
    const cases = process.argv.includes("--package")
      ? [["package", original]]
      : [
          ["standing-witness", original],
          ["exact-inline-limit", "A".repeat(64000)],
          ["over-inline-limit", "B".repeat(64001)],
          ["inline-surrogate", "C".repeat(63999) + "🙂終"],
          ["part-surrogate", "日".repeat(262143) + "🙂終"],
          ["over-4MiB", "日本語🙂".repeat(410000) + "_LARGE_TAIL_終"],
          ["bom-first", "\ufeff日本語🙂終"],
          ["lone-surrogate", "left\ud800right"],
          ["bom-lone-surrogate", "\ufeffleft\ud800right"],
        ];
    for (const [name, answer] of cases) {
      const result = await fixture.complete(await fixture.begin(session), answer);
      assert.equal(result.request.done, true, name);
      assert.equal(result.request.completion_transport, "claude_code_mod");
      const descriptor = result.request.full_answer;
      assert.equal(descriptor.status, "stored", name);
      assert.equal(descriptor.lossless, !name.includes("lone-surrogate"), name);
      let end = Math.min(answer.length, 64000);
      if (end < answer.length && /[\ud800-\udbff]/.test(answer[end - 1])) end -= 1;
      const expected = Buffer.from(answer).toString("utf8");
      assert.equal(result.request.result_text, expected.slice(0, end), name);
      assert.equal(result.request.result_text_truncated, end < answer.length, name);
      assert.equal(await reconstruct(client, session.cwd, descriptor), expected, name);
      assert.equal(await reconstruct(client, session.cwd, descriptor, 1048576), expected, name);
      assert.deepEqual(
        textPaths(result, result.request.result_text),
        ["request.result_text"],
        `${name}: duplicate body`,
      );
      assert.equal(result.latest_native_outcome.full_answer.ref, descriptor.ref);
      assert(!Object.hasOwn(result.last_request, "result_text"));
    }
    const small = "\ufeffA日🙂語\u001b[31m終\r\n";
    const result = await fixture.complete(await fixture.begin(session), small);
    const descriptor = result.request.full_answer;
    assert.equal(descriptor.lossless, true, "BOM reconstruction was marked lossy");
    for (const size of [4, 5, 7, 65536, 1048576]) {
      assert.equal(await reconstruct(client, session.cwd, descriptor, size), small);
    }
    const defaultPage = await client.call(tool, { cwd: session.cwd, answer_ref: descriptor.ref });
    assert.equal(defaultPage.text, small);
    const eof = await client.call(tool, { cwd: session.cwd, answer_ref: descriptor.ref, offset: descriptor.bytes });
    assert.equal(eof.text, "");
    assert.equal(eof.eof, true);
    await expectCode(client, { cwd: session.cwd, answer_ref: descriptor.ref, offset: 1 }, "offset_not_char_boundary");
    await expectCode(
      client,
      { cwd: session.cwd, answer_ref: descriptor.ref, offset: descriptor.bytes + 1 },
      "offset_out_of_range",
    );
    for (const ref of [
      "../outside",
      descriptor.ref.replace("ans1", "ans2"),
      "ans1...",
      descriptor.ref.replace(/\.\d{8}$/, ".00000000"),
    ]) {
      await expectCode(client, { cwd: session.cwd, answer_ref: ref }, "invalid_ref");
    }
    const unknown = descriptor.ref.replace(descriptor.ref.split(".")[1], randomUUID());
    await expectCode(client, { cwd: session.cwd, answer_ref: unknown }, "session_not_registered");
    await expectCode(client, { cwd: fixture.projects[1], answer_ref: descriptor.ref }, "not_in_scope");
    const file = answerFile(fixture, descriptor.ref);
    const bytes = fs.readFileSync(file);
    const newline = bytes.indexOf(10);
    const header = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.from(JSON.stringify({ ...header, ref: descriptor.ref.replace(/\d{8}$/, "99999999") }) + "\n"),
        bytes.subarray(newline + 1),
      ]),
    );
    await expectCode(client, { cwd: session.cwd, answer_ref: descriptor.ref }, "corrupt");
    fs.writeFileSync(file, bytes);
    const invalidUtf8 = Buffer.from(bytes);
    invalidUtf8[newline + 1] = 0xff;
    fs.writeFileSync(file, invalidUtf8);
    await expectCode(client, { cwd: session.cwd, answer_ref: descriptor.ref }, "corrupt");
    fs.writeFileSync(file, bytes);
    if (process.getuid?.() !== 0) {
      fs.chmodSync(file, 0);
      try {
        await expectCode(client, { cwd: session.cwd, answer_ref: descriptor.ref }, "io_error");
      } finally {
        fs.chmodSync(file, 0o600);
      }
    }
    const missingSeq = descriptor.ref.replace(/\d{8}$/, "99999998");
    await expectCode(client, { cwd: session.cwd, answer_ref: missingSeq }, "not_found");
    fs.truncateSync(file, bytes.length - 1);
    await expectCode(client, { cwd: session.cwd, answer_ref: descriptor.ref }, "corrupt");
    fs.rmSync(file);
    await expectCode(client, { cwd: session.cwd, answer_ref: descriptor.ref }, "not_found");
    const outside = path.join(fixture.root, "outside-answer");
    fs.writeFileSync(outside, bytes);
    fs.symlinkSync(outside, file);
    await expectCode(client, { cwd: session.cwd, answer_ref: descriptor.ref }, "corrupt");
    assert(fs.readFileSync(outside).equals(bytes), "ref handling changed an outside file");
    fs.rmSync(file);
    fs.writeFileSync(file, bytes);
    for (const [name, args, expectedPath] of [
      ["claude_interactive_read", sessionArgs(session), "latest_native_outcome.answer"],
      [
        "claude_interactive_wait",
        { ...sessionArgs(session), idle_ms: 1, timeout_ms: 100 },
        "latest_native_outcome.answer",
      ],
      [
        "claude_interactive_send",
        { ...sessionArgs(session), text: "unsubmitted diagnostic", submit: false },
        "latest_native_outcome.answer",
      ],
      [
        "claude_interactive_wait_request",
        { ...sessionArgs(session), request_id: result.request.request_id, idle_ms: null, timeout_ms: 100 },
        "request.result_text",
      ],
    ]) {
      const view = await client.call(name, args);
      assert.deepEqual(textPaths(view, small), [expectedPath], `${name}: not exactly one body copy`);
    }
    const stopped = await fixture.stop(session);
    assert.deepEqual(textPaths(stopped, small), ["latest_native_outcome.answer"]);
    await client.close();
    const reader = await fixture.connect();
    const persisted = await reader.call("claude_interactive_read", sessionArgs(session));
    assert.equal(persisted.status, "exited", "stop returned before close persistence");
    assert.equal(persisted.latest_native_outcome.full_answer.ref, descriptor.ref);
    assert.equal(await reconstruct(reader, session.cwd, descriptor), small);
    console.log(
      JSON.stringify({
        test: "answer reconstruction and strict pages",
        ok: true,
        package: process.argv.includes("--package"),
      }),
    );
  } finally {
    await fixture.cleanup();
  }
}

async function boundedAndLegacy() {
  const fixture = createDeliveryFixture();
  try {
    const client = await fixture.connect();
    const sessions = await Promise.all(Array.from({ length: 7 }, () => fixture.start(client)));
    const bodies = sessions.map((_session, index) => `BOUNDED_${index}_` + "日本語🙂".repeat(45000));
    const pending = await Promise.all(sessions.map((session) => fixture.begin(session)));
    await Promise.all(pending.map((request, index) => fixture.complete(request, bodies[index])));
    for (const name of ["claude_interactive_list", "claude_interactive_saved_sessions"]) {
      const view = await client.call(name, { cwd: fixture.projects[0] });
      assert.equal(view.sessions.length, sessions.length);
      assert(Buffer.byteLength(JSON.stringify(view)) < 200000, `${name}: large answer bodies escaped the bounded view`);
      for (const body of bodies) assert.equal(textPaths(view, body.slice(0, 30)).length, 0);
    }
    await Promise.all(sessions.map((session) => fixture.stop(session)));
    const data = registry(fixture);
    for (const body of bodies)
      assert.equal(textPaths(data, body.slice(0, 30)).length, 0, "registry holds native answer text");
    await client.close();
    const legacy = data.sessions.find((record) => record.interactive_id === sessions[0].view.interactive_id);
    const legacyText = "LEGACY_BODY_日🙂\n[legacy truncation marker preserved]";
    delete legacy.latest_native_outcome.full_answer;
    delete legacy.last_request.full_answer;
    delete legacy.latest_native_outcome.answer_truncated;
    delete legacy.last_request.result_text_truncated;
    legacy.latest_native_outcome.answer = legacyText;
    legacy.last_request.result_text = legacyText;
    fs.writeFileSync(registryPath(fixture), JSON.stringify(data));
    const reader = await fixture.connect();
    for (const name of ["claude_interactive_read", "claude_interactive_list", "claude_interactive_saved_sessions"]) {
      const response = await reader.call(
        name,
        name === "claude_interactive_read" ? sessionArgs(sessions[0]) : { cwd: fixture.projects[0] },
      );
      const view = response.sessions
        ? response.sessions.find((item) => item.interactive_id === sessions[0].view.interactive_id)
        : response;
      assert.equal(view.latest_native_outcome.answer, legacyText);
      assert.equal(view.last_request.result_text, legacyText);
      assert.equal(view.latest_native_outcome.full_answer.status, "legacy");
      assert.equal(view.last_request.full_answer.status, "legacy");
      assert(!Object.hasOwn(view.latest_native_outcome, "answer_truncated"));
      assert(!Object.hasOwn(view.last_request, "result_text_truncated"));
      assert.deepEqual(registry(fixture), data, `${name}: legacy registry changed`);
    }
    const resumed = await fixture.start(reader, sessions[0].cwd, { resume: sessions[0].view.claude_session_id });
    const result = await fixture.complete(await fixture.begin(resumed), "NEW_SHAPE_AFTER_LEGACY_日🙂");
    assert.equal(result.request.full_answer.status, "stored");
    assert(!Object.hasOwn(result.last_request, "result_text"));
    console.log("bounded lists, body-free registry and legacy-to-new attachment tests passed");
  } finally {
    await fixture.cleanup();
  }
}

async function failures() {
  for (const mode of ["empty", "non-string", "part-write", "tamper", "store", "persist"]) {
    const fixture = createDeliveryFixture();
    try {
      const client = await fixture.connect();
      const options = {};
      if (mode === "part-write")
        options.beforeWrite = async (file) => {
          if (/answer-/.test(file))
            throw Object.assign(new Error("injected native part write failure"), { code: "EACCES" });
        };
      if (mode === "tamper")
        options.afterWrite = async (file) => {
          if (/answer-/.test(file)) fs.appendFileSync(file, "tamper");
        };
      const session = await fixture.start(client, fixture.projects[0], options);
      const pending = await fixture.begin(session);
      let restore = () => {};
      if (mode === "store") {
        const root = path.join(fixture.stateDir, "answers");
        if (fs.existsSync(root)) fs.renameSync(root, `${root}.saved`);
        fs.writeFileSync(root, "not a directory");
        restore = () => {
          fs.rmSync(root);
          if (fs.existsSync(`${root}.saved`)) fs.renameSync(`${root}.saved`, root);
        };
      }
      if (mode === "persist") {
        const file = registryPath(fixture);
        fs.renameSync(file, `${file}.saved`);
        fs.mkdirSync(file);
        restore = () => {
          fs.rmdirSync(file);
          fs.renameSync(`${file}.saved`, file);
        };
      }
      let result;
      try {
        result = await fixture.complete(
          pending,
          mode === "empty" ? "" : mode === "non-string" ? { invalid: true } : "FAILURE_PREVIEW_日🙂",
        );
        assert.equal(result.request.done, true, `${mode}: storage changed native completion`);
        assert.equal(result.request.status, "completed", mode);
        const descriptor = result.request.full_answer;
        if (mode === "empty") {
          assert.equal(descriptor.status, "empty");
          assert.equal(result.request.result_text, null);
        } else if (mode === "non-string") {
          assert.equal(descriptor.status, "not_captured");
          assert.equal(descriptor.reason, "invalid_type");
        } else if (mode === "part-write" || mode === "tamper") {
          assert.equal(descriptor.status, "not_captured");
          assert.equal(descriptor.reason, mode === "part-write" ? "observer_write_failed" : "integrity_mismatch");
        } else if (mode === "store") {
          assert.equal(descriptor.status, "store_failed");
          assert(descriptor.error.code && descriptor.error.message);
          assert.equal(result.request.result_text_truncated, true);
        } else {
          assert(result.persist_error?.code && result.persist_error?.message, "registry failure was only logged");
        }
      } finally {
        restore();
      }
      if (mode === "persist") {
        const next = await fixture.complete(await fixture.begin(session), "persist succeeded");
        assert.equal(next.persist_error, null, "persist_error did not clear after a successful write");
      }
      const prompts = fs.readdirSync(session.directory).filter((name) => /^prompt-/.test(name));
      assert.equal(prompts.length, mode === "persist" ? 2 : 1, `${mode}: original prompt replayed`);
      if (mode === "tamper" || mode === "store") {
        assert(
          session.observer.writes.some(({ file }) => /answer-/.test(file) && fs.existsSync(file)),
          "failed-ingest residue was deleted",
        );
      }
      await fixture.stop(session);
    } finally {
      await fixture.cleanup();
    }
  }
  console.log("answer capture, import and persistence failure tests passed");
}

async function accountingFailure() {
  if (process.getuid?.() === 0) {
    console.log("answer-store accounting EACCES test skipped for uid 0");
    return;
  }
  const fixture = createDeliveryFixture();
  let storeDir;
  try {
    const client = await fixture.connect();
    const session = await fixture.start(client);
    const record = registry(fixture).sessions.find((item) => item.interactive_id === session.view.interactive_id);
    assert(record.answer_store_id, "started session has no answer store id");
    storeDir = path.join(fixture.stateDir, "answers", record.answer_store_id);
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(storeDir, 0o300);
    fs.accessSync(storeDir, fs.constants.W_OK | fs.constants.X_OK);
    assert.throws(() => fs.readdirSync(storeDir), { code: "EACCES" });

    const answer = "ACCOUNTING_EACCES_" + "日本語🙂".repeat(6000) + "_TAIL_終";
    const result = await fixture.complete(await fixture.begin(session), answer);
    assert.equal(result.request.done, true, "accounting failure changed native completion");
    assert.equal(result.request.status, "completed");
    const descriptor = result.request.full_answer;
    assert.equal(descriptor.status, "stored", "accounting failure replaced a stored descriptor");
    assert.equal(descriptor.lossless, true);
    assert.equal(descriptor.bytes, Buffer.byteLength(answer));
    assert.equal(descriptor.sha256, hash(answer));
    assert.deepEqual(result.latest_native_outcome.full_answer, descriptor);
    assert.equal(await reconstruct(client, session.cwd, descriptor), answer);
    const view = await client.call("claude_interactive_read", sessionArgs(session));
    assert.deepEqual(view.latest_native_outcome.full_answer, descriptor);
    const persisted = registry(fixture).sessions.find((item) => item.interactive_id === session.view.interactive_id);
    assert.deepEqual(persisted.latest_native_outcome.full_answer, descriptor);
    assert.equal(
      persisted.answer_store_bytes,
      record.answer_store_bytes,
      "failed accounting changed the previous count",
    );
    assert.match(client.stderr, /EACCES/, "sizeOf permission failure was not reported");
    assert.throws(() => fs.readdirSync(storeDir), { code: "EACCES" });
    assert.deepEqual(
      fs.readdirSync(session.meta.directory).filter((name) => /^(answer-|event-)/.test(name)),
      [],
      "successful ingest retained observer residue",
    );
    console.log("stored answer survives sizeOf EACCES with full reconstruction and no observer residue");
  } finally {
    try {
      if (storeDir && fs.existsSync(storeDir)) fs.chmodSync(storeDir, 0o700);
    } finally {
      await fixture.cleanup();
    }
  }
}

async function configuredPages() {
  for (const { name, maximum, defaultSize, effectiveMaximum, effectiveDefault, answer } of [
    {
      name: "large-pages",
      maximum: 2097152,
      defaultSize: 1500000,
      effectiveMaximum: 2097152,
      effectiveDefault: 1500000,
      answer: "BEGIN_" + "a".repeat(1199989) + "_TAIL",
    },
    {
      name: "minimum-pages",
      maximum: 2,
      defaultSize: 1,
      effectiveMaximum: 4,
      effectiveDefault: 4,
      answer: "日🙂SMALL_MAX_" + "x".repeat(64000),
    },
  ]) {
    const fixture = createDeliveryFixture();
    try {
      const client = await fixture.connect({
        CODEX_CLAUDE_SUBAGENT_MAX_LOG_READ_BYTES: String(maximum),
        CODEX_CLAUDE_SUBAGENT_DEFAULT_LOG_READ_BYTES: String(defaultSize),
      });
      const info = await client.call("codex_claude_subagent_info");
      assert.equal(info.max_log_read_bytes, effectiveMaximum, name);
      assert.equal(info.default_log_read_bytes, effectiveDefault, name);
      const session = await fixture.start(client);
      const result = await fixture.complete(await fixture.begin(session), answer);
      const descriptor = result.request.full_answer;
      assert.equal(descriptor.status, "stored", name);
      assert.equal(descriptor.bytes, Buffer.byteLength(answer), name);
      assert.equal(descriptor.sha256, hash(answer), name);
      assert.equal(result.request.result_text, answer.slice(0, 64000), `${name}: public limit capped private preview`);
      assert.equal(result.request.result_text.length, 64000, name);
      assert.equal(result.request.result_text_truncated, true, name);
      for (const maxBytes of [undefined, effectiveMaximum]) {
        const page = await client.call(tool, {
          cwd: session.cwd,
          answer_ref: descriptor.ref,
          ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }),
        });
        assert.equal(page.start_offset, 0, name);
        assert.equal(page.answer_ref, descriptor.ref, name);
        assert.equal(page.total_bytes, descriptor.bytes, name);
        assert.equal(page.sha256, descriptor.sha256, name);
        assert.equal(page.lossless, true, name);
        if (name === "large-pages") {
          assert.equal(descriptor.bytes, 1200000);
          assert.equal(page.text, answer);
          assert.equal(page.next_offset, 1200000);
          assert.equal(page.eof, true);
          assert.equal(hash(page.text), descriptor.sha256);
        } else {
          assert.equal(page.text, "日", "minimum page split a UTF-8 character");
          assert.equal(page.next_offset, 3);
          assert.equal(page.eof, false);
        }
      }
      for (const maxBytes of [effectiveMaximum + 1, 3]) {
        const rejected = await client.raw(tool, {
          cwd: session.cwd,
          answer_ref: descriptor.ref,
          max_bytes: maxBytes,
        });
        assert.equal(rejected.isError, true, `${name}: accepted max_bytes ${maxBytes}`);
        assert.match(rejected.content[0].text, /max_bytes/, name);
      }
      console.log(`${name} MCP schema, effective defaults and independent 64000-unit preview passed`);
    } finally {
      await fixture.cleanup();
    }
  }
}

async function parallelOwnership() {
  const fixture = createDeliveryFixture();
  try {
    const [one, two] = await Promise.all([fixture.connect(), fixture.connect()]);
    const [a, b, c] = await Promise.all([
      fixture.start(one),
      fixture.start(two),
      fixture.start(one, fixture.projects[1]),
    ]);
    assert.equal(new Set([a, b, c].map((session) => session.view.claude_session_id)).size, 3);
    const pending = await Promise.all([a, b, c].map((session) => fixture.begin(session)));
    const bodies = ["SAME_CWD_A_", "SAME_CWD_B_", "OTHER_CWD_C_"].map(
      (prefix) => prefix + "日本語🙂".repeat(45000) + "_TAIL_終",
    );
    const results = await Promise.all(pending.map((request, index) => fixture.complete(request, bodies[index])));
    const descriptors = results.map((result) => result.request.full_answer);
    assert.equal(new Set(descriptors.map((descriptor) => descriptor.ref)).size, 3);
    await Promise.all(
      [a, b, c].map(async (session, index) => {
        assert.equal(results[index].request.hook_correlation_token, pending[index].token);
        assert.equal(await reconstruct(session.client, session.cwd, descriptors[index]), bodies[index]);
        const first = await session.client.call(tool, { cwd: session.cwd, answer_ref: descriptors[index].ref });
        assert.equal(first.origin.interactive_id, session.view.interactive_id);
        assert.equal(first.origin.turn_id, pending[index].turnId);
        assert.equal(first.origin.request_id, results[index].request.request_id);
      }),
    );
    assert.equal(
      await reconstruct(two, a.cwd, descriptors[0]),
      bodies[0],
      "known same-cwd ref from another MCP process was refused",
    );
    assert.equal(await reconstruct(one, b.cwd, descriptors[1]), bodies[1]);
    for (const [client, cwd, descriptor] of [
      [one, a.cwd, descriptors[2]],
      [two, c.cwd, descriptors[0]],
      [one, c.cwd, descriptors[1]],
    ]) {
      await expectCode(client, { cwd, answer_ref: descriptor.ref }, "not_in_scope");
    }
    const refused = await two.raw("claude_interactive_start", {
      cwd: a.cwd,
      role: "reviewer",
      mcp_preset: "none",
      resume_claude_session_id: a.view.claude_session_id,
    });
    assert.equal(refused.isError, true, "same-live-UUID double attachment was accepted");
    await fixture.stop(a);
    assert.equal(await reconstruct(two, b.cwd, descriptors[1]), bodies[1], "stopping one actor removed another answer");
    const rekeyedId = randomUUID();
    const resumed = await fixture.start(one, a.cwd, { resume: a.view.claude_session_id, sessionId: rekeyedId });
    assert.notEqual(resumed.view.interactive_id, a.view.interactive_id);
    const old = await one.call(tool, { cwd: a.cwd, answer_ref: descriptors[0].ref });
    assert.equal(old.origin.interactive_id, a.view.interactive_id);
    assert.equal(await reconstruct(one, a.cwd, descriptors[0]), bodies[0]);
    rekeyViaSessionStart(resumed, rekeyedId);
    const resumedPending = await fixture.begin(resumed);
    const manualTurn = randomUUID();
    await b.observer.call("turn.start", { text: "tokenless background wake", turnId: manualTurn });
    await b.observer.call("classic.Stop", { background_tasks: [], session_crons: [] });
    await b.observer.call("turn.complete", {
      turnId: manualTurn,
      answer: "TOKENLESS_B_日🙂",
      reason: "answer",
      isAborted: false,
    });
    const tokenlessView = await two.call("claude_interactive_read", sessionArgs(b));
    assert.equal(tokenlessView.latest_native_outcome.answer, "TOKENLESS_B_日🙂");
    assert.equal(
      tokenlessView.last_request.full_answer.ref,
      descriptors[1].ref,
      "tokenless completion replaced the correlated answer",
    );
    assert.equal(await reconstruct(two, b.cwd, tokenlessView.latest_native_outcome.full_answer), "TOKENLESS_B_日🙂");
    const next = await fixture.complete(resumedPending, "RESUMED_日🙂");
    assert.equal(await reconstruct(one, a.cwd, next.request.full_answer), "RESUMED_日🙂");
    assert.equal(await reconstruct(two, b.cwd, descriptors[1]), bodies[1]);
    assert.equal(await reconstruct(one, c.cwd, descriptors[2]), bodies[2]);
    const latest = await two.call("claude_interactive_read", sessionArgs(b));
    assert.equal(latest.latest_native_outcome.full_answer.ref, tokenlessView.latest_native_outcome.full_answer.ref);
    const rekeyed = registry(fixture).sessions.find((record) => record.interactive_id === resumed.view.interactive_id);
    assert.equal(rekeyed.claude_session_id, rekeyedId);
    assert.equal(rekeyed.answer_store_id, descriptors[0].ref.split(".")[1], "registry rekey orphaned the old store");
    const list = await one.call("claude_interactive_list", { cwd: a.cwd });
    const saved = await two.call("claude_interactive_saved_sessions", { cwd: a.cwd });
    for (const view of [list, saved])
      assert(
        !view.sessions.some((item) => item.interactive_id === c.view.interactive_id),
        "cwd-scoped list included another project",
      );
    for (const view of [list, saved]) {
      for (const body of bodies) assert.equal(textPaths(view, body.slice(0, 100)).length, 0, "list leaked answer body");
      assert(Buffer.byteLength(JSON.stringify(view)) < 100000, "routine list scaled with answer bytes");
    }
    const rawRegistry = fs.readFileSync(registryPath(fixture), "utf8");
    for (const body of bodies) assert(!rawRegistry.includes(body.slice(0, 100)), "registry duplicated a captured body");
    for (const record of registry(fixture).sessions) {
      assert(record.answer_store_id);
      assert.equal(typeof record.answer_store_bytes, "number");
    }
    await Promise.all([fixture.stop(resumed), fixture.stop(b), fixture.stop(c)]);
    await Promise.all([one.close(), two.close()]);
    const restarted = await fixture.connect();
    assert.equal(await reconstruct(restarted, a.cwd, descriptors[0]), bodies[0]);
    assert.equal(await reconstruct(restarted, b.cwd, descriptors[1]), bodies[1]);
    assert.equal(await reconstruct(restarted, c.cwd, descriptors[2]), bodies[2]);
    console.log("parallel same-cwd, other-cwd, multi-session and exact-UUID resume tests passed");
  } finally {
    await fixture.cleanup();
  }
}

async function clearIdentity() {
  const fixture = createDeliveryFixture();
  try {
    const [one, two] = await Promise.all([fixture.connect(), fixture.connect()]);
    const sessions = await Promise.all([
      fixture.start(one),
      fixture.start(two),
      fixture.start(two, fixture.projects[1]),
    ]);
    const [cleared, sameCwd, otherCwd] = sessions;
    const oldSessionId = cleared.view.claude_session_id;
    const beforeBodies = ["BEFORE_CLEAR_日🙂_終", "SAME_CWD_BEFORE_日🙂_終", "OTHER_CWD_BEFORE_日🙂_終"];
    const initial = await Promise.all(sessions.map((session) => fixture.begin(session)));
    const before = await Promise.all(initial.map((pending, index) => fixture.complete(pending, beforeBodies[index])));
    for (const [index, result] of before.entries()) {
      assert.equal(result.request.done, true);
      assert.equal(await reconstruct(two, sessions[index].cwd, result.request.full_answer), beforeBodies[index]);
    }
    const oldDescriptor = before[0].request.full_answer;
    const oldOrigin = (await one.call(tool, { cwd: cleared.cwd, answer_ref: oldDescriptor.ref })).origin;
    const nextSessionId = randomUUID();
    cleared.observer.setSessionId(nextSessionId);
    rekeyViaSessionStart(cleared, nextSessionId, "clear");
    await cleared.observer.call("classic.SessionStart", { source: "clear", session_id: nextSessionId });
    const adopted = await one.call("claude_interactive_read", sessionArgs(cleared));
    assert.equal(adopted.claude_session_id, nextSessionId, "real SessionStart bridge did not adopt the clear UUID");
    assert.equal(await reconstruct(one, cleared.cwd, oldDescriptor), beforeBodies[0], "clear orphaned the old ref");
    const pending = await Promise.all(sessions.map((session) => fixture.begin(session, { timeoutMs: 1500 })));
    const peerBodies = ["SAME_CWD_AFTER_日🙂_終", "OTHER_CWD_AFTER_日🙂_終"];
    const peers = await Promise.all(
      pending.slice(1).map((request, index) => fixture.complete(request, peerBodies[index])),
    );
    const held = await one.call("claude_interactive_read", sessionArgs(cleared));
    assert.equal(held.active_request.done, false, "another session falsely completed the post-clear request");
    for (const [index, session] of [sameCwd, otherCwd].entries()) {
      assert.equal(peers[index].request.done, true);
      assert.equal(peers[index].claude_session_id, session.view.claude_session_id);
      assert.equal(peers[index].request.hook_correlation_token, pending[index + 1].token);
      assert.equal(await reconstruct(two, session.cwd, peers[index].request.full_answer), peerBodies[index]);
    }
    const newBody = "AFTER_CLEAR_CURRENT_TURN_日🙂_終";
    const after = await fixture.complete(pending[0], newBody);
    assert.equal(after.claude_session_id, nextSessionId);
    assert.equal(after.request.done, true, "post-clear native completion was ignored after the session UUID changed");
    assert.equal(after.request.completion_transport, "claude_code_mod");
    assert.equal(after.request.hook_correlation_token, pending[0].token);
    assert.equal(await reconstruct(two, cleared.cwd, after.request.full_answer), newBody);
    const currentOrigin = (await two.call(tool, { cwd: cleared.cwd, answer_ref: after.request.full_answer.ref }))
      .origin;
    assert.equal(currentOrigin.claude_session_id, nextSessionId);
    assert.equal(currentOrigin.turn_id, pending[0].turnId);
    assert.equal(currentOrigin.request_id, after.request.request_id);
    assert.notEqual(after.request.full_answer.ref, oldDescriptor.ref);
    assert.equal(oldOrigin.claude_session_id, oldSessionId);
    assert.equal(oldOrigin.turn_id, initial[0].turnId);
    assert.deepEqual((await two.call(tool, { cwd: cleared.cwd, answer_ref: oldDescriptor.ref })).origin, oldOrigin);
    await expectCode(two, { cwd: otherCwd.cwd, answer_ref: oldDescriptor.ref }, "not_in_scope");
    await fixture.stop(cleared);
    const resumed = await fixture.start(one, cleared.cwd, { resume: nextSessionId });
    assert.equal(
      resumed.view.claude_session_id,
      nextSessionId,
      "exact post-clear UUID resume selected another session",
    );
    const resumedResult = await fixture.complete(await fixture.begin(resumed), "RESUMED_CLEAR_日🙂_終");
    assert.equal(resumedResult.request.done, true);
    assert.equal(await reconstruct(one, cleared.cwd, oldDescriptor), beforeBodies[0]);
    assert.equal(await reconstruct(one, cleared.cwd, after.request.full_answer), newBody);
    assert.deepEqual((await one.call(tool, { cwd: cleared.cwd, answer_ref: oldDescriptor.ref })).origin, oldOrigin);
    for (const [index, session] of [sameCwd, otherCwd].entries()) {
      const view = await two.call("claude_interactive_read", sessionArgs(session));
      assert.equal(view.claude_session_id, session.view.claude_session_id);
      assert.equal(view.last_request.full_answer.ref, peers[index].request.full_answer.ref);
      assert.equal(await reconstruct(two, session.cwd, before[index + 1].request.full_answer), beforeBodies[index + 1]);
    }
    await Promise.all([fixture.stop(resumed), fixture.stop(sameCwd), fixture.stop(otherCwd)]);
    await Promise.all([one.close(), two.close()]);
    const restarted = await fixture.connect();
    assert.equal(await reconstruct(restarted, cleared.cwd, oldDescriptor), beforeBodies[0]);
    assert.equal(await reconstruct(restarted, cleared.cwd, after.request.full_answer), newBody);
    console.log("in-process clear, old refs, exact new-UUID resume and same/other-cwd peer isolation tests passed");
  } finally {
    await fixture.cleanup();
  }
}

async function retention() {
  const artifactFields = [
    "log_path",
    "hook_event_path",
    "hook_settings_path",
    "instruction_context_path",
    "observer_event_dir",
  ];
  const assertArtifacts = (record, present, label) => {
    for (const field of artifactFields) {
      assert.equal(typeof record[field], "string", `${label}: missing fixture ${field}`);
      assert.equal(fs.existsSync(record[field]), present, `${label}: ${field} ${present ? "removed" : "remained"}`);
    }
  };
  for (const mode of ["age", "count", "bytes"]) {
    const fixture = createDeliveryFixture();
    try {
      const limits = {
        ...(mode === "count" ? { CODEX_CLAUDE_SUBAGENT_MAX_SAVED_SESSIONS: "1" } : {}),
        ...(mode === "bytes" ? { CODEX_CLAUDE_SUBAGENT_MAX_SAVED_SESSION_BYTES: "100000" } : {}),
      };
      const [client, keeper] = await Promise.all([fixture.connect(limits), fixture.connect(limits)]);
      const [live, terminal] = await Promise.all([fixture.start(keeper), fixture.start(client)]);
      const [l, t] = await Promise.all([fixture.begin(live), fixture.begin(terminal)]);
      const body = "RETENTION_" + "日🙂".repeat(70000);
      const [liveResult, terminalResult] = await Promise.all([fixture.complete(l, body), fixture.complete(t, body)]);
      const liveDescriptor = liveResult.request.full_answer;
      const terminalDescriptor = terminalResult.request.full_answer;
      const owned = registry(fixture).sessions.find((record) => record.interactive_id === terminal.view.interactive_id);
      const liveOwned = registry(fixture).sessions.find((record) => record.interactive_id === live.view.interactive_id);
      assertArtifacts(owned, true, `${mode}: terminal before eviction`);
      assertArtifacts(liveOwned, true, `${mode}: live before eviction`);
      assert(owned.answer_store_bytes >= Buffer.byteLength(body), "answer bytes were not persisted for retention");
      if (mode === "bytes") {
        const otherBytes = [
          owned.log_path,
          owned.hook_event_path,
          owned.hook_settings_path,
          owned.instruction_context_path,
        ].reduce((total, file) => total + (file && fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
        assert(otherBytes < 100000, "byte eviction fixture is already over budget without answers");
      }
      const livePending = await fixture.begin(live, { timeoutMs: 100 });
      const pendingView = await livePending.completion;
      assert(pendingView.request.pending);
      await fixture.stop(terminal);
      if (mode === "age") {
        const data = registry(fixture);
        const record = data.sessions.find((item) => item.interactive_id === terminal.view.interactive_id);
        record.updated_at = "2000-01-01T00:00:00.000Z";
        fs.writeFileSync(registryPath(fixture), JSON.stringify(data));
        const trigger = await fixture.start(client);
        await fixture.stop(trigger);
      }
      assert(
        !fs.existsSync(path.dirname(answerFile(fixture, terminalDescriptor.ref))),
        `${mode}: evicted answer directory remained ${JSON.stringify({ terminal: terminal.view.interactive_id, ref: terminalDescriptor.ref, records: registry(fixture).sessions.map(({ interactive_id, status, updated_at, answer_store_id }) => ({ interactive_id, status, updated_at, answer_store_id })), stderr: client.stderr })}`,
      );
      assertArtifacts(owned, false, `${mode}: evicted terminal`);
      assertArtifacts(liveOwned, true, `${mode}: live after terminal eviction`);
      assert(fs.existsSync(answerFile(fixture, liveDescriptor.ref)), `${mode}: live answer removed under pressure`);
      assert.equal(await reconstruct(client, live.cwd, liveDescriptor), body);
      await expectCode(client, { cwd: terminal.cwd, answer_ref: terminalDescriptor.ref }, "session_not_registered");
      const liveView = await client.call("claude_interactive_read", sessionArgs(live));
      assert.equal(liveView.status, "running");
      for (let index = 0; index < 3; index += 1) {
        const pressure = await fixture.start(client);
        const answer = await fixture.complete(await fixture.begin(pressure), body + index);
        const pressureOwned = registry(fixture).sessions.find(
          (record) => record.interactive_id === pressure.view.interactive_id,
        );
        assertArtifacts(pressureOwned, true, `${mode}: pressure ${index} before eviction`);
        await fixture.stop(pressure);
        if (mode === "age") {
          const data = registry(fixture);
          data.sessions.find((record) => record.interactive_id === pressure.view.interactive_id).updated_at =
            "2000-01-01T00:00:00.000Z";
          fs.writeFileSync(registryPath(fixture), JSON.stringify(data));
          const trigger = await fixture.start(client);
          await fixture.stop(trigger);
        }
        assert(
          !fs.existsSync(path.dirname(answerFile(fixture, answer.request.full_answer.ref))),
          `${mode}: pressure answer was not evicted`,
        );
        assertArtifacts(pressureOwned, false, `${mode}: evicted pressure ${index}`);
        assertArtifacts(liveOwned, true, `${mode}: live under pressure ${index}`);
        assert(
          fs.existsSync(answerFile(fixture, liveDescriptor.ref)),
          `${mode}: live answer removed at round ${index}`,
        );
        assert.equal(await reconstruct(keeper, live.cwd, liveDescriptor), body);
      }
      livePending.completion = keeper.call("claude_interactive_wait_request", {
        ...sessionArgs(live),
        request_id: pendingView.request.request_id,
        idle_ms: null,
        timeout_ms: 10000,
      });
      const after = await fixture.complete(livePending, "LIVE_AFTER_PRESSURE_日🙂");
      assert.equal(after.request.done, true);
      assert.equal(await reconstruct(keeper, live.cwd, after.request.full_answer), "LIVE_AFTER_PRESSURE_日🙂");
      assertArtifacts(liveOwned, true, `${mode}: live after pressure`);
      for (const actor of [client, keeper])
        assert(!actor.stderr.includes("could not remove evicted session artifacts"), `${mode}: ${actor.stderr}`);
    } finally {
      await fixture.cleanup();
    }
  }
  const fixture = createDeliveryFixture();
  try {
    const client = await fixture.connect();
    const terminal = await fixture.start(client);
    const result = await fixture.complete(await fixture.begin(terminal), "TAMPERED_RETENTION_日🙂");
    await fixture.stop(terminal);
    await client.close();
    const data = registry(fixture);
    const record = data.sessions.find((item) => item.interactive_id === terminal.view.interactive_id);
    const outsideLog = path.join(fixture.root, "outside-log");
    const nestedHook = path.join(path.dirname(record.hook_event_path), "nested", "hook-sentinel");
    const outsideSettings = path.join(fixture.root, "outside-settings");
    const symlinkSettings = path.join(path.dirname(record.hook_settings_path), "symlink-settings.json");
    const escapedInstruction = `${path.dirname(record.instruction_context_path)}/../escaped-instruction`;
    fs.mkdirSync(path.dirname(nestedHook));
    const sentinels = [outsideLog, nestedHook, outsideSettings, escapedInstruction].map((file, index) => {
      const bytes = Buffer.from(`RETENTION_SENTINEL_${index}_日🙂\n`);
      fs.writeFileSync(file, bytes);
      return { file, bytes };
    });
    fs.symlinkSync(outsideSettings, symlinkSettings);
    record.log_path = outsideLog;
    record.hook_event_path = nestedHook;
    record.hook_settings_path = symlinkSettings;
    record.instruction_context_path = escapedInstruction;
    record.updated_at = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(registryPath(fixture), JSON.stringify(data));
    const evictor = await fixture.connect();
    const trigger = await fixture.start(evictor);
    await fixture.stop(trigger);
    assert(!registry(fixture).sessions.some((item) => item.interactive_id === terminal.view.interactive_id));
    for (const { file, bytes } of sentinels)
      assert.deepEqual(fs.readFileSync(file), bytes, `tampered retention changed ${file}`);
    assert(fs.lstatSync(symlinkSettings).isSymbolicLink(), "tampered retention removed the symlink");
    assert.equal(fs.readlinkSync(symlinkSettings), outsideSettings);
    assert.deepEqual(fs.readFileSync(symlinkSettings), sentinels[2].bytes);
    assert(!fs.existsSync(path.dirname(answerFile(fixture, result.request.full_answer.ref))));
    assert(!fs.existsSync(record.observer_event_dir), "tampered retention left observer directory");
    for (const actor of [client, evictor])
      assert(!actor.stderr.includes("could not remove evicted session artifacts"), actor.stderr);
  } finally {
    await fixture.cleanup();
  }
  console.log("answer age, count, byte retention and live protection tests passed");
}

async function pendingIsolation() {
  const fixture = createDeliveryFixture();
  try {
    const [one, two] = await Promise.all([fixture.connect(), fixture.connect()]);
    const held = await fixture.start(one);
    const first = await fixture.begin(held, { timeoutMs: 100 });
    const initial = await first.completion;
    assert.equal(initial.request.pending, true);
    const waitArgs = { ...sessionArgs(held), request_id: initial.request.request_id, idle_ms: null, timeout_ms: 10000 };
    first.completion = one.call("claude_interactive_wait_request", waitArgs);
    first.completion.catch(() => {});
    const sameProcess = await fixture.start(one);
    const independent = await fixture.complete(await fixture.begin(sameProcess), "SAME_PROCESS_INDEPENDENT_日🙂");
    assert.equal(await reconstruct(one, held.cwd, independent.request.full_answer), "SAME_PROCESS_INDEPENDENT_日🙂");
    const otherProcess = await fixture.start(two);
    const other = await fixture.complete(await fixture.begin(otherProcess), "OTHER_PROCESS_INDEPENDENT_日🙂");
    assert.equal(await reconstruct(two, held.cwd, other.request.full_answer), "OTHER_PROCESS_INDEPENDENT_日🙂");
    await fixture.stop(otherProcess);
    const saved = await two.call("claude_interactive_saved_sessions", { cwd: held.cwd });
    assert(
      saved.sessions.some((item) => item.interactive_id === held.view.interactive_id && item.status === "running"),
    );
    assert(
      !fs.existsSync(path.join(fixture.stateDir, "interactive-sessions.lock")),
      "registry lock spans a waiting Claude turn",
    );
    await fixture.stop(sameProcess);
    const reader = await fixture.connect();
    for (const client of [one, two, reader]) {
      assert.equal(
        await reconstruct(client, held.cwd, independent.request.full_answer),
        "SAME_PROCESS_INDEPENDENT_日🙂",
      );
    }
    const before = await one.call("claude_interactive_read", sessionArgs(held));
    assert.equal(before.active_request.request_id, initial.request.request_id);
    assert.equal(before.active_request.done, false, "another session's drain settled the held request");
    const readWhileLanding = one.call("claude_interactive_read", sessionArgs(held));
    const waitWhileLanding = one.call("claude_interactive_wait_request", waitArgs);
    const body = "DRAIN_MULTIMIB_" + "日本語🙂".repeat(410000) + "_TAIL_終";
    const completed = await fixture.complete(first, body);
    await readWhileLanding;
    const secondWaiter = await waitWhileLanding;
    assert.equal(secondWaiter.request.full_answer.ref, completed.request.full_answer.ref);
    assert.equal(completed.request.request_id, initial.request.request_id);
    assert.equal(await reconstruct(one, held.cwd, completed.request.full_answer, 1048576), body);
    const directory = path.dirname(answerFile(fixture, completed.request.full_answer.ref));
    assert.equal(
      fs.readdirSync(directory).filter((name) => name.endsWith(".answer")).length,
      1,
      "one completion was imported more than once",
    );
    for (let index = 0; index < 3; index += 1) {
      const view = await one.call("claude_interactive_read", sessionArgs(held));
      assert.equal(view.latest_native_outcome.full_answer.ref, completed.request.full_answer.ref);
    }
    const following = await fixture.complete(await fixture.begin(held), "NEXT_MONOTONIC_TURN_終");
    assert(
      Number(following.request.full_answer.ref.split(".").at(-1)) >
        Number(completed.request.full_answer.ref.split(".").at(-1)),
    );
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith(".answer")).length, 2);
    console.log("T3/T4/T6/T8 pending isolation, overlapping drains and stopped-reader barriers passed");
  } finally {
    await fixture.cleanup();
  }
}

async function staleOwner() {
  const fixture = createDeliveryFixture();
  try {
    const [one, two] = await Promise.all([fixture.connect(), fixture.connect()]);
    const [old, peer] = await Promise.all([fixture.start(one), fixture.start(two)]);
    const original = await fixture.complete(await fixture.begin(old), "PREDECESSOR_日🙂");
    const peerResult = await fixture.complete(await fixture.begin(peer), "UNRELATED_LIVE_日🙂");
    const peerRecord = () =>
      registry(fixture).sessions.find((item) => item.interactive_id === peer.view.interactive_id);
    const peerBefore = peerRecord();
    await fixture.stop(old);
    const resumed = await fixture.start(two, old.cwd, { resume: old.view.claude_session_id });
    assert.equal(await reconstruct(two, old.cwd, original.request.full_answer), "PREDECESSOR_日🙂");
    const current = await fixture.complete(await fixture.begin(resumed), "RESUMED_OWNER_日🙂");
    await old.observer.call("turn.start", { text: "late stale event", turnId: "late-stopped-turn" });
    await old.observer.call("classic.Stop", { background_tasks: [], session_crons: [] });
    await old.observer.call("turn.complete", {
      turnId: "late-stopped-turn",
      answer: "LATE_OLD_OWNER_日🙂",
      reason: "answer",
      isAborted: false,
    });
    await one.call("claude_interactive_read", sessionArgs(old));
    await one.call("claude_interactive_saved_sessions", { cwd: old.cwd });
    const stale = await one.call("claude_interactive_read", sessionArgs(old));
    assert.equal(stale.persist_error?.code, "stale_attachment", "stale persist refusal was not observable");
    const owner = registry(fixture).sessions.find((item) => item.claude_session_id === old.view.claude_session_id);
    assert.equal(
      owner.interactive_id,
      resumed.view.interactive_id,
      "stopped owner replaced another process's live resumed record",
    );
    assert.equal(owner.status, "running");
    assert.equal(owner.answer_store_id, original.request.full_answer.ref.split(".")[1]);
    assert.equal(await reconstruct(one, old.cwd, current.request.full_answer), "RESUMED_OWNER_日🙂");
    assert.deepEqual(peerRecord(), peerBefore, "resume or stale persist changed the unrelated live record");
    assert.equal(await reconstruct(two, peer.cwd, peerResult.request.full_answer), "UNRELATED_LIVE_日🙂");
    await fixture.stop(resumed);
    const attempts = await Promise.allSettled([
      fixture.start(one, old.cwd, { resume: old.view.claude_session_id }),
      fixture.start(two, old.cwd, { resume: old.view.claude_session_id }),
    ]);
    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      1,
      "simultaneous exact UUID resumes did not produce one lease winner",
    );
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    const newUuid = await fixture.start(one, old.cwd);
    assert.notEqual(newUuid.view.claude_session_id, old.view.claude_session_id);
    assert.deepEqual(peerRecord(), peerBefore);
    const page = await two.call(tool, { cwd: old.cwd, answer_ref: original.request.full_answer.ref });
    assert.equal(page.origin.interactive_id, old.view.interactive_id);
    console.log("T9/T10 immediate cross-process resume, lease race and stale-old-owner refusal passed");
  } finally {
    await fixture.cleanup();
  }
}

async function processDeath() {
  const fixture = createDeliveryFixture();
  try {
    const [one, two] = await Promise.all([fixture.connect(), fixture.connect()]);
    const [victim, peer] = await Promise.all([fixture.start(one), fixture.start(two)]);
    const earlier = await fixture.complete(await fixture.begin(victim), "BEFORE_KILL_日🙂");
    const peerResult = await fixture.complete(await fixture.begin(peer), "SURVIVING_PEER_日🙂");
    const pending = await fixture.begin(victim, { timeoutMs: 100 });
    const pendingView = await pending.completion;
    assert(pendingView.request.pending);
    await one.call("claude_interactive_saved_sessions", { cwd: victim.cwd });
    const peerBefore = registry(fixture).sessions.find((item) => item.interactive_id === peer.view.interactive_id);
    await new Promise((resolve) => {
      one.child.once("exit", resolve);
      one.child.kill("SIGKILL");
    });
    const snapshots = await two.call("claude_interactive_saved_sessions", { cwd: victim.cwd });
    const interrupted = snapshots.sessions.find((item) => item.interactive_id === victim.view.interactive_id);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.last_request.terminal_state, "server_restarted");
    assert.equal(interrupted.last_request.done, false);
    assert.equal(await reconstruct(two, victim.cwd, earlier.request.full_answer), "BEFORE_KILL_日🙂");
    assert.equal(await reconstruct(two, peer.cwd, peerResult.request.full_answer), "SURVIVING_PEER_日🙂");
    assert.deepEqual(
      registry(fixture).sessions.find((item) => item.interactive_id === peer.view.interactive_id),
      peerBefore,
    );
    const resumed = await fixture.start(two, victim.cwd, { resume: victim.view.claude_session_id });
    const result = await fixture.complete(await fixture.begin(resumed), "AFTER_KILL_RESUME_日🙂");
    assert.equal(await reconstruct(two, resumed.cwd, result.request.full_answer), "AFTER_KILL_RESUME_日🙂");
    console.log("T12 killed-owner reconciliation, old answer recovery and exact UUID resume passed");
  } finally {
    await fixture.cleanup();
  }
}

const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const checks = {
  reconstruction,
  failures,
  accounting: accountingFailure,
  pages: configuredPages,
  parallel: parallelOwnership,
  clear: clearIdentity,
  isolation: pendingIsolation,
  stale: staleOwner,
  death: processDeath,
  retention,
  envelopes: boundedAndLegacy,
};
if (only) {
  assert(Object.hasOwn(checks, only), `Unknown test group ${only}`);
  await checks[only]();
} else {
  await reconstruction();
  if (!process.argv.includes("--package")) {
    await failures();
    await accountingFailure();
    await configuredPages();
    await parallelOwnership();
    await clearIdentity();
    await pendingIsolation();
    await staleOwner();
    await processDeath();
    await retention();
    await boundedAndLegacy();
  }
}

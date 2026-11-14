// This observer never changes an event, a model, permissions, or hook results.
let directory;
let generation;
let seq = 0;
let requestToken = null;
let turnId = null;
let stop = null;
let observed = null;
let writeQueue = Promise.resolve();

function prefix(text, limit) {
  let end = Math.min(text.length, limit);
  if (
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    end -= 1;
  return text.slice(0, end);
}

async function record($, kind, data, answer) {
  const number = ++seq;
  const identity = (async () => $.session.id())();
  identity.catch(() => {});
  const event = {
    schema: 2,
    seq: number,
    request_token: requestToken,
    turn_id: turnId,
    kind,
    at: new Date().toISOString(),
    ...data,
  };
  const write = async () => {
    directory ||= await $.env.get("CODEX_CLAUDE_SUBAGENT_OBSERVER_DIR");
    generation ||= await $.env.get("CODEX_CLAUDE_SUBAGENT_OBSERVER_GENERATION");
    const sessionId = await identity;
    if (!directory || !generation) return;
    event.generation = generation;
    event.session_id = sessionId;
    if (kind === "turn.complete") {
      if (typeof answer !== "string") {
        event.answer_capture = { kind: "invalid", type: typeof answer };
      } else if (!answer.length) {
        event.answer_capture = { kind: "empty" };
      } else {
        let stage = "encode";
        try {
          const bytes = new TextEncoder().encode(answer);
          const lossless = !/[\ud800-\udfff]/u.test(answer);
          let sha256 = null;
          try {
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
          } catch {}
          stage = "parts";
          let parts = 0;
          for (let offset = 0; offset < answer.length;) {
            const part = prefix(answer.slice(offset, offset + 262145), 262144);
            if (++parts > 9999) throw new Error("Answer exceeds the observer part count limit.");
            await $.fs.write(
              directory + "/answer-" + String(number).padStart(8, "0") + "-" + String(parts).padStart(4, "0") + ".txt",
              part,
            );
            offset += part.length;
          }
          event.answer_capture = { kind: "text", bytes: bytes.length, utf16: answer.length, sha256, parts, lossless };
        } catch (error) {
          event.answer_capture = {
            kind: "capture_failed",
            stage,
            error: String(error?.message || error).slice(0, 1000),
            preview: prefix(answer, 16000),
          };
        }
      }
    }
    await $.fs.write(directory + "/event-" + String(number).padStart(8, "0") + ".json", JSON.stringify(event));
  };
  try {
    writeQueue = writeQueue.catch(() => {}).then(write);
    await writeQueue;
  } catch {
    // Recording failure must not alter or replay Claude's processing.
  }
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    try {
      await record($, "ready", { version: await $.session.version(), model: await $.session.model() });
    } catch {
      // Observation must not turn successful session startup into a failure.
    }
    return result;
  });
  on("turn.start", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    requestToken =
      e.text.match(
        /^Codex–Claude Subagent correlation token:\s*(CODEX_CLAUDE_SUBAGENT_REQUEST_[a-z0-9_]+)\s*$/im,
      )?.[1] || null;
    turnId = e.turnId;
    stop = null;
    observed = null;
    await record($, "turn.start", {});
    return next(e);
  });
  on("turn.step", async function* ($, e, next) {
    if (!e.agentId) observed = { model: e.model, effort: e.effort ?? null, source: "turn.step" };
    return yield* next(e);
  });
  on("classic.Stop", async ($, e, next) => {
    const result = await next(e);
    stop = {
      blocked: Boolean(result.block) || Boolean(result.additionalContext?.length),
      prevent_continuation: result.preventContinuation === true,
      background_tasks_pending: Array.isArray(e.background_tasks) ? e.background_tasks.length : null,
      session_crons_pending: Array.isArray(e.session_crons) ? e.session_crons.length : null,
    };
    return result;
  });
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) {
      await record(
        $,
        "turn.complete",
        {
          turn_id: e.turnId,
          agent_id: null,
          reason: e.reason,
          is_aborted: e.isAborted,
          stop,
          observed,
          last_api_model: e.usage?.model || null,
        },
        e.answer,
      );
    }
    return result;
  });
}

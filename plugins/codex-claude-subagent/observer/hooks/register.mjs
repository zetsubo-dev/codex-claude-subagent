// This observer never changes an event, a model, permissions, or hook results.
let directory;
let generation;
let sessionId;
let seq = 0;
let requestToken = null;
let turnId = null;
let stop = null;
let observed = null;
let writeQueue = Promise.resolve();

async function record($, kind, data) {
  try {
    directory ||= await $.env.get("CODEX_CLAUDE_SUBAGENT_OBSERVER_DIR");
    generation ||= await $.env.get("CODEX_CLAUDE_SUBAGENT_OBSERVER_GENERATION");
    sessionId ||= await $.session.id();
    if (!directory || !generation) return;
    const number = ++seq;
    const event = {
      schema: 1,
      seq: number,
      generation,
      session_id: sessionId,
      request_token: requestToken,
      turn_id: turnId,
      kind,
      at: new Date().toISOString(),
      ...data,
    };
    // One immutable record per event: a partial write cannot overwrite a prior
    // start or completion. Each completion also contains its own correlation.
    writeQueue = writeQueue
      .catch(() => {})
      .then(() => $.fs.write(directory + "/event-" + String(number).padStart(8, "0") + ".json", JSON.stringify(event)));
    await writeQueue;
  } catch {
    // Recording failure must not alter or replay Claude's processing.
  }
}

function clip(text) {
  if (typeof text !== "string") return { text: "", truncated: false };
  let end = Math.min(text.length, 64000);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const truncated = end < text.length;
  return {
    text: text.slice(0, end) + (truncated ? "\n[codex-claude-subagent: response truncated; read terminal log]" : ""),
    truncated,
  };
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
      const answer = clip(e.answer);
      await record($, "turn.complete", {
        turn_id: e.turnId,
        agent_id: null,
        reason: e.reason,
        is_aborted: e.isAborted,
        answer: answer.text,
        answer_truncated: answer.truncated,
        stop,
        observed,
        last_api_model: e.usage?.model || null,
      });
    }
    return result;
  });
}

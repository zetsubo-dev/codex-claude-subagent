import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function createObserverFixture({
  directory,
  generation = "fixture-generation",
  sessionId = "11111111-1111-4111-8111-111111111111",
  getSessionId = async () => sessionId,
  beforeWrite = async () => {},
  afterWrite = async () => {},
} = {}) {
  const handlers = new Map();
  const writes = [];
  const { register } = await import(`../../observer/hooks/register.mjs?fixture=${randomUUID()}`);
  register((name, handler) => handlers.set(name, handler));
  const api = {
    env: { get: async (name) => (name.endsWith("_DIR") ? directory : generation) },
    fs: {
      write: async (file, text) => {
        if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("Mod write exceeds 4 MiB");
        await beforeWrite(file, text);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, text, "utf8");
        writes.push({ file, text });
        await afterWrite(file, text);
      },
    },
    session: {
      id: getSessionId,
      version: async () => ({ version: "2.1.322" }),
      model: async () => "fake-model",
    },
  };
  const call = (name, event = {}, next = async () => ({})) => {
    const handler = handlers.get(name);
    if (!handler && name === "classic.SessionStart") return next(event);
    return handler(api, event, next);
  };
  const observe = async (model = "fake-model", effort = "medium") => {
    const steps = handlers.get("turn.step")(api, { model, effort }, async function* () {});
    for await (const step of steps) void step;
  };
  const records = () =>
    writes.filter(({ file }) => /\/event-\d+\.json$/.test(file)).map(({ text }) => JSON.parse(text));
  const setSessionId = (value) => {
    sessionId = value;
  };
  return { handlers, api, call, observe, writes, records, setSessionId };
}

export async function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.statSync(file, { throwIfNoEntry: false })?.size) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for fixture barrier ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return file;
}

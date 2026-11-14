import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("Claude Code 2.1.322 (fixture)");
} else if (args.includes("--help")) {
  console.log(
    "--plugin-dir --settings --setting-sources --mcp-config --strict-mcp-config --append-system-prompt-file --worktree --session-id --resume --model --allowedTools",
  );
} else if (args.includes("auth")) {
  console.log(
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }),
  );
} else {
  const sessionId = args.includes("--session-id")
    ? args[args.indexOf("--session-id") + 1]
    : args[args.indexOf("--resume") + 1];
  const directory = path.join(process.env.DELIVERY_FIXTURE_CONTROL, sessionId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "ready.json"),
    JSON.stringify({
      sessionId,
      directory: process.env.CODEX_CLAUDE_SUBAGENT_OBSERVER_DIR,
      generation: process.env.CODEX_CLAUDE_SUBAGENT_OBSERVER_GENERATION,
      settings: args[args.indexOf("--settings") + 1],
    }),
  );
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  let input = "";
  let count = 0;
  process.stdin.on("data", (text) => {
    input += text;
    while (input.includes("\x1b[201~\r")) {
      const end = input.indexOf("\x1b[201~\r");
      const prompt = input.slice(0, end);
      input = input.slice(end + "\x1b[201~\r".length);
      const token =
        [
          ...prompt.matchAll(/Codex–Claude Subagent correlation token:\s*(CODEX_CLAUDE_SUBAGENT_REQUEST_[a-z0-9_]+)/g),
        ].at(-1)?.[1] || null;
      fs.writeFileSync(path.join(directory, `prompt-${++count}.json`), JSON.stringify({ token, prompt }));
    }
    if (input.includes("/exit")) process.exit(0);
  });
  console.log("fixture interactive ready");
  process.stdin.resume();
}

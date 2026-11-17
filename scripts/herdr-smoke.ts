/**
 * Manual end-to-end smoke test: real SDK sessions/manager/bridge and real hc,
 * with a deterministic offline model (no API calls). Run inside a NEW Herdr
 * terminal, never target an existing user's session. See README.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { withOfflineHarness } from "../tests/helpers/integrationHarness.ts";
import type { HerdrSnapshot } from "../src/orch/herdr-bridge.ts";

const exec = promisify(execFile);
const terminalId = process.env.HC_TERMINAL_ID;
const directory = process.argv[2];
assert.ok(terminalId, "launch this script in a new Herdr terminal (HC_TERMINAL_ID required)");
assert.ok(directory?.startsWith("/tmp/"), "provide a dedicated /tmp/ control directory");
assert.notEqual(process.env.PI_HERDR_SUBAGENTS, "0", "bridge is explicitly disabled");
await mkdir(directory, { recursive: true });
process.title = "pi";

// Official OSC 7501 root status. The root SDK session really remains idle;
// only its two controlled child sessions generate responses.
const status = (state: "idle" | "done") =>
  process.stdout.write(
    `\x1b]7501;state=${state}:app=pi:msg=${Buffer.from("Pi SDK lifecycle smoke").toString("base64")}\x1b\\`,
  );
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
async function signal(name: string) {
  const file = path.join(directory, name);
  if (await exists(file)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`timed out waiting for ${name}`));
    }, 300_000);
    const watcher = watch(directory, async () => {
      if (await exists(file)) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
    void exists(file).then((found) => {
      if (found) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
  });
}
async function label(accepts: (snapshot: HerdrSnapshot) => boolean): Promise<HerdrSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await exec("hc", ["get", terminalId!, "--json"], { timeout: 2_000 });
    const raw = JSON.parse(result.stdout).labels?.["pi.subagents"];
    if (raw) {
      const snapshot = JSON.parse(raw) as HerdrSnapshot;
      if (accepts(snapshot)) return snapshot;
    }
    assert.ok(Date.now() < deadline, "real Herdr lifecycle label did not match before timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const answer = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "Offline worker complete." }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
let release = () => {};
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
try {
  await withOfflineHarness(
    {
      mode: "rpc",
      agentFiles: {
        offline:
          "---\nname: offline\ndescription: Controlled offline SDK worker\n---\nWait for the test gate.\n",
      },
      async onRequest(request) {
        if (request.path !== "/root") await gate;
        return answer();
      },
    },
    async ({ directory: fixture, cwd, open, close, tool }) => {
      const manager = SessionManager.create(cwd, path.join(fixture, "parents"));
      const session = await open(manager);
      try {
        await tool(session, "agent_spawn", {
          path: "research",
          type: "offline",
          task: "Controlled smoke worker",
          wait: false,
        });
        await tool(session, "agent_spawn", {
          path: "/root/research/lookup",
          type: "offline",
          task: "Controlled nested smoke worker",
          wait: false,
        });
        const running = await label((s) => s.active === 2 && s.nodes.length === 2);
        assert.equal(session.isStreaming, false);
        status("idle");
        await writeFile(
          path.join(directory, "ready.json"),
          JSON.stringify({ terminalId, rootIdle: true, snapshot: running }, null, 2),
        );
        console.log(
          "READY: real SDK children running; main idle. Create 'complete' to release workers.",
        );
        await signal("complete");
        release();
        await tool(session, "agent_wait", { path: "/root/research/lookup" });
        await tool(session, "agent_wait", { path: "research" });
        const completed = await label(
          (s) => s.active === 0 && s.nodes.every((n) => n.state === "completed"),
        );
        await writeFile(
          path.join(directory, "completed.json"),
          JSON.stringify({ terminalId, snapshot: completed }, null, 2),
        );
        console.log(
          "COMPLETED: real SDK children settled. Create 'finish' to shut down and clear metadata.",
        );
        await signal("finish");
      } finally {
        release();
        await close(session);
      }
    },
  );
  const result = await exec("hc", ["get", terminalId, "--json"], { timeout: 2_000 });
  assert.equal(JSON.parse(result.stdout).labels?.["pi.subagents"], undefined);
  await writeFile(
    path.join(directory, "finished.json"),
    JSON.stringify({ terminalId, labelRemoved: true }),
  );
  status("done");
} catch (error) {
  release();
  await writeFile(path.join(directory, "failed.txt"), String(error));
  throw error;
}

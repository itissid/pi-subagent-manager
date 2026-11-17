import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { HerdrSnapshot } from "../src/orch/herdr-bridge.ts";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

const answer = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "PRIVATE CHILD ANSWER" }],
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
const agentFiles = {
  offline: "---\nname: offline\ndescription: Offline worker\n---\nPRIVATE CHILD TASK\n",
};

async function withCli(body: (labels: () => Promise<string[]>) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-cli-"));
  const logfile = path.join(directory, "labels.jsonl");
  const previous = {
    PATH: process.env.PATH,
    HC_TERMINAL_ID: process.env.HC_TERMINAL_ID,
    PI_HERDR_SUBAGENTS: process.env.PI_HERDR_SUBAGENTS,
  };
  try {
    await writeFile(
      path.join(directory, "hc"),
      `#!${process.execPath}\n` +
        `require('node:fs').appendFileSync(${JSON.stringify(logfile)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.HC_TERMINAL_ID = "t-herdr-test";
    delete process.env.PI_HERDR_SUBAGENTS;
    await body(async () => {
      const text = await readFile(logfile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const args = JSON.parse(line) as string[];
          assert.deepEqual(args.slice(0, 2), ["label", "t-herdr-test"]);
          assert.ok(args[2].startsWith("pi.subagents="));
          return args[2].slice("pi.subagents=".length);
        });
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(
      Date.now() < deadline,
      `expected real lifecycle metadata before timeout; last=${JSON.stringify(value)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "real SDK child publishes while main is idle, settles, and clears on shutdown",
  { timeout: 15000 },
  async () => {
    await withCli(async (labels) => {
      let release = () => {};
      let started = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const starting = new Promise<void>((resolve) => {
        started = resolve;
      });
      await withOfflineHarness(
        {
          mode: "rpc",
          agentFiles,
          async onRequest(request) {
            if (request.path === "/root/worker") {
              started();
              await gate;
            }
            return answer();
          },
        },
        async ({ directory, cwd, open, close, tool, errors }) => {
          const manager = SessionManager.create(cwd, path.join(directory, "parents"));
          const session = await open(manager);
          try {
            await tool(session, "agent_spawn", {
              path: "worker",
              type: "offline",
              task: "PRIVATE TASK",
              wait: false,
            });
            await starting;
            const snapshots = async () =>
              (await labels()).filter(Boolean).map((v) => JSON.parse(v) as HerdrSnapshot);
            const running = await until(snapshots, (all) => all.some((s) => s.active === 1));
            assert.equal(session.isStreaming, false, "main remains idle while SDK child runs");
            assert.equal(running.at(-1)!.sessionId, manager.getSessionId());
            assert.equal(running.at(-1)!.nodes[0].path, "/root/worker");
            assert.ok(!JSON.stringify(running).includes("PRIVATE"));
            release();
            await tool(session, "agent_wait", { path: "worker" });
            const completed = await until(
              snapshots,
              (all) => all.at(-1)?.nodes[0]?.state === "completed",
            );
            assert.equal(completed.at(-1)!.active, 0);
            await close(session);
            assert.equal((await labels()).at(-1), "", "shutdown removes only the namespaced label");
            assert.deepEqual(errors, []);
          } finally {
            release();
          }
        },
      );
    });
  },
);

test(
  "resume republishes restored children and tree navigation clears the previous branch",
  { timeout: 20000 },
  async () => {
    await withCli(async (labels) => {
      await withOfflineHarness(
        { mode: "rpc", agentFiles, onRequest: answer },
        async ({ directory, cwd, open, close, tool }) => {
          const manager = SessionManager.create(cwd, path.join(directory, "parents"));
          manager.appendMessage({
            role: "user",
            content: "Root resume fixture",
            timestamp: Date.now(),
          });
          manager.appendCustomEntry("before-herdr-children", {});
          const before = manager.getLeafId()!;
          const session = await open(manager);
          await tool(session, "agent_spawn", {
            path: "worker",
            type: "offline",
            task: "PRIVATE TASK",
          });
          const latest = async () => {
            const value = (await labels()).at(-1);
            return value ? (JSON.parse(value) as HerdrSnapshot) : undefined;
          };
          await until(latest, (s) => s?.nodes[0]?.state === "completed");
          await close(session);
          assert.equal((await labels()).at(-1), "");
          const resumedManager = SessionManager.open(manager.getSessionFile()!);
          const resumed = await open(resumedManager);
          const restored = await until(latest, (s) => s?.nodes[0]?.state === "completed");
          assert.equal(restored!.total, 1);
          await resumed.navigateTree(before, { summarize: false });
          const empty = await until(latest, (s) => s?.total === 0);
          assert.equal(empty!.sessionId, manager.getSessionId());
          assert.deepEqual(empty!.nodes, []);
          await close(resumed);
        },
      );
    });
  },
);

test(
  "print-mode SDK sessions never publish to their inherited terminal",
  { timeout: 15000 },
  async () => {
    await withCli(async (labels) => {
      await withOfflineHarness(
        { agentFiles, onRequest: answer },
        async ({ directory, cwd, open, close, tool }) => {
          const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
          await tool(session, "agent_spawn", {
            path: "worker",
            type: "offline",
            task: "PRIVATE TASK",
          });
          await close(session);
        },
      );
      assert.deepEqual(await labels(), []);
    });
  },
);

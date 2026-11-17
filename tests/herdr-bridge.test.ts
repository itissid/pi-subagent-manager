import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HERDR_LABEL_MAX_BYTES,
  HerdrBridge,
  herdrSnapshot,
  type HerdrThread,
} from "../src/orch/herdr-bridge.ts";

const thread = (path: string, state: HerdrThread["state"] = "running"): HerdrThread => ({
  path,
  parent: path.slice(0, path.lastIndexOf("/")) || null,
  type: "worker",
  state,
});

test("snapshot exports only hierarchy/state, counts active children, and excludes main", () => {
  const child = { ...thread("/root/research"), task: "PRIVATE PROMPT", output: "PRIVATE OUTPUT" };
  const snapshot = herdrSnapshot(
    "session",
    [
      thread("/root"),
      child,
      thread("/root/research/lookup", "starting"),
      thread("/independent", "paused"),
    ],
    123,
  );
  assert.deepEqual(snapshot, {
    v: 1,
    source: "pi-subagent-manager",
    sessionId: "session",
    updatedAt: 123,
    active: 2,
    total: 3,
    omitted: 0,
    nodes: [
      thread("/root/research"),
      thread("/root/research/lookup", "starting"),
      { path: "/independent", type: "worker", state: "paused" },
    ],
  });
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE"));
});

test("snapshot bounds UTF-8 bytes, prioritizes active children, and counts omitted activity", () => {
  const children = Array.from({ length: 200 }, (_, i) =>
    thread(`/root/${i}-${"界".repeat(100)}`, "completed"),
  );
  children.push(thread("/root/active"));
  children.push(thread(`/root/${"界".repeat(20000)}`));
  const snapshot = herdrSnapshot("session", children, 123);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= HERDR_LABEL_MAX_BYTES);
  assert.ok(snapshot.nodes.some((node) => node.path === "/root/active"));
  assert.equal(snapshot.active, 2);
  assert.equal(snapshot.total, children.length);
  assert.equal(snapshot.omitted, snapshot.total - snapshot.nodes.length);
});

test("missing terminal and explicit opt-out never execute the CLI", async () => {
  let writes = 0;
  for (const options of [{ terminalId: undefined }, { terminalId: "t1x", disabled: true }]) {
    const bridge = new HerdrBridge({
      ...options,
      write: async () => {
        writes++;
      },
    });
    bridge.update("s", [thread("/root/worker")]);
    await bridge.flush();
    await bridge.close();
  }
  assert.equal(writes, 0);
});

test("updates coalesce and unchanged metrics do not cause duplicate writes", async () => {
  const writes: string[] = [];
  const bridge = new HerdrBridge({
    terminalId: "t1x",
    heartbeatMs: 0,
    write: async (terminal, value) => {
      assert.equal(terminal, "t1x");
      writes.push(value);
    },
  });
  bridge.update("s", [thread("/root/worker")]);
  bridge.update("s", [thread("/root/worker", "completed")]);
  await bridge.flush();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0]).nodes[0].state, "completed");
  bridge.update("s", [thread("/root/worker", "completed")]);
  await bridge.flush();
  assert.equal(writes.length, 1);
  await bridge.close();
  assert.equal(writes.at(-1), "");
});

test("writes are serialized and the latest state wins over an in-flight write", async () => {
  const writes: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = new HerdrBridge({
    terminalId: "t1x",
    heartbeatMs: 0,
    write: async (_, value) => {
      writes.push(value);
      if (writes.length === 1) await gate;
    },
  });
  bridge.update("s", [thread("/root/worker")]);
  const flushing = bridge.flush();
  bridge.update("s", [thread("/root/worker", "paused")]);
  bridge.update("s", [thread("/root/worker", "completed")]);
  release();
  await flushing;
  assert.deepEqual(
    writes.map((value) => JSON.parse(value).nodes[0].state),
    ["running", "completed"],
  );
  await bridge.close();
});

test("transport errors are contained and the same snapshot can retry", async () => {
  let attempts = 0;
  const bridge = new HerdrBridge({
    terminalId: "t1x",
    heartbeatMs: 0,
    write: async () => {
      if (++attempts === 1) throw new Error("hc unavailable");
    },
  });
  bridge.update("s", [thread("/root/worker")]);
  await bridge.flush();
  bridge.update("s", [thread("/root/worker")]);
  await bridge.flush();
  assert.equal(attempts, 2);
  await bridge.close();
});

test("active snapshots heartbeat, then stop heartbeating after settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const writes: string[] = [];
  let now = 0;
  const bridge = new HerdrBridge({
    terminalId: "t1x",
    now: () => now,
    write: async (_, value) => {
      writes.push(value);
    },
  });
  bridge.update("s", [thread("/root/worker")]);
  await bridge.flush();
  now = 30000;
  t.mock.timers.tick(30000);
  await bridge.flush();
  assert.equal(JSON.parse(writes.at(-1)!).updatedAt, 30000);
  assert.equal(writes.length, 2);
  bridge.update("s", [thread("/root/worker", "completed")]);
  await bridge.flush();
  t.mock.timers.tick(60000);
  await bridge.flush();
  assert.equal(writes.length, 3);
  await bridge.close();
});

test("shutdown cannot resolve in the microtask gap before queued label removal", async () => {
  let releaseRemoval = () => {};
  const removal = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  let cleared = false;
  const bridge = new HerdrBridge({
    terminalId: "t1x",
    heartbeatMs: 0,
    write: async (_, value) => {
      if (value === "") {
        await removal;
        cleared = true;
      }
    },
  });
  bridge.update("s", [thread("/root/worker")]);
  const publishing = bridge.flush();
  // The writer has resolved and drain() is completing, but flush() has not
  // resumed yet. Closing here must include its subsequently queued removal.
  await Promise.resolve();
  let closeReturned = false;
  const closing = bridge.close().then(() => {
    closeReturned = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(cleared, false);
    assert.equal(
      closeReturned,
      false,
      "close returned while its old label removal was still pending",
    );
  } finally {
    releaseRemoval();
    await Promise.all([publishing, closing]);
  }
  assert.equal(cleared, true);
});

test("shutdown waits for pending publication, removes metadata, and rejects later updates", async () => {
  const writes: string[] = [];
  const bridge = new HerdrBridge({
    terminalId: "t1x",
    heartbeatMs: 0,
    write: async (_, value) => {
      writes.push(value);
    },
  });
  bridge.update("old-session", [thread("/root/old")]);
  await bridge.flush();
  bridge.update("new-session", []);
  await bridge.flush();
  assert.equal(JSON.parse(writes.at(-1)!).sessionId, "new-session");
  assert.equal(JSON.parse(writes.at(-1)!).active, 0);
  await bridge.close();
  bridge.update("new-session", [thread("/root/late")]);
  await bridge.flush();
  assert.equal(writes.at(-1), "");
});

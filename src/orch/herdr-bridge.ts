import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ThreadState } from "../types.ts";

export const HERDR_LABEL = "pi.subagents";
export const HERDR_LABEL_MAX_BYTES = 16_384;
const MAX_NODES = 128;
const exec = promisify(execFile);

export interface HerdrThread {
  path: string;
  parent?: string | null;
  type: string;
  state: ThreadState;
  /** Most recent actual final settlement; optional for legacy publishers/registries. */
  lastFinishedAt?: number;
}

export interface HerdrSnapshot {
  v: 1;
  source: "pi-subagent-manager";
  sessionId: string;
  updatedAt: number;
  active: number;
  total: number;
  omitted: number;
  nodes: HerdrThread[];
}

const isActive = (thread: HerdrThread) => thread.state === "starting" || thread.state === "running";
const priority = (thread: HerdrThread) =>
  isActive(thread) ? 0 : thread.state === "paused" ? 1 : 2;

/** Whitelist metadata: never export tasks, messages, tool arguments, or transcripts. */
export function herdrSnapshot(
  sessionId: string,
  threads: readonly HerdrThread[],
  now: number,
): HerdrSnapshot {
  const children = threads.filter((thread) => thread.path !== "/root");
  const snapshot: HerdrSnapshot = {
    v: 1,
    source: "pi-subagent-manager",
    sessionId: sessionId.slice(0, 256),
    updatedAt: now,
    active: children.filter(isActive).length,
    total: children.length,
    omitted: children.length,
    nodes: [],
  };
  for (const thread of [...children].sort(
    (a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path),
  )) {
    if (snapshot.nodes.length >= MAX_NODES) break;
    const node: HerdrThread = { path: thread.path, type: thread.type, state: thread.state };
    if (thread.parent) node.parent = thread.parent;
    if (
      thread.lastFinishedAt !== undefined &&
      Number.isSafeInteger(thread.lastFinishedAt) &&
      thread.lastFinishedAt > 0 &&
      thread.lastFinishedAt <= 8_640_000_000_000_000
    )
      node.lastFinishedAt = thread.lastFinishedAt;
    snapshot.nodes.push(node);
    snapshot.omitted--;
    // Reserve space for the real timestamp substituted at publication time.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > HERDR_LABEL_MAX_BYTES - 32) {
      snapshot.nodes.pop();
      snapshot.omitted++;
    }
  }
  return snapshot;
}

type LabelWriter = (terminalId: string, value: string) => Promise<void>;

interface HerdrBridgeOptions {
  terminalId?: string;
  disabled?: boolean;
  write?: LabelWriter;
  now?: () => number;
  debounceMs?: number;
  heartbeatMs?: number;
}

async function writeLabel(terminalId: string, value: string): Promise<void> {
  // argv, not a shell: paths and labels cannot become shell commands.
  await exec("hc", ["label", terminalId, `${HERDR_LABEL}=${value}`], {
    timeout: 2_000,
    maxBuffer: 16_384,
  });
}

/** Optional, best-effort terminal metadata integration. No daemon or PTY per child. */
export class HerdrBridge {
  private readonly terminalId: string | undefined;
  private readonly write: LabelWriter;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly heartbeatMs: number;
  private current?: HerdrSnapshot;
  private semanticKey?: string;
  private pending?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;
  private attempted = false;
  private failed = false;
  private closed = false;

  constructor(options: HerdrBridgeOptions = {}) {
    const terminalId = "terminalId" in options ? options.terminalId : process.env.HC_TERMINAL_ID;
    const disabled = options.disabled ?? process.env.PI_HERDR_SUBAGENTS === "0";
    this.terminalId =
      !disabled && terminalId && !terminalId.startsWith("-") ? terminalId : undefined;
    this.write = options.write ?? writeLabel;
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? 100;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
  }

  update(sessionId: string, threads: readonly HerdrThread[]): void {
    if (!this.terminalId || this.closed) return;
    const snapshot = herdrSnapshot(sessionId, threads, 0);
    const key = JSON.stringify(snapshot);
    if (key === this.semanticKey && !this.failed) return;
    this.semanticKey = key;
    this.current = snapshot;
    this.queueSnapshot();
    if (snapshot.active > 0 && this.heartbeatMs > 0 && !this.heartbeat) {
      this.heartbeat = setInterval(() => this.queueSnapshot(), this.heartbeatMs);
      this.heartbeat.unref();
    } else if (snapshot.active === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private queueSnapshot(): void {
    if (!this.current || this.closed) return;
    this.pending = JSON.stringify({ ...this.current, updatedAt: this.now() });
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.debounceMs);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Clear the shared marker before its promise resolves. Every caller then
    // rechecks pending work, including removal queued at the drain boundary.
    while (this.draining || this.pending !== undefined) {
      this.draining ??= this.drain().finally(() => {
        this.draining = undefined;
      });
      await this.draining;
    }
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined && this.terminalId) {
      const value = this.pending;
      this.pending = undefined;
      this.attempted = true;
      try {
        await this.write(this.terminalId, value);
        this.failed = false;
      } catch {
        // A missing CLI/disconnected core must never interrupt Pi or its subagents.
        this.failed = true;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = undefined;
    this.heartbeat = undefined;
    if (this.terminalId && (this.current || this.attempted)) this.pending = "";
    await this.flush();
  }
}

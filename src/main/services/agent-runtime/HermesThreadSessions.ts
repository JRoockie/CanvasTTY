import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";

/**
 * Which card a Hermes conversation belongs to.
 *
 * Hermes runs a turn inside its own long-lived gateway, so a lifecycle hook cannot carry the card identity the way a
 * per-process hook does: one `config.yaml` holds the hooks for every card, and the process that fires them is shared.
 * The hook therefore reports Hermes' own conversation id (`threadId`), and this resolver maps it back to a card.
 *
 * The mapping is the folder Hermes recorded for that conversation against the folders the cards were launched in.
 * One card per folder is the normal case; when several cards share a folder and none of them is bound yet, the event
 * is left unclaimed rather than guessed — a wrong card would show another card's work as its own.
 */

/** A live card the resolver may bind a conversation to. */
export interface ThreadSessionCard {
  terminalSessionId: string;
  /** The folder the card was launched in. */
  cwd: string;
  /** When the card's CLI was started (Unix milliseconds): this is what separates two cards in one folder. */
  startedAt: number;
}

export interface HermesThreadSessionsOptions {
  /** The Hermes home holding `state.db`; defaults to `HERMES_HOME`, then `~/.hermes`. */
  hermesHomeDirectory?: string;
  /** The live cards, asked on every resolution so a closed card is never returned. */
  cards(): readonly ThreadSessionCard[];
  /** Hermes surfaces whose conversations run in a folder the person opened: the ones a CanvasTTY card can be. */
  localSources?: readonly string[];
  /** One lookup may take this long before it counts as unresolved (default 2 s). */
  lookupTimeoutMs?: number;
}

/** Hermes session rows created by a person working in a folder, as opposed to a messaging surface or a job. */
const DEFAULT_LOCAL_SOURCES: readonly string[] = ["cli", "local", "tui", "desktop"];
const MAX_CHAIN_DEPTH = 6;
const LOOKUP_TIMEOUT_MS = 2_000;
/**
 * A card is launched first and Hermes writes the conversation's row a moment later, so a card that started just
 * after the row's timestamp is still the one that started it. Anything longer would hand a conversation to a card
 * launched minutes later in the same folder.
 */
const LAUNCH_GRACE_SECONDS = 10;

interface ConversationRow {
  cwd: string | null;
  source: string | null;
  /** The conversation's own start, in Unix seconds, as Hermes stored it. */
  startedAt: number | null;
  /** The conversation this one branched from, when it did. */
  parentId: string | null;
}

export class HermesThreadSessions {
  private readonly stateDbPath: string;
  private readonly cards: () => readonly ThreadSessionCard[];
  private readonly localSources: ReadonlySet<string>;
  private readonly lookupTimeoutMs: number;
  /** conversation id → the card it was resolved to, and the folder that resolved it. */
  private readonly bindings = new Map<string, { terminalSessionId: string; cwd: string }>();
  private worker: Worker | null = null;
  private pending: { resolve(value: ConversationRow | null): void } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private warned = false;

  constructor(options: HermesThreadSessionsOptions) {
    const home = options.hermesHomeDirectory
      ?? process.env.HERMES_HOME
      ?? join(homedir(), ".hermes");
    this.stateDbPath = join(home, "state.db");
    this.cards = options.cards;
    this.localSources = new Set(options.localSources ?? DEFAULT_LOCAL_SOURCES);
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  }

  /**
   * The card that owns this Hermes conversation, or null when no card can claim it (the conversation belongs to
   * another surface, or its folder is not open in a card).
   *
   * Two cards may share a folder: Hermes gives each launched CLI its own conversation, so they are told apart by
   * which conversation was created after which launch, and by a branch belonging to the card its parent belongs to.
   */
  resolve(threadId: string): Promise<string | null> {
    const bound = this.binding(threadId);
    if (bound !== null) return Promise.resolve(bound);
    // One lookup at a time: a turn fires several hooks, and they all ask about the same conversation.
    const run = this.queue.then(() => this.bind(threadId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Drops every binding of a card that is gone, so a relaunched card is resolved afresh. */
  forget(terminalSessionId: string): void {
    for (const [threadId, binding] of this.bindings) {
      if (binding.terminalSessionId === terminalSessionId) this.bindings.delete(threadId);
    }
  }

  /** Releases the reader; a later resolve starts a new one. */
  async close(): Promise<void> {
    this.bindings.clear();
    const worker = this.worker;
    this.worker = null;
    this.pending = null;
    if (worker) await worker.terminate().catch(() => undefined);
  }

  private binding(threadId: string): string | null {
    const binding = this.bindings.get(threadId);
    if (!binding) return null;
    // A card that closed or moved on cannot own this conversation any more.
    const live = this.cards().some((card) => card.terminalSessionId === binding.terminalSessionId
      && sameDirectory(card.cwd, binding.cwd));
    if (live) return binding.terminalSessionId;
    this.bindings.delete(threadId);
    return null;
  }

  private async bind(threadId: string): Promise<string | null> {
    const bound = this.binding(threadId);
    if (bound !== null) return bound;
    const row = await this.conversation(threadId);
    if (!row || !row.cwd || (row.source !== null && !this.localSources.has(row.source))) return null;
    const candidates = this.cards().filter((card) => sameDirectory(card.cwd, row.cwd!));
    if (candidates.length === 0) return null;
    const chosen = this.ownerOf(row, candidates);
    if (!chosen) return null;
    this.bindings.set(threadId, { terminalSessionId: chosen.terminalSessionId, cwd: chosen.cwd });
    return chosen.terminalSessionId;
  }

  /**
   * Which of the cards in this conversation's folder started it. A branch (`/new`, compaction) belongs to the card
   * its parent belongs to; otherwise it is the card launched last before the conversation appeared and still without
   * a conversation of its own, so two cards in one folder keep their own status.
   */
  private ownerOf(
    row: ConversationRow,
    candidates: readonly ThreadSessionCard[]
  ): ThreadSessionCard | null {
    if (row.parentId !== null) {
      const parentCard = this.binding(row.parentId);
      const parent = candidates.find((card) => card.terminalSessionId === parentCard);
      if (parent) return parent;
    }
    if (candidates.length === 1) return candidates[0]!;
    const claimed = new Set([...this.bindings.values()].map((binding) => binding.terminalSessionId));
    const free = candidates.filter((card) => !claimed.has(card.terminalSessionId));
    if (free.length === 0) return null;
    const created = row.startedAt === null ? null : row.startedAt * 1_000;
    if (created === null) {
      // No time to compare: only a card that is the folder's sole free one can be named.
      return free.length === 1 ? free[0]! : null;
    }
    // The card that was already running when the conversation appeared, the closest one to it; with clock skew the
    // nearest card either way is still the card that started it.
    const eligible = free.filter((card) => card.startedAt <= created + LAUNCH_GRACE_SECONDS * 1_000);
    const pool = eligible.length > 0 ? eligible : free;
    const byCloseness = [...pool].sort((left, right) => (
      Math.abs(left.startedAt - created) - Math.abs(right.startedAt - created)
    ));
    const chosen = byCloseness[0];
    if (!chosen) return null;
    // Two cards equally close: this event is left to a later hook rather than attributed to the wrong card.
    const runnerUp = byCloseness[1];
    if (runnerUp && Math.abs(chosen.startedAt - created) === Math.abs(runnerUp.startedAt - created)) return null;
    return chosen;
  }

  /** The folder and surface Hermes stored for a conversation, read once per uncached resolution. */
  private async conversation(threadId: string): Promise<ConversationRow | null> {
    let worker: Worker;
    try {
      worker = this.reader();
    } catch {
      return null;
    }
    // The worker answers one query at a time (this queue serializes them) and dies with its client on timeout.
    return await new Promise<ConversationRow | null>((resolve) => {
      let settled = false;
      const finish = (value: ConversationRow | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending = null;
        resolve(value);
      };
      const abandon = (): void => {
        finish(null);
        const dying = this.worker;
        this.worker = null;
        void dying?.terminate().catch(() => undefined);
        if (!this.warned) {
          this.warned = true;
          console.warn("CanvasTTY could not read the Hermes session store; agent status waits on a later hook.");
        }
      };
      const timer = setTimeout(abandon, this.lookupTimeoutMs);
      timer.unref?.();
      this.pending = { resolve: finish };
      try {
        worker.postMessage(threadId);
      } catch {
        abandon();
      }
    });
  }

  /** The long-lived reader thread; `node:sqlite` is built into Electron's Node runtime and stays off the UI thread. */
  private reader(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      let db = null;
      const chain = (db, threadId, depth, own) => {
        const row = db.prepare('SELECT id, cwd, source, parent_session_id, started_at FROM sessions WHERE id = ?').get(threadId);
        if (!row) return null;
        // The row asked about keeps its own start and parent; the folder may come from an ancestor.
        const base = own
          ? { startedAt: typeof row.started_at === 'number' ? row.started_at : null, parentId: row.parent_session_id ?? null }
          : null;
        if (row.cwd) return { cwd: row.cwd, source: row.source ?? null, ...(base ?? {}) };
        const blank = { cwd: null, source: own ? (row.source ?? null) : null, ...(base ?? {}) };
        if (!row.parent_session_id || depth >= workerData.maxDepth) return blank;
        const parent = chain(db, row.parent_session_id, depth + 1, false);
        return parent ? { ...blank, cwd: parent.cwd } : blank;
      };
      parentPort.on('message', (threadId) => {
        try {
          if (!db) {
            db = new DatabaseSync(workerData.path, { readOnly: true });
            db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000');
          }
          parentPort.postMessage({ row: chain(db, threadId, 0, true) });
        } catch {
          parentPort.postMessage({ row: null });
        }
      });
      parentPort.on('close', () => { if (db) db.close(); });
    `, { eval: true, workerData: { path: this.stateDbPath, maxDepth: MAX_CHAIN_DEPTH } });
    worker.unref?.();
    worker.on("message", (value: { row?: ConversationRow | null }) => {
      this.pending?.resolve(value?.row ?? null);
    });
    worker.on("error", () => {
      if (this.worker === worker) this.worker = null;
      this.pending?.resolve(null);
    });
    worker.on("exit", () => {
      if (this.worker === worker) this.worker = null;
      this.pending?.resolve(null);
    });
    this.worker = worker;
    return worker;
  }
}

/** Two spellings of one folder: Hermes records the folder as it was launched in, the card keeps its own path. */
function sameDirectory(left: string, right: string): boolean {
  return normalizeDirectory(left) === normalizeDirectory(right);
}

function normalizeDirectory(value: string): string {
  try {
    return resolvePath(realpathSync(value));
  } catch {
    return resolvePath(value);
  }
}

/**
 * How long a card may stay «Работает» / «Ждёт ответа» without a lifecycle signal before CanvasTTY shows «Простаивает»
 * again. The states themselves are event-driven (see ProviderRuntimeLaunch's hook mappings): a turn reports working
 * when it starts, again after every tool call, and idle when it ends. Silence for this long is therefore either a
 * turn that is still inside one very long tool call, or a hook that never arrived — and after this long the card must
 * not keep claiming work that nothing is confirming.
 */
export const STATUS_SIGNAL_TIMEOUT_MS = 5 * 60_000;

export type ObservedSignalState = "idle" | "working" | "needs_approval";

export interface StatusSignalWatchdogOptions {
  /** How much silence expires a card (default STATUS_SIGNAL_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Injectable for tests: a scheduler and its cancel. */
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Called once per expiry, with the card that went quiet. */
  onExpired(terminalSessionId: string, silenceMs: number): void;
}

/**
 * Watches the silence of every card that claims to be busy. One timer per card, reset by each signal, dropped when
 * the card reports idleness or closes, so nothing keeps the process alive after the last card is gone.
 */
export class StatusSignalWatchdog {
  private readonly timeoutMs: number;
  private readonly schedule: NonNullable<StatusSignalWatchdogOptions["schedule"]>;
  private readonly cancel: NonNullable<StatusSignalWatchdogOptions["cancel"]>;
  private readonly onExpired: StatusSignalWatchdogOptions["onExpired"];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: StatusSignalWatchdogOptions) {
    this.timeoutMs = options.timeoutMs ?? STATUS_SIGNAL_TIMEOUT_MS;
    this.schedule = options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.onExpired = options.onExpired;
  }

  /** A signal arrived: busy states hold a timer, anything else drops it. */
  observe(terminalSessionId: string, state: ObservedSignalState): void {
    if (state === "idle") {
      this.forget(terminalSessionId);
      return;
    }
    const running = this.timers.get(terminalSessionId);
    if (running !== undefined) this.cancel(running);
    const handle = this.schedule(() => {
      this.timers.delete(terminalSessionId);
      this.onExpired(terminalSessionId, this.timeoutMs);
    }, this.timeoutMs);
    handle.unref?.();
    this.timers.set(terminalSessionId, handle);
  }

  /** The card closed, failed, or was relaunched: its silence no longer means anything. */
  forget(terminalSessionId: string): void {
    const handle = this.timers.get(terminalSessionId);
    if (handle === undefined) return;
    this.cancel(handle);
    this.timers.delete(terminalSessionId);
  }

  /** How many cards are currently held at a busy state. */
  get size(): number {
    return this.timers.size;
  }

  dispose(): void {
    for (const handle of this.timers.values()) this.cancel(handle);
    this.timers.clear();
  }
}

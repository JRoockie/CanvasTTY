import assert from "node:assert/strict";
import test from "node:test";

import { STATUS_SIGNAL_TIMEOUT_MS, StatusSignalWatchdog } from "../src/main/services/statusSignalWatchdog.ts";

/** A scheduler the test drives by hand: every armed timer is a plain record. */
function fakeScheduler() {
  const armed = new Map();
  let next = 1;
  const fired = [];
  return {
    armed,
    fired,
    schedule(callback, milliseconds) {
      const id = next++;
      armed.set(id, { callback, milliseconds });
      return { id, unref() {} };
    },
    cancel(handle) {
      armed.delete(handle.id);
    },
    tick(id) {
      const entry = armed.get(id);
      if (!entry) return;
      armed.delete(id);
      fired.push(id);
      entry.callback();
    },
    fireAll() {
      for (const id of [...armed.keys()]) this.tick(id);
    }
  };
}

test("a card that reports work is held until its signal goes quiet", () => {
  const scheduler = fakeScheduler();
  const expired = [];
  const watchdog = new StatusSignalWatchdog({
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onExpired: (id, silenceMs) => expired.push([id, silenceMs])
  });

  watchdog.observe("card-1", "working");
  assert.equal(watchdog.size, 1);
  assert.deepEqual(expired, []);

  scheduler.fireAll();
  assert.deepEqual(expired, [["card-1", STATUS_SIGNAL_TIMEOUT_MS]]);
  assert.equal(watchdog.size, 0, "an expired card is not watched twice");
});

test("idle drops the timer: an idle card is never expired", () => {
  const scheduler = fakeScheduler();
  const expired = [];
  const watchdog = new StatusSignalWatchdog({
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onExpired: (id) => expired.push(id)
  });

  watchdog.observe("card-1", "working");
  watchdog.observe("card-1", "idle");
  assert.equal(watchdog.size, 0);
  scheduler.fireAll();
  assert.deepEqual(expired, [], "the turn ended, so nothing was left to expire");
});

test("every signal restarts the window, so a busy turn is never cut short", () => {
  const scheduler = fakeScheduler();
  const expired = [];
  const watchdog = new StatusSignalWatchdog({
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onExpired: (id) => expired.push(id)
  });

  watchdog.observe("card-1", "working");
  const [first] = [...scheduler.armed.keys()];
  watchdog.observe("card-1", "working");
  assert.equal(scheduler.armed.has(first), false, "the earlier window was cancelled");
  assert.equal(watchdog.size, 1, "one card holds one window");

  scheduler.fireAll();
  assert.deepEqual(expired, ["card-1"]);
});

test("waiting for an answer is a busy state too", () => {
  const scheduler = fakeScheduler();
  const expired = [];
  const watchdog = new StatusSignalWatchdog({
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onExpired: (id) => expired.push(id)
  });

  watchdog.observe("card-1", "needs_approval");
  scheduler.fireAll();
  assert.deepEqual(expired, ["card-1"], "an unanswered approval prompt cannot hold a card for ever");
});

test("a closed card is forgotten, and the next card starts clean", () => {
  const scheduler = fakeScheduler();
  const expired = [];
  const watchdog = new StatusSignalWatchdog({
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onExpired: (id) => expired.push(id)
  });

  watchdog.observe("card-1", "working");
  watchdog.observe("card-2", "working");
  watchdog.forget("card-1");
  assert.equal(watchdog.size, 1);

  scheduler.fireAll();
  assert.deepEqual(expired, ["card-2"], "only the card that is still open can expire");
});

test("the default window is the service's own constant", () => {
  const scheduler = fakeScheduler();
  const watchdog = new StatusSignalWatchdog({
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onExpired: () => {}
  });
  watchdog.observe("card-1", "working");
  const [entry] = [...scheduler.armed.values()];
  assert.equal(entry.milliseconds, STATUS_SIGNAL_TIMEOUT_MS);
  assert.ok(STATUS_SIGNAL_TIMEOUT_MS >= 60_000, "a one-minute window would cut real turns short");
  watchdog.dispose();
  assert.equal(watchdog.size, 0);
});

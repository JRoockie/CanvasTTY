import assert from "node:assert/strict";
import test from "node:test";
import { PENDING_BOUNDS_GRACE_MS, rememberPendingBounds, reconcilePendingBounds } from "../src/renderer/src/features/workspace/pendingBounds.ts";
import {
  BROWSER_BOUNDS_ID,
  createPendingCanvasBounds,
  reconcileSettingsBounds
} from "../src/renderer/src/features/settings/pendingCanvasBounds.ts";

const bounds = (x, y, width = 700, height = 430) => ({ position: { x, y }, size: { width, height } });
const session = (id, position) => ({ id, ...position });
const now = 1_786_300_000_000;

test("a dragged card keeps the bounds the person just committed while main still reports the old place", () => {
  const pending = new Map();
  rememberPendingBounds(pending, "s1", bounds(500, 300), now);
  const incoming = [session("s1", bounds(100, 100)), session("s2", bounds(0, 0))];
  const next = reconcilePendingBounds(incoming, pending, now + 800);
  assert.deepEqual(next[0].position, { x: 500, y: 300 });
  assert.deepEqual(next[1].position, { x: 0, y: 0 }, "other cards are untouched");
  assert.equal(pending.has("s1"), true, "still waiting for main to echo the move");
});

test("once main echoes the committed bounds the card follows snapshots again", () => {
  const pending = new Map();
  rememberPendingBounds(pending, "s1", bounds(500, 300), now);
  const echoed = [session("s1", bounds(500, 300))];
  const next = reconcilePendingBounds(echoed, pending, now + 200);
  assert.deepEqual(next[0].position, { x: 500, y: 300 });
  assert.equal(pending.has("s1"), false, "the echo settles the entry");
});

test("a later server-side move wins once the grace window is over", () => {
  const pending = new Map();
  rememberPendingBounds(pending, "s1", bounds(500, 300), now);
  const incoming = [session("s1", bounds(40, 40))];
  const next = reconcilePendingBounds(incoming, pending, now + PENDING_BOUNDS_GRACE_MS + 1);
  assert.deepEqual(next[0].position, { x: 40, y: 40 }, "an expired guard must not trap the card forever");
  assert.equal(pending.size, 0);
});

test("sessions without a pending entry are returned as-is", () => {
  const pending = new Map();
  const incoming = [session("s1", bounds(10, 10)), session("s2", bounds(20, 20))];
  const next = reconcilePendingBounds(incoming, pending, now);
  assert.equal(next, incoming, "no reallocation when nothing is pending");
});

// --- settings-backed cards (notes, file cards, plugin canvas, browser) ---------------------

const settingsWith = (overrides = {}) => ({
  stickyNotes: [],
  fileCards: [],
  pluginCanvas: [],
  browserCanvas: null,
  locale: "ru",
  ...overrides
});

test("a settings snapshot built before the note's own commit cannot drag the note back", () => {
  const pending = createPendingCanvasBounds();
  rememberPendingBounds(pending.stickyNotes, "n1", bounds(500, 300, 300, 220), now);
  const snapshot = settingsWith({
    stickyNotes: [
      { id: "n1", text: "hi", ...bounds(100, 100, 300, 220) },
      { id: "n2", text: "", ...bounds(20, 20, 300, 220) }
    ]
  });
  // An older response to a different patch lands after the resize.
  const next = reconcileSettingsBounds(snapshot, pending, now + 300);
  assert.deepEqual(next.stickyNotes[0].position, { x: 500, y: 300 }, "the person's own move wins");
  assert.deepEqual(next.stickyNotes[1].position, { x: 20, y: 20 }, "other notes are untouched");
  assert.equal(snapshot.stickyNotes[0].position.x, 100, "the input snapshot is not mutated");
});

test("the same rule covers file cards, plugin canvas and the browser card", () => {
  const pending = createPendingCanvasBounds();
  rememberPendingBounds(pending.fileCards, "f1", bounds(700, 700, 780, 520), now);
  rememberPendingBounds(pending.pluginCanvas, "p1", bounds(900, 900, 680, 440), now);
  rememberPendingBounds(pending.browserCanvas, BROWSER_BOUNDS_ID, bounds(1100, 1100, 920, 620), now);
  const snapshot = settingsWith({
    fileCards: [{ id: "f1", ...bounds(0, 0, 780, 520) }],
    pluginCanvas: [{ id: "p1", ...bounds(10, 10, 680, 440) }],
    browserCanvas: bounds(20, 20, 920, 620)
  });
  const next = reconcileSettingsBounds(snapshot, pending, now + 300);
  assert.deepEqual(next.fileCards[0].position, { x: 700, y: 700 });
  assert.deepEqual(next.pluginCanvas[0].position, { x: 900, y: 900 });
  assert.deepEqual(next.browserCanvas.position, { x: 1100, y: 1100 });
});

test("an echoed snapshot settles the guard and the snapshot object itself is reused when idle", () => {
  const pending = createPendingCanvasBounds();
  const committed = settingsWith({ stickyNotes: [{ id: "n1", text: "", ...bounds(500, 300, 300, 220) }] });
  rememberPendingBounds(pending.stickyNotes, "n1", bounds(500, 300, 300, 220), now);
  const echoed = reconcileSettingsBounds(committed, pending, now + 100);
  assert.deepEqual(echoed.stickyNotes[0].position, { x: 500, y: 300 });
  assert.equal(pending.stickyNotes.size, 0, "the echo releases the guard");

  const idle = settingsWith({ stickyNotes: [{ id: "n1", text: "", ...bounds(500, 300, 300, 220) }] });
  assert.equal(reconcileSettingsBounds(idle, pending, now + 200), idle, "nothing pending costs no copy");
});

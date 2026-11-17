import assert from "node:assert/strict";
import test from "node:test";
import { PENDING_BOUNDS_GRACE_MS, rememberPendingBounds, reconcilePendingBounds } from "../src/renderer/src/features/workspace/pendingBounds.ts";

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

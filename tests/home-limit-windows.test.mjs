import assert from "node:assert/strict";
import test from "node:test";
import { selectHomeModel } from "../src/renderer/src/features/home/homeModel.ts";
import { normalizeHermesLimits } from "../src/main/services/LimitsService.ts";

const NOW = Date.parse("2026-11-16T18:00:00Z");

/** What Hermes reports for OpenCode Go: a 5-hour rolling window, a week, and a month. */
const HERMES_WINDOWS = normalizeHermesLimits({
  provider: "opencode-go",
  windows: [
    { label: "Rolling window", used_percent: 0, resets_at: "2026-11-16T22:23:17+00:00" },
    { label: "Weekly", used_percent: 2, resets_at: "2026-11-23T00:00:00+00:00" },
    { label: "Monthly", used_percent: 6, resets_at: "2026-12-14T11:56:28+00:00" }
  ],
  unavailable_reason: null
});

const snapshot = {
  fetchedAt: NOW,
  providers: [{ provider: "hermes", state: "available", source: "hermes-usage-cli", fetchedAt: NOW, windows: HERMES_WINDOWS }]
};

test("the HOME limits row keeps every window instead of only the longest one", () => {
  const [row] = selectHomeModel([], snapshot, "ready", NOW, ["hermes"]).limitRows;
  assert.equal(row.state, "available");
  assert.deepEqual(row.windows.map((window) => window.id), ["hermes:rolling", "hermes:weekly", "hermes:monthly"]);
  assert.deepEqual(row.windows.map((window) => window.windowMinutes), [300, 10_080, null]);
  assert.deepEqual(row.windows.map((window) => window.usedPercent), [0, 2, 6]);
  // The headline number is still the longest window that resets on a schedule.
  assert.equal(row.window.id, "hermes:weekly");
});

test("a provider with a monthly window only still gets a row instead of an unavailable state", () => {
  const monthlyOnly = {
    fetchedAt: NOW,
    providers: [{
      provider: "hermes",
      state: "available",
      source: "hermes-usage-cli",
      fetchedAt: NOW,
      windows: HERMES_WINDOWS.filter((window) => window.windowMinutes === null)
    }]
  };
  const [row] = selectHomeModel([], monthlyOnly, "ready", NOW, ["hermes"]).limitRows;
  assert.equal(row.state, "available");
  assert.equal(row.window.windowMinutes, null);
  assert.deepEqual(row.windows.map((window) => window.id), ["hermes:monthly"]);
});

test("windows without a percentage or a reset do not become empty rows", () => {
  const partial = {
    fetchedAt: NOW,
    providers: [{
      provider: "hermes",
      state: "available",
      source: "hermes-usage-cli",
      fetchedAt: NOW,
      windows: [{ ...HERMES_WINDOWS[1], usedPercent: null, resetsAt: null }]
    }]
  };
  const [row] = selectHomeModel([], partial, "ready", NOW, ["hermes"]).limitRows;
  assert.deepEqual(row.windows, []);
  assert.equal(row.state, "unavailable");
  assert.equal(row.window, null);
});

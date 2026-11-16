import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LimitsService, normalizeHermesLimits } from "../src/main/services/LimitsService.ts";

const HERMES_PAYLOAD = {
  provider: "opencode-go",
  source: "go_usage_api",
  title: "Account limits",
  plan: null,
  fetched_at: "2026-11-16T17:37:40.058079+00:00",
  windows: [
    { label: "Rolling window", used_percent: 0.0, resets_at: "2026-11-16T22:23:17+00:00", detail: null },
    { label: "Weekly", used_percent: 2.0, resets_at: "2026-11-23T00:00:00+00:00", detail: null },
    { label: "Monthly", used_percent: 6.0, resets_at: "2026-12-14T11:56:28+00:00", detail: null }
  ],
  details: [],
  unavailable_reason: null
};

function stubRegistry(hermes) {
  return {
    get: (provider) => (provider === "hermes" ? hermes : {
      state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "not part of this test"
    }),
    snapshot: () => ({}),
    refresh: () => ({})
  };
}

const availableHermes = (executable) => ({
  state: "available", provider: "hermes", executable, launcher: "native", environment: {}, checked: []
});

async function fixture(script) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-hermes-limits-"));
  const path = join(directory, "hermes");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return { directory, path };
}

test("normalizes the Hermes rolling, weekly and monthly windows", () => {
  const windows = normalizeHermesLimits(HERMES_PAYLOAD);
  assert.deepEqual(windows.map((window) => window.id), ["hermes:rolling", "hermes:weekly", "hermes:monthly"]);
  assert.deepEqual(windows.map((window) => window.label), ["5h", "7d", "monthly"]);
  assert.deepEqual(windows.map((window) => window.windowMinutes), [300, 10_080, null]);
  assert.deepEqual(windows.map((window) => window.usedPercent), [0, 2, 6]);
  assert.deepEqual(windows.map((window) => window.slot), ["primary", "secondary", "secondary"]);
  assert.equal(windows[0].resetsAt, Date.parse("2026-11-16T22:23:17+00:00"));
  assert.ok(windows.every((window) => window.bucketId === "hermes" && window.isDefaultBucket));
});

test("keeps an unlabelled window instead of dropping its percentage", () => {
  const windows = normalizeHermesLimits({
    windows: [
      { label: "Prompt credits", used_percent: 41, resets_at: null },
      { label: "Weekly", used_percent: null, resets_at: "2026-11-23T00:00:00+00:00" },
      { label: "Weekly", used_percent: null, resets_at: null }
    ]
  });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.label), ["Prompt credits", "7d"]);
  assert.equal(windows[0].windowMinutes, null);
  assert.equal(windows[0].id, "hermes:0");
});

test("reports the Hermes unavailable reason instead of empty windows", () => {
  assert.throws(
    () => normalizeHermesLimits({ ...HERMES_PAYLOAD, windows: [], unavailable_reason: "no API key for provider 'opencode-go'" }),
    (error) => error.reason === "not-authenticated"
  );
  assert.throws(
    () => normalizeHermesLimits({ windows: "nope" }),
    (error) => error.reason === "protocol-error"
  );
});

test("reads the windows from the Hermes CLI of the registry", async () => {
  const { directory, path } = await fixture(`#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(HERMES_PAYLOAD)}\nJSON\n`);
  const service = new LimitsService(stubRegistry(availableHermes(path)), "test");
  try {
    const snapshot = await service.getProviders(["hermes"]);
    const [hermes] = snapshot.providers;
    assert.equal(hermes.state, "available");
    assert.equal(hermes.source, "hermes-usage-cli");
    assert.deepEqual(hermes.windows.map((window) => window.label), ["5h", "7d", "monthly"]);
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing Hermes CLI leaves an explained unavailable state", async () => {
  const { directory, path } = await fixture("#!/bin/sh\necho 'hermes: not logged in' >&2\nexit 1\n");
  const service = new LimitsService(stubRegistry(availableHermes(path)), "test");
  try {
    const [hermes] = (await service.getProviders(["hermes"])).providers;
    assert.equal(hermes.state, "unavailable");
    assert.equal(hermes.reason, "protocol-error");
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("no Hermes CLI means cli-not-found, not a broken card", async () => {
  const service = new LimitsService(stubRegistry({
    state: "unavailable", provider: "hermes", reason: "cli-not-found", checked: [], diagnostic: "missing"
  }), "test");
  try {
    const [hermes] = (await service.getProviders(["hermes"])).providers;
    assert.equal(hermes.state, "unavailable");
    assert.equal(hermes.reason, "cli-not-found");
    assert.equal(hermes.provider, "hermes");
  } finally {
    service.dispose();
  }
});

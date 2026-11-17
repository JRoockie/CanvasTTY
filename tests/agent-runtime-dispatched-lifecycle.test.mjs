import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_RUNTIME_ENV } from "../src/agent-runtime/runtime-protocol.mjs";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";

const POSIX_ONLY = {
  skip: process.platform === "win32"
    ? "POSIX socket behavior is covered on Unix; Windows named pipes have dedicated transport tests."
    : false
};
// The shape Hermes mints for a conversation that keeps a store (`local-<digest>`).
const HERMES_THREAD = `local-${"0123456789abcdef".repeat(4)}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-dispatched-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Runs the hook helper exactly as a dispatched Hermes hook command would: dispatcher identity, no card. */
function runDispatcherHook(dispatcher, { state, event, payload, provider = dispatcher.provider }) {
  const helper = fileURLToPath(new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url));
  const child = spawn(process.execPath, [helper, state, event], {
    env: {
      ...process.env,
      [AGENT_RUNTIME_ENV.address]: dispatcher.address,
      [AGENT_RUNTIME_ENV.provider]: provider,
      [AGENT_RUNTIME_ENV.capabilityToken]: dispatcher.capabilityToken
    },
    stdio: ["pipe", "ignore", "pipe"]
  });
  child.stdin.end(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

async function settled(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the dispatched lifecycle event never reached the app");
}

test("a dispatched Hermes event reaches the card its conversation belongs to", POSIX_ONLY, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const asked = [];
  const gateway = new RuntimeGateway({
    runtimeDirectory: root,
    onSignal: (id, signal) => signals.push({ id, signal }),
    resolveThreadSession: (provider, threadId) => {
      asked.push({ provider, threadId });
      return provider === "hermes" && threadId === HERMES_THREAD ? "card-one" : null;
    }
  });
  await gateway.start();
  t.after(() => gateway.close());
  gateway.registerSession("card-one", "hermes");
  const dispatcher = gateway.registerDispatcher("hermes");

  const result = await runDispatcherHook(dispatcher, {
    state: "working",
    event: "pre_llm_call",
    payload: { session_id: HERMES_THREAD, turn_id: "turn-one", user_message: "must stay local" }
  });
  assert.equal(result.code, 0, result.stderr);
  await settled(() => signals.length === 1);

  assert.deepEqual(asked, [{ provider: "hermes", threadId: HERMES_THREAD }]);
  assert.deepEqual(signals, [{
    id: "card-one",
    signal: { state: "working", event: "pre_llm_call", turnId: "turn-one", threadId: HERMES_THREAD }
  }]);
  // The hook's stdin never leaves the machine through a status message.
  assert.equal(JSON.stringify(signals).includes("must stay local"), false);
});

test("a conversation no card claims is dropped, and the agent is not held up by it", POSIX_ONLY, async (t) => {
  const root = await fixture(t);
  const signals = [];
  let asked = 0;
  const gateway = new RuntimeGateway({
    runtimeDirectory: root,
    onSignal: (id, signal) => signals.push({ id, signal }),
    resolveThreadSession: () => {
      asked += 1;
      return null;
    }
  });
  await gateway.start();
  t.after(() => gateway.close());
  gateway.registerSession("card-one", "hermes");
  const dispatcher = gateway.registerDispatcher("hermes");

  const result = await runDispatcherHook(dispatcher, {
    state: "working",
    event: "pre_llm_call",
    payload: { session_id: HERMES_THREAD, turn_id: "turn-one" }
  });
  assert.equal(result.code, 0, result.stderr);
  await settled(() => asked === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(signals, []);
});

test("a dispatcher capability may not report for a provider it was not issued for", POSIX_ONLY, async (t) => {
  const root = await fixture(t);
  const signals = [];
  let asked = 0;
  const gateway = new RuntimeGateway({
    runtimeDirectory: root,
    onSignal: (id, signal) => signals.push({ id, signal }),
    resolveThreadSession: () => {
      asked += 1;
      return "card-one";
    }
  });
  await gateway.start();
  t.after(() => gateway.close());
  gateway.registerSession("card-codex", "codex");
  const dispatcher = gateway.registerDispatcher("hermes");

  // Same token, another provider: the codex lease must not be reachable through Hermes' dispatcher.
  const result = await runDispatcherHook(dispatcher, {
    state: "working",
    event: "UserPromptSubmit",
    payload: { session_id: "5f1c2a90-aa11-4b22-9c33-0d44e55f6677", turn_id: "turn-one" },
    provider: "codex"
  });
  assert.equal(result.code, 0, result.stderr);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(signals, []);
  assert.equal(asked, 0);
});

test("an event with no conversation id is never sent by the helper", POSIX_ONLY, async (t) => {
  const root = await fixture(t);
  let asked = 0;
  const gateway = new RuntimeGateway({
    runtimeDirectory: root,
    onSignal: () => assert.fail("nothing may be reported for an unidentified event"),
    resolveThreadSession: () => {
      asked += 1;
      return "card-one";
    }
  });
  await gateway.start();
  t.after(() => gateway.close());
  gateway.registerSession("card-one", "hermes");
  const dispatcher = gateway.registerDispatcher("hermes");

  const result = await runDispatcherHook(dispatcher, {
    state: "working",
    event: "pre_llm_call",
    payload: { session_id: "not-a-hermes-conversation", turn_id: "turn-one" }
  });
  assert.equal(result.code, 0, result.stderr);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(asked, 0);
});

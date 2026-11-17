import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";

const HELPER = "/opt/CanvasTTY/helpers/canvastty-helper";
// What AgentRuntimeBridge hands a Hermes launch: the provider's dispatcher, with no card identity in it.
const DISPATCHER = {
  CANVASTTY_RUNTIME_ADDRESS: "/private/var/folders/canvastty/lifecycle/runtime/r-1.sock",
  CANVASTTY_RUNTIME_PROVIDER: "hermes",
  CANVASTTY_RUNTIME_CAPABILITY: "dispatcher-token"
};

function adapters(home) {
  return new ProviderRuntimeLaunchAdapters({
    helper: { command: HELPER, args: ["hook"] },
    runtimeDirectory: join(home, "runtime"),
    openCodePluginPath: "/opt/CanvasTTY/opencode-plugin.mjs",
    hermesHomeDirectory: home
  });
}

function hookEntries(yamlText, event) {
  const hooks = parse(yamlText)?.hooks ?? {};
  return (hooks[event] ?? []).map((entry) => entry.command);
}

test("a Hermes hook carries the provider-wide dispatcher, never one card's identity", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hermes-hook-dispatcher-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "config.yaml"), "model:\n  default: test\n", "utf8");

  const provider = adapters(home);
  const prepared = provider.prepare("hermes", "terminal-session-1", true, false, undefined, undefined, undefined, undefined, DISPATCHER);
  const config = await readFile(join(home, "config.yaml"), "utf8");
  const [preLlm] = hookEntries(config, "pre_llm_call");

  // Hermes runs the command without a shell: the variables must ride in a program (`env`), not as a `K=v` prefix.
  assert.ok(preLlm.startsWith("'/usr/bin/env' '"), preLlm);
  for (const [name, value] of Object.entries(DISPATCHER)) {
    assert.ok(preLlm.includes(`${name}=${value}`), `${preLlm} carries ${name}`);
  }
  // A card named here would report every card's turns as that card: Hermes' gateway runs them all from one config.
  assert.doesNotMatch(preLlm, /CANVASTTY_RUNTIME_TERMINAL_SESSION_ID/u);
  assert.match(preLlm, /'hook' 'working' 'pre_llm_call'$/u);
  assert.equal(hookEntries(config, "on_session_start").length, 1);
  assert.match(hookEntries(config, "on_session_start")[0], /'hook' 'idle' 'on_session_start'$/u);

  // A second card launches with the same identity, so the shared config is not rewritten for every launch.
  const second = provider.prepare("hermes", "terminal-session-2", true, false, undefined, undefined, undefined, undefined, DISPATCHER);
  assert.equal(await readFile(join(home, "config.yaml"), "utf8"), config);

  // The first card closing must not strip the hooks the second one still needs.
  prepared.releaseConfiguration();
  assert.equal(await readFile(join(home, "config.yaml"), "utf8"), config);
  second.releaseConfiguration();
  const cleaned = await readFile(join(home, "config.yaml"), "utf8");
  assert.doesNotMatch(cleaned, /canvastty-helper/u);
});

test("the approval the person gave to this helper is carried over to the refreshed command", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hermes-hook-consent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "config.yaml"), "model:\n  default: test\n", "utf8");
  await writeFile(join(home, "shell-hooks-allowlist.json"), `${JSON.stringify({
    approvals: [
      {
        event: "pre_llm_call",
        command: `'${HELPER}' 'hook' 'working' 'pre_llm_call'`,
        approved_at: "2026-11-15T16:18:11.978722Z",
        script_mtime_at_approval: "2026-11-11T06:48:10.000000Z"
      },
      { event: "pre_llm_call", command: 'bash "/elsewhere/other-hook.sh"', approved_at: "2026-11-15T16:18:11.978722Z" }
    ]
  }, null, 2)}\n`, "utf8");

  adapters(home).prepare("hermes", "terminal-session-1", true, false, undefined, undefined, undefined, undefined, DISPATCHER);
  const allowlist = JSON.parse(await readFile(join(home, "shell-hooks-allowlist.json"), "utf8"));

  const refreshed = allowlist.approvals.filter((entry) => entry.event === "pre_llm_call" && entry.command.includes(HELPER));
  assert.equal(refreshed.length, 1);
  assert.ok(refreshed[0].command.includes("'CANVASTTY_RUNTIME_CAPABILITY=dispatcher-token'"), refreshed[0].command);
  assert.ok(refreshed[0].command.includes(`${HELPER}' 'hook' 'working' 'pre_llm_call'`), refreshed[0].command);
  assert.notEqual(refreshed[0].approved_at, "2026-11-15T16:18:11.978722Z");
  // Someone else's hook keeps its approval exactly as it was, and no approval is invented from nothing.
  assert.deepEqual(allowlist.approvals.find((entry) => entry.command === 'bash "/elsewhere/other-hook.sh"'),
    { event: "pre_llm_call", command: 'bash "/elsewhere/other-hook.sh"', approved_at: "2026-11-15T16:18:11.978722Z" });
  assert.equal(allowlist.approvals.some((entry) => entry.event === "on_session_start"), false);
});

test("a helper the allowlist never approved stays unapproved", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hermes-hook-no-consent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "config.yaml"), "model:\n  default: test\n", "utf8");
  const empty = `${JSON.stringify({ approvals: [] }, null, 2)}\n`;
  await writeFile(join(home, "shell-hooks-allowlist.json"), empty, "utf8");

  adapters(home).prepare("hermes", "terminal-session-1", true, false, undefined, undefined, undefined, undefined, DISPATCHER);
  assert.equal(await readFile(join(home, "shell-hooks-allowlist.json"), "utf8"), empty);
});

test("another provider's hook still names its own card", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "claude-hook-identity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const identity = {
    CANVASTTY_RUNTIME_ADDRESS: "/tmp/runtime.sock",
    CANVASTTY_RUNTIME_TERMINAL_SESSION_ID: "terminal-session-1",
    CANVASTTY_RUNTIME_PROVIDER: "claude",
    CANVASTTY_RUNTIME_CAPABILITY: "card-token"
  };
  const prepared = adapters(home).prepare("claude", "terminal-session-1", true, false, undefined, undefined, undefined, undefined, identity);
  // Claude Code takes its hooks from the launch's arguments, so the identity arrives in the environment instead.
  assert.equal(JSON.stringify(prepared.args).includes("terminal-session-1"), false);
  prepared.releaseConfiguration();
});

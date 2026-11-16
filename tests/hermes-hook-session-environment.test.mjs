import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";

const HELPER = "/opt/CanvasTTY/helpers/canvastty-helper";
const SESSION_ENV = {
  CANVASTTY_RUNTIME_ADDRESS: "/Users/person/Library/Application Support/canvastty/lifecycle/runtime/r-1.sock",
  CANVASTTY_RUNTIME_TERMINAL_SESSION_ID: "terminal-session-1",
  CANVASTTY_RUNTIME_PROVIDER: "hermes",
  CANVASTTY_RUNTIME_CAPABILITY: "capability-token"
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

test("a Hermes hook carries the session's runtime identity inside its own command", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hermes-hook-env-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "config.yaml"), "model:\n  default: test\n", "utf8");

  const prepared = adapters(home).prepare("hermes", "terminal-session-1", true, false, undefined, undefined, undefined, undefined, SESSION_ENV);
  const config = await readFile(join(home, "config.yaml"), "utf8");
  const [preLlm] = hookEntries(config, "pre_llm_call");

  // Hermes runs the command without a shell: the variables must ride in a program (`env`), not as a `K=v` prefix.
  assert.ok(preLlm.startsWith("'/usr/bin/env' '"), preLlm);
  for (const [name, value] of Object.entries(SESSION_ENV)) {
    assert.ok(preLlm.includes(`${name}=${value}`), `${preLlm} carries ${name}`);
  }
  assert.match(preLlm, /'hook' 'working' 'pre_llm_call'$/u);
  assert.equal(hookEntries(config, "on_session_start").length, 1);
  assert.match(hookEntries(config, "on_session_start")[0], /'hook' 'idle' 'on_session_start'$/u);

  prepared.releaseConfiguration();
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

  adapters(home).prepare("hermes", "terminal-session-1", true, false, undefined, undefined, undefined, undefined, SESSION_ENV);
  const allowlist = JSON.parse(await readFile(join(home, "shell-hooks-allowlist.json"), "utf8"));

  const refreshed = allowlist.approvals.filter((entry) => entry.event === "pre_llm_call" && entry.command.includes(HELPER));
  assert.equal(refreshed.length, 1);
  assert.ok(refreshed[0].command.includes("'CANVASTTY_RUNTIME_CAPABILITY=capability-token'"), refreshed[0].command);
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

  adapters(home).prepare("hermes", "terminal-session-1", true, false, undefined, undefined, undefined, undefined, SESSION_ENV);
  assert.equal(await readFile(join(home, "shell-hooks-allowlist.json"), "utf8"), empty);
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HermesThreadSessions } from "../src/main/services/agent-runtime/HermesThreadSessions.ts";

const PROJECT = "project";
const OTHER = "other-project";
/** Fixed clock: Hermes stores `started_at` in Unix seconds, a card is launched in milliseconds. */
const BASE_SECONDS = 1_700_000_000;

/** A Hermes store with the one table the resolver reads, and the two folders the cards sit in. */
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "canvastty-hermes-threads-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, PROJECT), { recursive: true });
  await mkdir(join(home, OTHER), { recursive: true });
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    source TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL
  )`);
  const insert = db.prepare(
    "INSERT INTO sessions (id, cwd, source, parent_session_id, started_at) VALUES (?, ?, ?, ?, ?)"
  );
  insert.run("local-cli-project", join(home, PROJECT), "cli", null, BASE_SECONDS + 10);
  insert.run("local-cli-project-late", join(home, PROJECT), "cli", null, BASE_SECONDS + 70);
  insert.run("local-telegram", join(home, PROJECT), "telegram", null, BASE_SECONDS + 20);
  insert.run("local-child", null, "cli", "local-cli-project", BASE_SECONDS + 30);
  insert.run("local-branch", join(home, PROJECT), "cli", "local-cli-project-late", BASE_SECONDS + 80);
  db.close();
  return { home, project: join(home, PROJECT), other: join(home, OTHER) };
}

function card(terminalSessionId, cwd, secondsAfterBase) {
  return { terminalSessionId, cwd, startedAt: (BASE_SECONDS + secondsAfterBase) * 1_000 };
}

function resolver(home, cards) {
  return new HermesThreadSessions({ hermesHomeDirectory: home, cards });
}

test("a Hermes conversation resolves to the one card in the folder it ran in", async (t) => {
  const { home, project } = await fixture(t);
  const sessions = resolver(home, () => [card("card-1", project, 5)]);
  t.after(() => sessions.close());

  assert.equal(await sessions.resolve("local-cli-project"), "card-1");
  // Cached: the store is not read again for the same conversation.
  assert.equal(await sessions.resolve("local-cli-project"), "card-1");
});

test("two cards in one folder each keep their own conversation", async (t) => {
  const { home, project } = await fixture(t);
  const sessions = resolver(home, () => [card("card-early", project, 5), card("card-late", project, 60)]);
  t.after(() => sessions.close());

  // Each conversation was created right after its own card started, so each lands on its own card — in any order.
  assert.equal(await sessions.resolve("local-cli-project-late"), "card-late");
  assert.equal(await sessions.resolve("local-cli-project"), "card-early");
});

test("a conversation from another surface never moves a card", async (t) => {
  const { home, project } = await fixture(t);
  const sessions = resolver(home, () => [card("card-1", project, 5)]);
  t.after(() => sessions.close());

  assert.equal(await sessions.resolve("local-telegram"), null);
  // Nothing is bound by a refusal, and a conversation the store does not know is refused too.
  assert.equal(await sessions.resolve("local-unknown"), null);
  assert.equal(await sessions.resolve("local-cli-project"), "card-1");
});

test("a branch belongs to the card its parent belongs to", async (t) => {
  const { home, project } = await fixture(t);
  const sessions = resolver(home, () => [card("card-early", project, 5), card("card-late", project, 60)]);
  t.after(() => sessions.close());

  assert.equal(await sessions.resolve("local-cli-project-late"), "card-late");
  // `/new` inside that card starts a conversation whose parent is the card's own: it stays on that card.
  assert.equal(await sessions.resolve("local-branch"), "card-late");
});

test("a card that closed is never returned, even for a conversation it once owned", async (t) => {
  const { home, project } = await fixture(t);
  let cards = [card("card-old", project, 5)];
  const sessions = resolver(home, () => cards);
  t.after(() => sessions.close());

  assert.equal(await sessions.resolve("local-cli-project"), "card-old");
  // The card was relaunched under a new id in the same folder: the binding follows the live card.
  cards = [card("card-new", project, 5)];
  assert.equal(await sessions.resolve("local-cli-project"), "card-new");
  sessions.forget("card-old");
  assert.equal(await sessions.resolve("local-cli-project"), "card-new");
});

test("a conversation with no folder of its own inherits its parent's", async (t) => {
  const { home, project } = await fixture(t);
  const sessions = resolver(home, () => [card("card-1", project, 5)]);
  t.after(() => sessions.close());

  assert.equal(await sessions.resolve("local-child"), "card-1");
});

test("a conversation in a folder no card has open resolves to nothing", async (t) => {
  const { home, other } = await fixture(t);
  const sessions = resolver(home, () => [card("card-1", other, 5)]);
  t.after(() => sessions.close());

  assert.equal(await sessions.resolve("local-cli-project"), null);
});

// Deleting a project: confirmed in the panel; files go to .tabbold/trash, never erased; Undo restores them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHandlers } from "../src/ops.ts";
import type { Config } from "../src/config.ts";
import { Vault } from "../src/vault/vault.ts";
import { tolaria } from "../src/vault/profile.ts";
import { makeVault } from "./helpers.ts";

const files = {
  "Garden.md": "---\ntype: Project\nstatus: active\n---\n# Garden\n",
  "Other.md": "---\ntype: Project\n---\n# Other\n",
  "sessions/2026/11/s1.md": "---\ntype: Session\nbelongs_to: \"[[Garden]]\"\nstart: 2026-11-10T09:00\n---\n# s1\n",
  "web/rain.md": "---\ntype: Web Resource\nurl: https://rain.example/\nbelongs_to:\n  - \"[[Garden]]\"\n  - \"[[Other]]\"\n---\n# Rain\n\nMy notes.\n",
};

function setup(git = true) {
  const root = makeVault(files, git);
  const cfg: Config = { vault: root, gitCommit: git, webFolder: "web", sessionFolder: "sessions", profile: "tolaria", stateDir: mkdtempSync(join(tmpdir(), "tb-")) };
  const vault = new Vault(root, tolaria);
  return { root, vault, h: createHandlers(vault, cfg) };
}

test("delete a project, keep its sessions: the project note goes to the trash, links are removed", async () => {
  const { root, h } = setup();
  const r = await h.deleteProject({ name: "Garden", withSessions: false });
  assert.deepEqual(r.moved, ["Garden.md"]);
  assert.deepEqual(r.unlinked.sort(), ["sessions/2026/11/s1.md", "web/rain.md"]);
  assert.ok(!existsSync(join(root, "Garden.md")));
  assert.ok(existsSync(join(root, ".tabbold/trash", r.id, "files/Garden.md")));
  const page = readFileSync(join(root, "web/rain.md"), "utf8");
  assert.doesNotMatch(page, /Garden/);
  assert.match(page, /Other/);
  assert.match(page, /My notes\./);
  assert.doesNotMatch(readFileSync(join(root, "sessions/2026/11/s1.md"), "utf8"), /belongs_to/);
  assert.ok(!(await h.projects({})).some((p) => p.name === "Garden"));
  const log = execFileSync("git", ["-C", root, "log", "--format=%s", "-1"]).toString();
  assert.match(log, /delete project Garden/);
  // the trash isn't committed
  assert.equal(readFileSync(join(root, ".tabbold/.gitignore"), "utf8"), "*\n");
});

test("delete with sessions, then restore puts everything back exactly", async () => {
  const { root, h } = setup();
  const before = Object.fromEntries(Object.keys(files).map((f) => [f, readFileSync(join(root, f), "utf8")]));
  const r = await h.deleteProject({ name: "garden", withSessions: true });
  assert.deepEqual(r.moved.sort(), ["Garden.md", "sessions/2026/11/s1.md"]);
  assert.deepEqual(r.unlinked, ["web/rain.md"]);
  const list = await h.deletedProjects({});
  assert.equal(list[0].project, "Garden");
  assert.equal(list[0].moved, 2);
  const back = await h.restoreProject({ id: r.id });
  assert.equal(back.restored, 3);
  for (const [f, text] of Object.entries(before)) assert.equal(readFileSync(join(root, f), "utf8"), text, f);
  assert.ok((await h.projects({})).some((p) => p.name === "Garden"));
  assert.equal((await h.deletedProjects({})).length, 0);
  assert.deepEqual(readdirSync(join(root, ".tabbold/trash")), []);
});

test("unknown project and bad ids are refused", async () => {
  const { h } = setup(false);
  await assert.rejects(h.deleteProject({ name: "Nope", withSessions: false }), /No project called Nope/);
  await assert.rejects(h.restoreProject({ id: "../../etc" }), /Unknown deletion/);
});

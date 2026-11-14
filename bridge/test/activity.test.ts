import assert from "node:assert/strict";
import { readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHandlers } from "../src/ops.ts";
import { tolaria } from "../src/vault/profile.ts";
import { Vault } from "../src/vault/vault.ts";
import { makeVault, sampleVault } from "./helpers.ts";

const cfg = (root: string) => ({ vault: root, gitCommit: false, webFolder: "web", sessionFolder: "sessions", profile: "tolaria" as const });

test("project activity: newest of sessions, filed notes and the Project note", async () => {
  const root = makeVault(sampleVault, false);
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  const projects = await h.projects({});
  const bs = projects.find((p) => p.name === "Backstage IDP")!;
  assert.ok(bs.lastActiveMs, "has activity");

  // Make everything old, then add a session a week ago: that's the latest activity.
  const old = new Date(2025, 0, 1);
  for (const f of readdirSync(root, { recursive: true, withFileTypes: true }))
    if (f.isFile() && f.name.endsWith(".md")) utimesSync(join(f.parentPath, f.name), old, old);
  const weekAgo = Date.now() - 7 * 86_400_000;
  await h.saveSession({ project: "Backstage IDP", startedAt: weekAgo, endedAt: weekAgo + 3_600_000, tabs: [{ url: "https://x.example/", title: "X" }] });
  const ov = await h.overview({});
  const p = ov.find((x) => x.name === "Backstage IDP")!;
  assert.equal(p.lastActiveWhy, "session");
  assert.ok(Math.abs(p.lastActiveMs! - (weekAgo + 3_600_000)) < 60_000);

  // Filing a page note under it now makes "note" the latest.
  await h.savePageNote({ url: "https://y.example/", title: "Y", body: "hi", project: "Backstage IDP" });
  const p2 = (await h.projects({})).find((x) => x.name === "Backstage IDP")!;
  assert.equal(p2.lastActiveWhy, "note");
  assert.ok(Date.now() - p2.lastActiveMs! < 60_000);
});

test("notesForUrls: the project each page's note is filed under", async () => {
  const root = makeVault(sampleVault, false);
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  await h.savePageNote({ url: "https://filed.example/a", title: "A", body: "x", project: "Backstage IDP" });
  const r = await h.notesForUrls({ urls: ["https://filed.example/a#top", "https://nothing.example/"] });
  assert.equal(r[0].project, "Backstage IDP");
  assert.equal(r[1].project, undefined);
});

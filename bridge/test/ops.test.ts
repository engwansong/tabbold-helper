import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHandlers, dispatch } from "../src/ops.ts";
import { tolaria } from "../src/vault/profile.ts";
import { Vault } from "../src/vault/vault.ts";
import { makeVault, sampleVault } from "./helpers.ts";

function setup(git = false) {
  const root = makeVault(sampleVault, git);
  const vault = new Vault(root, tolaria);
  const h = createHandlers(vault, { vault: root, gitCommit: true, webFolder: "web", sessionFolder: "sessions", profile: "tolaria" });
  return { root, vault, h };
}

test("ping counts notes and skips hidden folders", async () => {
  const { h } = setup();
  const r = await h.ping({});
  assert.equal(r.notes, 5);
});

test("projects lists type: Project notes", async () => {
  const { h } = setup();
  const ps = await h.projects({});
  assert.deepEqual(ps.map((p) => p.name), ["Backstage IDP", "Tabbold"]);
});

test("getPage matches URL despite tracking params, resolves project and related", async () => {
  const { h } = setup();
  const ctx = await h.getPage({ url: "https://docs.gitlab.com/user/project/integrations/webhook_events#push" });
  assert.equal(ctx.note?.path, "web/gitlab-webhook-events.md");
  assert.deepEqual(ctx.note?.belongsTo, ["Backstage IDP"]);
  assert.deepEqual(ctx.projects.map((p) => p.name), ["Backstage IDP"]);
  assert.ok(ctx.related.some((r) => r.name === "gitlab-event-router"));
  assert.ok(ctx.sameSite.some((r) => r.path === "web/gitlab-ci-docs.md"));
  assert.ok(!ctx.sameSite.some((r) => r.path === ctx.note?.path), "current note not repeated");
});

test("getPage with no note returns same-site hints", async () => {
  const { h } = setup();
  const ctx = await h.getPage({ url: "https://docs.gitlab.com/api/" });
  assert.equal(ctx.note, null);
  assert.equal(ctx.sameSite.length, 2);
});

test("pages saved by Obsidian Web Clipper (source:) are recognised", async () => {
  const root = makeVault({
    ...sampleVault,
    "Clippings/Some Article.md": `---\ntitle: Some Article\nsource: "https://blog.example.com/post"\ntags: [clippings]\n---\nBody\n`,
  });
  const vault = new Vault(root, tolaria);
  const h = createHandlers(vault, { vault: root, gitCommit: false, webFolder: "web", sessionFolder: "sessions", profile: "tolaria" });
  const ctx = await h.getPage({ url: "https://blog.example.com/post/" });
  assert.equal(ctx.note?.path, "Clippings/Some Article.md");
  // Saving keeps the clipper's file and fields; adds belongs_to.
  const res = await h.savePageNote({ url: "https://blog.example.com/post", title: "x", path: ctx.note!.path, baseMtime: ctx.note!.mtimeMs, body: "Body\n", project: "Tabbold" });
  assert.equal(res.note.path, "Clippings/Some Article.md");
  assert.deepEqual(res.note.belongsTo, ["Tabbold"]);
});

test("search ranks title matches", async () => {
  const { h } = setup();
  const r = await h.search({ q: "webhook" });
  assert.equal(r[0].name, "gitlab-webhook-events");
});

test("savePageNote creates a Web Resource note and commits it", async () => {
  const { root, h } = setup(true);
  const res = await h.savePageNote({
    url: "https://backstage.io/docs/features/software-catalog/",
    title: "Software Catalog | Backstage",
    body: "Entities and processors.",
    project: "Backstage IDP",
    related: ["gitlab-event-router"],
  });
  assert.equal(res.note.path, "web/software-catalog-backstage.md");
  assert.equal(res.committed, true);
  const file = readFileSync(join(root, res.note.path), "utf8");
  assert.equal(
    file,
    [
      "---",
      "type: Web Resource",
      "url: https://backstage.io/docs/features/software-catalog/",
      "belongs_to: '[[Backstage IDP]]'",
      "related_to:",
      "  - '[[gitlab-event-router]]'",
      "---",
      "# Software Catalog | Backstage",
      "",
      "Entities and processors.",
      "",
    ].join("\n"),
  );
  const log = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"]).toString().trim();
  assert.equal(log, "tabbold: add Software Catalog | Backstage");

  // Saving again for the same URL without a path updates rather than duplicates.
  const again = await h.savePageNote({ url: "https://backstage.io/docs/features/software-catalog", title: "x", body: "v2" });
  assert.equal(again.note.path, res.note.path);
});

test("savePageNote updates existing note, preserving unknown frontmatter", async () => {
  const { root, h } = setup();
  const ctx = await h.getPage({ url: "https://docs.gitlab.com/user/project/integrations/webhook_events/" });
  const note = ctx.note!;
  const res = await h.savePageNote({
    url: note.url!,
    title: note.title,
    path: note.path,
    baseMtime: note.mtimeMs,
    body: note.body + "\nNew insight.\n",
    project: "Tabbold",
  });
  const file = readFileSync(join(root, res.note.path), "utf8");
  assert.match(file, /start_date: 2026-11-06T09:10/);
  assert.match(file, /belongs_to: '\[\[Tabbold\]\]'/);
  assert.match(file, /related_to:\n  - '\[\[gitlab-event-router\]\]'/);
  assert.match(file, /New insight\./);
});

test("savePageNote detects edits made in Tolaria since load", async () => {
  const { root, vault, h } = setup();
  const ctx = await h.getPage({ url: "https://docs.gitlab.com/ci/" });
  const note = ctx.note!;
  // Simulate an external edit.
  const abs = join(root, note.path);
  const later = new Date(Date.now() + 5000);
  utimesSync(abs, later, later);
  const resp = await dispatch(createHandlers(vault, { vault: root, gitCommit: false, webFolder: "web", sessionFolder: "sessions", profile: "tolaria" }), {
    id: 7,
    op: "savePageNote",
    args: { url: note.url, title: note.title, path: note.path, baseMtime: note.mtimeMs, body: "overwrite" },
  });
  assert.equal(resp.ok, false);
  if (!resp.ok) {
    assert.equal(resp.code, "CONFLICT");
    assert.equal(resp.current?.path, note.path);
  }
  void h;
});

test("dispatch rejects unknown ops and bad args", async () => {
  const { h } = setup();
  const a = await dispatch(h, { id: 1, op: "rm -rf" });
  assert.equal(a.ok, false);
  const b = await dispatch(h, { id: 2, op: "read", args: { path: "../../etc/passwd" } });
  assert.equal(b.ok, true); // read of a non-indexed path just returns null
  if (b.ok) assert.equal(b.result, null);
  const c = await dispatch(h, { id: 3, op: "savePageNote", args: { url: "https://x.com", title: "t", body: "b", path: "../evil.md" } });
  assert.equal(c.ok, false);
});

test("appendPageNote quotes a selection into a new or existing note", async () => {
  const { root, h } = setup(true);
  const a = await h.appendPageNote({ url: "https://example.org/article?utm_source=x", title: "An Article", text: "First line\r\nsecond line  ", project: "Tabbold" });
  assert.equal(a.note.path, "web/an-article.md");
  assert.equal(a.committed, true);
  let file = readFileSync(join(root, a.note.path), "utf8");
  assert.match(file, /belongs_to: '\[\[Tabbold\]\]'/);
  assert.match(file, /# An Article\n\n> First line\n> second line\n$/);
  // Appends to the same note (matched by URL); never changes an existing project.
  const b = await h.appendPageNote({ url: "https://example.org/article", title: "ignored", text: "Another quote", project: "Backstage IDP" });
  assert.equal(b.note.path, a.note.path);
  file = readFileSync(join(root, a.note.path), "utf8");
  assert.match(file, /> second line\n\n> Another quote\n$/);
  assert.match(file, /belongs_to: '\[\[Tabbold\]\]'/);
  const bad = await dispatch(h, { id: 1, op: "appendPageNote", args: { url: "chrome://settings", title: "", text: "x" } });
  assert.equal(bad.ok, false);
});

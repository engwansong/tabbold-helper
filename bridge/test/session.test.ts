import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHandlers, dispatch } from "../src/ops.ts";
import { localStamp, readBlock, NOTES_END, NOTES_START, TABS_END, TABS_START } from "../src/session.ts";
import { tolaria } from "../src/vault/profile.ts";
import { Vault } from "../src/vault/vault.ts";
import { makeVault, sampleVault } from "./helpers.ts";

const cfg = (root: string, gitCommit = false) => ({
  vault: root,
  gitCommit,
  webFolder: "web",
  sessionFolder: "sessions",
  profile: "tolaria" as const,
});

const start = new Date(2026, 10, 6, 9, 10).getTime(); // local time
const tabs = [
  { url: "https://docs.gitlab.com/user/project/integrations/webhook_events/", title: "Webhook events | GitLab" },
  { url: "https://backstage.io/docs/overview/", title: "What is Backstage? [docs]" },
  { url: "chrome://newtab/", title: "New Tab" },
  { url: "https://backstage.io/docs/overview/", title: "dupe" },
];

test("localStamp uses local wall-clock time", () => {
  assert.equal(localStamp(start), "2026-11-06T09:10");
});

test("start, update and end a session", async () => {
  const root = makeVault(sampleVault, true);
  const h = createHandlers(new Vault(root, tolaria), cfg(root, true));

  const started = await h.saveSession({ project: "Backstage IDP", startedAt: start, tabs: tabs.slice(0, 1) });
  assert.equal(started.note.path, "sessions/2026/11/2026-11-06-0910-backstage-idp.md");
  assert.equal(started.note.data.status, "active");
  assert.deepEqual(started.note.belongsTo, ["Backstage IDP"]);
  assert.equal(started.committed, true);

  // Tab-only update: no baseMtime needed, user notes untouched.
  const abs = join(root, started.note.path);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(`${NOTES_START}\n\n`, `${NOTES_START}\nWritten in Tolaria\n`).concat("\n## My section\n\nKeep me.\n"));
  const updated = await h.saveSession({ path: started.note.path, startedAt: start, tabs });
  const body = updated.note.body;
  assert.equal(readBlock(body, NOTES_START, NOTES_END), "Written in Tolaria");
  assert.match(body, /## My section\n\nKeep me\./);
  const pages = readBlock(body, TABS_START, TABS_END)!;
  assert.equal(pages.split("\n").length, 2, "non-http and duplicate tabs dropped");
  assert.match(pages, /^- \[Webhook events \| GitLab\]\(<https:\/\/docs\.gitlab\.com\/[^)]*>\) — \[\[gitlab-webhook-events\]\]$/m);
  assert.match(pages, /What is Backstage\? \\\[docs\\\]/, "brackets escaped");
  assert.deepEqual(updated.note.data.has, ["[[gitlab-webhook-events]]"]);
  assert.deepEqual(updated.note.belongsTo, ["Backstage IDP"], "project kept when not sent");

  const ended = await h.saveSession({
    path: started.note.path,
    startedAt: start,
    endedAt: start + 90 * 60_000,
    tabs,
    notes: "Decided to use webhooks.",
    notesBase: "Written in Tolaria",
  });
  assert.equal(ended.note.data.status, "done");
  assert.equal(ended.note.data.end_date, "2026-11-06T10:40");
  assert.equal(readBlock(ended.note.body, NOTES_START, NOTES_END), "Decided to use webhooks.");
  assert.match(ended.note.body, /Keep me\./);

  const log = execFileSync("git", ["-C", root, "log", "--format=%s"]).toString().trim().split("\n");
  assert.deepEqual(log.slice(0, 3), [
    "tabbold: end session Backstage IDP",
    "tabbold: update session Backstage IDP",
    "tabbold: start session Backstage IDP",
  ]);
});

test("notes update refuses to overwrite edits made since load", async () => {
  const root = makeVault(sampleVault);
  const vault = new Vault(root, tolaria);
  const h = createHandlers(vault, cfg(root));
  const s = await h.saveSession({ startedAt: start, tabs: [] });
  assert.equal(s.note.path, "sessions/2026/11/2026-11-06-0910-session.md");
  // Edited in Tolaria, then a tab-only update bumps the file (must keep the edit)...
  const abs = join(root, s.note.path);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(`${NOTES_START}\n\n`, `${NOTES_START}\nTolaria edit\n`));
  await h.saveSession({ path: s.note.path, startedAt: start, tabs: tabs.slice(0, 1) });
  // ...then the panel saves notes based on the old (empty) block → conflict.
  const r = await dispatch(h, {
    id: 1,
    op: "saveSession",
    args: { path: s.note.path, startedAt: start, tabs: [], notes: "x", notesBase: "" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "CONFLICT");
});

test("removed managed markers are re-added, not guessed", async () => {
  const root = makeVault(sampleVault);
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  const s = await h.saveSession({ startedAt: start, tabs: [] });
  writeFileSync(join(root, s.note.path), "---\ntype: Session\n---\n# Mine\n\nOnly my words.\n");
  const u = await h.saveSession({ path: s.note.path, startedAt: start, tabs: tabs.slice(1, 2) });
  assert.match(u.note.body, /^# Mine\n\nOnly my words\.\n\n## Pages\n\n<!-- tabbold:tabs -->/);
});

test("saveSession validates input", async () => {
  const root = makeVault(sampleVault);
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  const a = await dispatch(h, { id: 1, op: "saveSession", args: { tabs: [] } });
  assert.equal(a.ok, false);
  const b = await dispatch(h, { id: 2, op: "saveSession", args: { startedAt: start, tabs: "nope" } });
  assert.equal(b.ok, false);
});

test("parseTabs inverts renderTabs, including escaped brackets", async () => {
  const { renderTabs, parseTabs } = await import("../src/session.ts");
  const input = [
    { url: "https://a.example/x?y=1", title: "A [draft] page" },
    { url: "https://b.example/", title: "B" },
  ];
  assert.deepEqual(parseTabs(renderTabs(input, (u) => (u.includes("b.") ? "b-note" : undefined))), input);
  assert.deepEqual(parseTabs(undefined), []);
});

test("sessions lists newest first with pages and notes; resume reopens", async () => {
  const root = makeVault(sampleVault, true);
  const h = createHandlers(new Vault(root, tolaria), cfg(root, true));
  const earlier = start - 24 * 3600_000;
  const a = await h.saveSession({ project: "Tabbold", startedAt: earlier, endedAt: earlier + 60_000, tabs: tabs.slice(1, 2), notes: "old" });
  const b = await h.saveSession({ project: "Backstage IDP", startedAt: start, tabs: tabs.slice(0, 2), notes: "" });

  const list = await h.sessions({});
  assert.deepEqual(list.map((s) => s.path), [b.note.path, a.note.path]);
  assert.equal(list[1].status, "done");
  assert.equal(list[1].notes, "old");
  assert.deepEqual(list[0].pages.map((p) => p.url), [tabs[0].url, tabs[1].url]);
  assert.equal(list[0].project, "Backstage IDP");

  const one = await h.sessions({ path: a.note.path });
  assert.equal(one.length, 1);
  assert.deepEqual(await h.sessions({ path: "web/gitlab-ci-docs.md" }), [], "non-session notes ignored");

  // Resume the ended session: status active, end_date cleared, original start kept.
  const resumed = await h.saveSession({ path: a.note.path, startedAt: Date.now(), tabs: [...one[0].pages, tabs[0]] });
  assert.equal(resumed.note.data.status, "active");
  assert.equal(resumed.note.data.end_date, undefined);
  assert.equal(resumed.note.data.start_date, localStamp(earlier));
  const log = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"]).toString().trim();
  assert.equal(log, "tabbold: resume session Tabbold");
});

test("overview: projects with their sessions (newest first), colours, unsorted group", async () => {
  const root = makeVault({ ...sampleVault, "Tabbold.md": "---\ntype: Project\nstatus: active\ntabbold_color: purple\n---\n# Tabbold\n" });
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  const day = 24 * 3600_000;
  await h.saveSession({ project: "Backstage IDP", startedAt: start - day, endedAt: start - day + 60_000, tabs: tabs.slice(0, 1) });
  await h.saveSession({ project: "Backstage IDP", startedAt: start, tabs: tabs.slice(0, 2) });
  await h.saveSession({ startedAt: start + 60_000, tabs: [] });
  const o = await h.overview({});
  const bs = o.find((p) => p.name === "Backstage IDP")!;
  assert.equal(bs.sessionCount, 2);
  assert.equal(bs.sessions[0].start, "2026-11-06T09:10");
  assert.equal(bs.sessions[0].pages.length, 2);
  assert.equal(bs.lastActive, "2026-11-06T09:10");
  assert.equal(o.find((p) => p.name === "Tabbold")!.color, "purple");
  assert.equal(o.find((p) => p.name === "Tabbold")!.sessionCount, 0);
  assert.equal(o.at(-1)!.title, "Unsorted");
  assert.equal(o.at(-1)!.sessionCount, 1);
});

test("setProjectColor writes tabbold_color and validates", async () => {
  const root = makeVault(sampleVault);
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  const r = await h.setProjectColor({ project: "Backstage IDP", color: "cyan" });
  assert.match(readFileSync(join(root, r.path), "utf8"), /tabbold_color: cyan/);
  assert.equal((await h.projects({})).find((p) => p.name === "Backstage IDP")!.color, "cyan");
  assert.equal((await dispatch(h, { id: 1, op: "setProjectColor", args: { project: "Backstage IDP", color: "chartreuse" } })).ok, false);
  assert.equal((await dispatch(h, { id: 2, op: "setProjectColor", args: { project: "gitlab-event-router", color: "red" } })).ok, false, "only Project notes");
});

test("opt-in Sessions list in the Project note: managed block only, your text kept", async () => {
  const root = makeVault({ ...sampleVault, "Backstage IDP.md": "---\ntype: Project\nstatus: active\n---\n# Backstage IDP\n\nMy own words.\n" });
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  const s1 = await h.saveSession({ project: "Backstage IDP", startedAt: start, tabs: tabs.slice(0, 2), linkInProject: true });
  let proj = readFileSync(join(root, "Backstage IDP.md"), "utf8");
  assert.match(proj, /My own words\.\n\n## Sessions\n\n<!-- tabbold:sessions -->\n- \[\[2026-11-06-0910-backstage-idp\]\] · 2026-11-06 09:10 · 2 pages · running\n<!-- \/tabbold:sessions -->/);
  // Tab updates don't touch the project note; ending does.
  await h.saveSession({ path: s1.note.path, startedAt: start, tabs, linkInProject: true });
  await h.saveSession({ path: s1.note.path, startedAt: start, endedAt: start + 1, tabs, linkInProject: true });
  proj = readFileSync(join(root, "Backstage IDP.md"), "utf8");
  assert.match(proj, /- \[\[2026-11-06-0910-backstage-idp\]\] · 2026-11-06 09:10 · 2 pages\n/);
  assert.match(proj, /My own words\./);
  // Without the flag, nothing is written to the project.
  const root2 = makeVault(sampleVault);
  const h2 = createHandlers(new Vault(root2, tolaria), cfg(root2));
  await h2.saveSession({ project: "Backstage IDP", startedAt: start, tabs: [] });
  assert.doesNotMatch(readFileSync(join(root2, "Backstage IDP.md"), "utf8"), /tabbold:sessions/);
});

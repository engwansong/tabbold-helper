import assert from "node:assert/strict";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHandlers, dispatch } from "../src/ops.ts";
import { mergeTabs, sessionProblems } from "../src/session.ts";
import { tolaria } from "../src/vault/profile.ts";
import { Vault } from "../src/vault/vault.ts";
import { makeVault, sampleVault } from "./helpers.ts";

const cfg = (root: string) => ({ vault: root, gitCommit: false, webFolder: "web", sessionFolder: "sessions", profile: "tolaria" as const });
const start = new Date(2026, 10, 12, 9, 30).getTime();
const A = { url: "https://a.example/", title: "A" };
const B = { url: "https://b.example/", title: "B" };
const C = { url: "https://c.example/", title: "C" };
const D = { url: "https://d.example/", title: "D" };

test("mergeTabs: unchanged note → extension's list; changed note → note + new pages", () => {
  assert.deepEqual(mergeTabs(undefined, [A], [A, B]), [A, B]);
  assert.deepEqual(mergeTabs([A.url, B.url], [A, B], [A, B, C]), [A, B, C]);
  // note restored to an older version with only A, and D added by hand; extension saw C since
  assert.deepEqual(mergeTabs([A.url, B.url], [A, D], [A, B, C]), [A, D, C]);
});

test("sessionProblems: clean note has none; broken markers and dates are reported", () => {
  const ok = "## Pages\n\n<!-- tabbold:tabs -->\n- [A](<https://a.example/>)\n<!-- /tabbold:tabs -->\n";
  assert.deepEqual(sessionProblems({ type: "Session", status: "active", start_date: "2026-11-12T09:30" }, ok, "Session"), []);
  const bad = "<!-- /tabbold:tabs -->\n- not a link\n<!-- tabbold:tabs -->\n<!-- tabbold:notes -->\n";
  const p = sessionProblems({ type: "Note", status: "paused", start_date: "yesterday" }, bad, "Session");
  assert.equal(p.length, 5, p.join(" | "));
});

async function running() {
  const root = makeVault(sampleVault, false);
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  const s = await h.saveSession({ project: "Backstage IDP", startedAt: start, tabs: [A, B] });
  return { root, h, path: s.note.path, file: join(root, s.note.path), first: s };
}

test("saveSession returns the note's state; a restored older page list is merged, not overwritten", async () => {
  const { h, path, file, first } = await running();
  assert.deepEqual(first.session?.pages.map((t) => t.url), [A.url, B.url]);
  // Restore an older version of the note in Tolaria / git: only A, plus D by hand.
  const text = readFileSync(file, "utf8").replace(/<!-- tabbold:tabs -->[\s\S]*<!-- \/tabbold:tabs -->/, `<!-- tabbold:tabs -->\n- [A](<${A.url}>)\n- [D](<${D.url}>)\n<!-- /tabbold:tabs -->`);
  writeFileSync(file, text);
  const r = await h.saveSession({ path, startedAt: start, tabs: [A, B, C], tabsBase: [A.url, B.url] });
  assert.deepEqual(r.session?.pages.map((t) => t.url), [A.url, D.url, C.url]);
});

test("project changed in the note is reported back and kept", async () => {
  const { h, path, file } = await running();
  writeFileSync(file, readFileSync(file, "utf8").replace(/belongs_to: .*/, "belongs_to: '[[Tabbold]]'"));
  const [st] = await h.sessionState({ sessions: [{ path }] });
  assert.equal(st.project, "Tabbold");
  const r = await h.saveSession({ path, startedAt: start, tabs: [A, B], tabsBase: [A.url, B.url] });
  assert.equal(r.session?.project, "Tabbold");
});

test("marked done elsewhere: a plain update is skipped, an explicit end still writes", async () => {
  const { h, path, file } = await running();
  writeFileSync(file, readFileSync(file, "utf8").replace("status: active", "status: done"));
  const r = await h.saveSession({ path, startedAt: start, tabs: [A, B, C], tabsBase: [A.url, B.url] });
  assert.equal(r.skipped, "done-elsewhere");
  assert.equal(r.session?.status, "done");
  assert.ok(!readFileSync(file, "utf8").includes(C.url));
  // Resume (no tabsBase) re-opens it as before.
  const resumed = await h.saveSession({ path, startedAt: start, tabs: [A, B] });
  assert.equal(resumed.note.data.status, "active");
});

test("missing note: NOTE_MISSING, and sessionState finds where it moved", async () => {
  const { root, h, path, file } = await running();
  const moved = join(root, "sessions", "renamed by me.md");
  renameSync(file, moved);
  const res = await dispatch(h, { id: 1, op: "saveSession", args: { path, startedAt: start, tabs: [A] } } as never, () => {});
  assert.equal((res as { code?: string }).code, "NOTE_MISSING");
  const [st] = await h.sessionState({ sessions: [{ path, startedAt: start }] });
  assert.equal(st.exists, false);
  assert.equal(st.movedTo, "sessions/renamed by me.md");
  unlinkSync(moved);
  const [gone] = await h.sessionState({ sessions: [{ path, startedAt: start }] });
  assert.equal(gone.movedTo, undefined);
});

test("browser settings round-trip through the vault; junk keys and values are dropped", async () => {
  const root = makeVault(sampleVault, false);
  const h = createHandlers(new Vault(root, tolaria), cfg(root));
  assert.equal((await h.getBrowserSettings({})).exists, false);
  const w = await h.putBrowserSettings({ settings: { idleMinutes: 30, autopilot: true, "bad key": 1, nested: { x: 1 } as never } });
  assert.equal(w.changed, true);
  assert.equal((await h.putBrowserSettings({ settings: { idleMinutes: 30, autopilot: true } })).changed, false);
  const r = await h.getBrowserSettings({});
  assert.deepEqual(r.settings, { idleMinutes: 30, autopilot: true });
  assert.match(readFileSync(join(root, "config/browser-settings.md"), "utf8"), /type: Config/);
});

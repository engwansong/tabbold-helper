// Spawns the built bridge exactly as Chrome would and talks native messaging to it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Decoder, encode } from "../src/protocol.ts";
import { makeVault, sampleVault } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function startBridge(env: Record<string, string>) {
  const child = spawn(process.execPath, [BIN, "chrome-extension://test/"], {
    env: { ...process.env, XDG_CONFIG_HOME: "/nonexistent", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const decoder = new Decoder();
  const waiting = new Map<number, (m: any) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    for (const m of decoder.push(chunk) as any[]) waiting.get(m.id)?.(m);
  });
  const req = (id: number, op: string, args: unknown = {}) =>
    new Promise<any>((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(encode({ id, op, args }));
    });
  return { child, req };
}

test("built bridge answers framed requests in order", async () => {
  const vault = makeVault(sampleVault);
  const { child, req } = startBridge({ TABBOLD_VAULT: vault });
  const [ping, page, save] = await Promise.all([
    req(1, "ping"),
    req(2, "getPage", { url: "https://docs.gitlab.com/ci" }),
    req(3, "savePageNote", { url: "https://example.org/a", title: "Example A", body: "hello" }),
  ]);
  assert.equal(ping.ok, true);
  assert.equal(ping.result.notes, 5);
  assert.equal(page.result.note.path, "web/gitlab-ci-docs.md");
  assert.equal(save.ok, true);
  assert.equal(save.result.note.path, "web/example-a.md");
  child.stdin.end();
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
});

test("missing vault config is reported, not a silent crash", async () => {
  const { child, req } = startBridge({ TABBOLD_VAULT: "" });
  const r = await req(9, "ping");
  assert.equal(r.ok, false);
  assert.match(r.error, /No vault configured/);
  child.kill();
});

// ---------- Busy ≠ offline: concurrency, heartbeats, cancel ----------
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function slowModel(delayMs: number) {
  const hits: number[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push(Date.now());
      const body = JSON.parse(raw || "{}");
      const isSummary = String(body?.messages?.[0]?.content ?? "").includes("summarise") || /summar/i.test(String(body?.messages?.[0]?.content ?? ""));
      const content = isSummary ? '{"bullets":["slow summary"]}' : '{"project":"Tabbold","confidence":0.9,"reason":"slow"}';
      const t = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }, delayMs);
      res.on("close", () => clearTimeout(t));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, hits, close: () => (server.closeAllConnections(), server.close()) };
}

function bridgeWithAi(baseUrl: string) {
  const vault = makeVault(sampleVault);
  const xdg = mkdtempSync(join(tmpdir(), "tabbold-xdg-"));
  mkdirSync(join(xdg, "tabbold"));
  writeFileSync(
    join(xdg, "tabbold", "config.json"),
    JSON.stringify({ vault, gitCommit: false, ai: { provider: "openai-compatible", baseUrl, classifyModel: "m", summaryModel: "m", timeoutMs: 60000 } }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg };
  delete env.TABBOLD_VAULT;
  const child = spawn(process.execPath, [BIN], { env, stdio: ["pipe", "pipe", "pipe"] });
  const decoder = new Decoder();
  const replies = new Map<number, (m: any) => void>();
  const progress: any[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    for (const m of decoder.push(chunk) as any[]) {
      if (m.type === "progress") progress.push({ ...m, at: Date.now() });
      else replies.get(m.id)?.(m);
    }
  });
  const req = (id: number, op: string, args: unknown = {}) =>
    new Promise<any>((resolve) => {
      replies.set(id, (m) => resolve({ ...m, at: Date.now() }));
      child.stdin.write(encode({ id, op, args }));
    });
  return { child, req, progress };
}

test("a slow AI call doesn't block status checks or saves; heartbeats flow; cancel stops it", async () => {
  const model = await slowModel(8000);
  const { child, req, progress } = bridgeWithAi(model.url);
  try {
    const t0 = Date.now();
    const slow = req(1, "suggestProject", { url: "https://example.org/x", title: "X" });
    await new Promise((r) => setTimeout(r, 300));
    const ping = await req(2, "ping");
    assert.ok(ping.at - t0 < 3000, `ping answered while AI busy (${ping.at - t0} ms)`);
    assert.equal(ping.result.busy.length, 1);
    assert.equal(ping.result.busy[0].op, "suggestProject");
    const save = await req(3, "savePageNote", { url: "https://example.org/y", title: "Y", body: "while AI is busy" });
    assert.equal(save.ok, true);
    assert.ok(save.at - t0 < 4000, "save not blocked by AI");
    const slowReply = await slow;
    assert.equal(slowReply.result.project, "Tabbold");
    assert.ok(progress.filter((p) => p.id === 1).length >= 2, `heartbeats sent (${progress.length})`);
    assert.equal(progress.find((p) => p.id === 1).stage, "asking AI");

    // Cancel: the AI request is aborted and the reply comes back at once.
    const t1 = Date.now();
    const toCancel = req(10, "suggestProject", { url: "https://example.org/z", title: "Z" });
    await new Promise((r) => setTimeout(r, 300));
    const c = await req(11, "cancel", { id: 10 });
    assert.deepEqual(c.result, { cancelled: true });
    const cancelled = await toCancel;
    assert.equal(cancelled.code, "CANCELLED");
    assert.ok(cancelled.at - t1 < 2000, "cancel is immediate");
  } finally {
    child.kill();
    model.close();
  }
});

test("an AI summary doesn't hold the write lock", async () => {
  const model = await slowModel(5000);
  const { child, req } = bridgeWithAi(model.url);
  try {
    const s = await req(1, "saveSession", { startedAt: Date.now(), tabs: [{ url: "https://example.org/a", title: "A" }] });
    const t0 = Date.now();
    const ending = req(2, "saveSession", { path: s.result.note.path, startedAt: Date.now(), endedAt: Date.now(), tabs: [{ url: "https://example.org/a", title: "A" }], summarise: true });
    await new Promise((r) => setTimeout(r, 300));
    const save = await req(3, "savePageNote", { url: "https://example.org/b", title: "B", body: "meanwhile" });
    assert.equal(save.ok, true);
    assert.ok(save.at - t0 < 2500, `save ran while the summary was being written (${save.at - t0} ms)`);
    const ended = await ending;
    assert.equal(ended.result.summarised, true);
    assert.match(ended.result.note.body, /slow summary/);
  } finally {
    child.kill();
    model.close();
  }
});

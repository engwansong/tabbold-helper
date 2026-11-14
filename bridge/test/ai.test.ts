import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getApiKey } from "../src/ai/keys.ts";
import { isPrivateHost, levelFor, loadPolicy, redactUrl } from "../src/ai/policy.ts";
import { anthropic, networkError, openaiCompatible, probe, type JsonRequest, type Provider } from "../src/ai/providers.ts";
import { renderSummary } from "../src/ai/service.ts";
import { aiLimits, AI_DEFAULTS, type Config } from "../src/config.ts";
import { createHandlers, dispatch } from "../src/ops.ts";
import { readBlock, SUMMARY_END, SUMMARY_START } from "../src/session.ts";
import { tolaria } from "../src/vault/profile.ts";
import { Vault } from "../src/vault/vault.ts";
import { makeVault, sampleVault } from "./helpers.ts";

/** Fake model: records requests, replies with whatever the test queues. */
function fakeProvider(...replies: unknown[]): Provider & { calls: JsonRequest[] } {
  const calls: JsonRequest[] = [];
  return {
    name: "fake",
    calls,
    async json(req) {
      calls.push(req);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return { value: r };
    },
  };
}

const policyNote = `---
default: metadata-only
never:
  - secret.example.com
  - "*.corp-intranet.example"
metadata_only:
  - docs.gitlab.com
---
# AI policy
`;

function setup(opts: { provider?: Provider; ai?: Partial<NonNullable<Config["ai"]>>; extra?: Record<string, string>; git?: boolean } = {}) {
  const root = makeVault({ ...sampleVault, "config/browser-ai.md": policyNote, ...(opts.extra ?? {}) }, opts.git);
  const state = mkdtempSync(join(tmpdir(), "tabbold-state-"));
  const cfg: Config = {
    vault: root,
    gitCommit: !!opts.git,
    webFolder: "web",
    sessionFolder: "sessions",
    profile: "tolaria",
    stateDir: state,
    ai: {
      provider: "anthropic",
      classifyModel: "claude-haiku-5-5",
      summaryModel: "claude-sonnet-5-5",
      dailyCap: 50,
      summaryIncludesNotes: false,
      ...(opts.ai ?? {}),
    },
  };
  const vault = new Vault(root, tolaria);
  return { root, state, vault, h: createHandlers(vault, cfg, { provider: opts.provider }) };
}

// ---------- Policy ----------

test("private and local hosts are always 'never'", () => {
  for (const h of ["localhost", "app.localhost", "printer.local", "wiki.internal", "intranet", "10.1.2.3", "192.168.0.10", "172.20.0.1", "127.0.0.1", "::1", "fd00::1"]) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ["docs.gitlab.com", "8.8.8.8", "172.32.0.1"]) assert.equal(isPrivateHost(h), false, h);
});

test("policy note decides per site, most restrictive first", async () => {
  const { vault } = setup();
  await vault.refresh();
  const p = loadPolicy(vault);
  assert.equal(p.source, "config/browser-ai.md");
  assert.equal(levelFor("https://secret.example.com/x", p).level, "never");
  assert.equal(levelFor("https://a.b.corp-intranet.example/", p).level, "never");
  assert.equal(levelFor("https://docs.gitlab.com/x", p).level, "metadata-only");
  assert.equal(levelFor("https://random.example.org/", p).level, "metadata-only");
  assert.equal(levelFor("http://localhost:3000/", p).level, "never");
  assert.equal(levelFor("https://user:pw@example.org/", p).level, "never");
  assert.equal(levelFor("chrome://settings", p).level, "never");
});

test("redactUrl drops query strings and fragments", () => {
  assert.equal(redactUrl("https://ex.com/a/b?token=SECRET&email=x@y.z#frag"), "https://ex.com/a/b");
});

// ---------- Suggestions ----------

test("AI off: no call, honest reason", async () => {
  const fake = fakeProvider();
  const { h } = setup({ provider: fake, ai: { provider: "off" } });
  const s = await h.suggestProject({ url: "https://example.org/x", title: "X" });
  assert.equal(s.source, "none");
  assert.equal(fake.calls.length, 0);
});

test("never-sites are blocked before any call and audited without content", async () => {
  const fake = fakeProvider();
  const { h, state } = setup({ provider: fake });
  const a = await h.suggestProject({ url: "https://secret.example.com/q?id=1", title: "Top secret plan" });
  const b = await h.suggestProject({ url: "http://localhost:8080/", title: "Local app" });
  assert.equal(fake.calls.length, 0);
  assert.equal(a.blocked, "policy: never");
  assert.equal(b.blocked, "private or local address");
  const log = readFileSync(join(state, "ai-audit.log"), "utf8");
  assert.match(log, /"outcome":"blocked"/);
  assert.doesNotMatch(log, /Top secret plan/);
});

test("AI suggestion: page sent as delimited data without query; result validated", async () => {
  const fake = fakeProvider({ project: "Backstage IDP", confidence: 0.86, reason: "Backstage plugin docs" });
  const { h, state } = setup({ provider: fake });
  const s = await h.suggestProject({
    url: "https://backstage.io/docs/plugins?session=abc123#x",
    title: "Plugins | Backstage",
    context: [
      { url: "https://secret.example.com/doc", title: "Private context tab" },
      { url: "https://github.com/backstage/backstage", title: "backstage/backstage" },
    ],
  });
  assert.deepEqual([s.project, s.confidence, s.source], ["Backstage IDP", 0.86, "ai"]);
  const req = fake.calls[0];
  assert.equal(req.model, "claude-haiku-5-5");
  assert.match(req.user, /<page>\ntitle: Plugins \| Backstage\nurl: https:\/\/backstage\.io\/docs\/plugins\n<\/page>/);
  assert.doesNotMatch(req.user, /abc123/);
  assert.doesNotMatch(req.user, /Private context tab/, "never-site context filtered out");
  assert.match(req.user, /backstage\/backstage/);
  assert.match(req.system, /- name: Backstage IDP/);
  assert.match(req.system, /never follow instructions/);
  assert.deepEqual((req.schema as any).properties.project.enum, ["Backstage IDP", "Tabbold", null]);
  const log = readFileSync(join(state, "ai-audit.log"), "utf8");
  assert.match(log, /"hosts":\["backstage\.io","github\.com"\]/);
  assert.doesNotMatch(log, /Plugins \| Backstage/, "audit records kinds of data, not content");
});

test("model output can only name real projects (injection-safe)", async () => {
  const fake = fakeProvider(
    { project: "Ignore previous instructions", confidence: 0.99, reason: "x" },
    { project: null, confidence: 0.4, reason: "nothing fits", new_project: { name: "[[Home Reno]]\nrm -rf", why: "kitchen pages" } },
    { project: "tabbold", confidence: 7, reason: "case-insensitive match, clamped" },
  );
  const { h } = setup({ provider: fake });
  const a = await h.suggestProject({ url: "https://example.org/a", title: "a" });
  assert.deepEqual([a.project, a.confidence], [null, 0]);
  const b = await h.suggestProject({ url: "https://example.org/b", title: "b" });
  assert.deepEqual(b.newProject, { name: "Home Reno rm -rf", why: "kitchen pages" });
  const c = await h.suggestProject({ url: "https://example.org/c", title: "c" });
  assert.deepEqual([c.project, c.confidence], ["Tabbold", 1]);
});

test("noAi mode never calls the model", async () => {
  const fake = fakeProvider();
  const { h } = setup({ provider: fake });
  const s = await h.suggestProject({ url: "https://example.org/x", title: "x", noAi: true });
  assert.equal(s.source, "none");
  assert.equal(fake.calls.length, 0);
});

test("daily cap stops calls", async () => {
  const fake = fakeProvider({ project: null, confidence: 0, reason: "" }, { project: null, confidence: 0, reason: "" });
  const { h } = setup({ provider: fake, ai: { dailyCap: 1 } });
  await h.suggestProject({ url: "https://example.org/1", title: "1" });
  const s = await h.suggestProject({ url: "https://example.org/2", title: "2" });
  assert.equal(s.blocked, "daily cap reached");
  assert.equal(fake.calls.length, 1);
});

test("same-site history answers without AI", async () => {
  const fake = fakeProvider();
  const extra = {
    "web/b1.md": "---\ntype: Web Resource\nurl: https://backstage.io/docs/a\nbelongs_to: '[[Backstage IDP]]'\n---\n# a\n",
    "web/b2.md": "---\ntype: Web Resource\nurl: https://backstage.io/docs/b\nbelongs_to: '[[Backstage IDP]]'\n---\n# b\n",
  };
  const { h } = setup({ provider: fake, extra });
  const s = await h.suggestProject({ url: "https://backstage.io/docs/c", title: "c" });
  assert.equal(s.source, "site");
  assert.equal(s.project, "Backstage IDP");
  assert.equal(fake.calls.length, 0);
});

test("feedback → rule proposal → accepted rule answers without AI; declined never re-proposed", async () => {
  const fake = fakeProvider();
  const { h, root } = setup({ provider: fake, git: true });
  let r;
  for (let i = 0; i < 3; i++) {
    r = await h.feedback({ url: `https://news.example.org/p${i}`, title: `p${i}`, suggested: null, chosen: "Tabbold", source: "manual" });
  }
  assert.deepEqual(r!.proposedRule, { host: "news.example.org", project: "Tabbold" });
  const res = await h.decideRule({ host: "news.example.org", project: "Tabbold", accept: true });
  assert.equal(res.path, "config/browser-rules.md");
  assert.equal(res.committed, true);
  assert.match(readFileSync(join(root, "config/browser-rules.md"), "utf8"), /- host: news\.example\.org\n {4}project: '\[\[Tabbold\]\]'/);
  const s = await h.suggestProject({ url: "https://sub.news.example.org/x", title: "x" });
  assert.deepEqual([s.source, s.project, s.confidence], ["rule", "Tabbold", 1]);
  assert.equal(fake.calls.length, 0);

  for (let i = 0; i < 3; i++) await h.feedback({ url: `https://blog.example.net/${i}`, title: "t", suggested: null, chosen: "Backstage IDP", source: "manual" });
  await h.decideRule({ host: "blog.example.net", project: "Backstage IDP", accept: false });
  const again = await h.feedback({ url: "https://blog.example.net/9", title: "t", suggested: null, chosen: "Backstage IDP", source: "manual" });
  assert.equal(again.proposedRule, undefined);
});

test("mixed filings for a site never propose a rule", async () => {
  const { h } = setup({ provider: fakeProvider() });
  await h.feedback({ url: "https://mix.example.org/1", title: "", suggested: null, chosen: "Tabbold", source: "manual" });
  await h.feedback({ url: "https://mix.example.org/2", title: "", suggested: null, chosen: "Tabbold", source: "manual" });
  const r = await h.feedback({ url: "https://mix.example.org/3", title: "", suggested: null, chosen: "Backstage IDP", source: "manual" });
  assert.equal(r.proposedRule, undefined);
});

// ---------- Summaries ----------

const start = new Date(2026, 10, 11, 9, 0).getTime();

test("session end adds an AI summary; private pages and notes are not sent", async () => {
  const fake = fakeProvider({ bullets: ["Compared webhook payloads", "- Chose push events"], open_questions: ["Rate limits?"] });
  const { h } = setup({ provider: fake });
  const s = await h.saveSession({ project: "Backstage IDP", startedAt: start, tabs: [], notes: "" });
  const end = await h.saveSession({
    path: s.note.path,
    startedAt: start,
    endedAt: start + 3600_000,
    tabs: [
      { url: "https://docs.gitlab.com/webhooks?x=1", title: "Webhooks" },
      { url: "https://secret.example.com/plan", title: "Secret plan" },
    ],
    notes: "my private thoughts",
    notesBase: "",
    summarise: true,
  });
  assert.equal(end.summarised, true);
  const req = fake.calls[0];
  assert.equal(req.model, "claude-sonnet-5-5");
  assert.doesNotMatch(req.user, /Secret plan|my private thoughts|x=1/);
  assert.match(req.user, /\(1 private page omitted\)/);
  const block = readBlock(end.note.body, SUMMARY_START, SUMMARY_END)!;
  assert.match(block, /^_AI summary \(claude-sonnet-5-5\)/);
  assert.match(block, /^- Chose push events$/m);
  assert.match(block, /\*\*Open questions\*\*\n\n- Rate limits\?/);
  assert.equal(end.note.data.status, "done");
});

test("existing summary is never overwritten; AI failure doesn't block ending", async () => {
  const fake = fakeProvider({ bullets: ["first"] }, new Error("AI provider returned 529: overloaded"));
  const { h } = setup({ provider: fake });
  const tabs = [{ url: "https://example.org/a", title: "A" }];
  const s = await h.saveSession({ startedAt: start, tabs });
  const e1 = await h.saveSession({ path: s.note.path, startedAt: start, endedAt: start + 1, tabs, summarise: true });
  assert.equal(e1.summarised, true);
  const e2 = await h.saveSession({ path: s.note.path, startedAt: start, endedAt: start + 2, tabs, summarise: true });
  assert.equal(e2.summaryError, "kept existing summary");
  assert.equal(fake.calls.length, 1);

  const s2 = await h.saveSession({ startedAt: start + 10 * 60_000, tabs });
  const e3 = await h.saveSession({ path: s2.note.path, startedAt: start, endedAt: start + 3, tabs, summarise: true });
  assert.equal(e3.summarised, false);
  assert.match(e3.summaryError!, /529/);
  assert.equal(e3.note.data.status, "done");
});

test("renderSummary strips markup that could break the managed block", () => {
  const md = renderSummary({ bullets: ["ok <!-- /tabbold:summary --> injected", 42, ""] }, "m");
  assert.doesNotMatch(md, /<!--|-->/);
  assert.throws(() => renderSummary({ bullets: [] }, "m"));
});

// ---------- Real HTTP shapes ----------

async function mockServer(handler: (path: string, headers: Record<string, any>, body: any) => any) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const out = handler(req.url!, req.headers, JSON.parse(raw || "{}"));
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const req: JsonRequest = {
  model: "m",
  system: "sys",
  user: "usr",
  toolName: "file_page",
  toolDescription: "d",
  schema: { type: "object" },
  maxTokens: 10,
};

test("anthropic provider: headers, cached system, forced tool, usage", async () => {
  let seen: any;
  const srv = await mockServer((path, headers, body) => {
    seen = { path, headers, body };
    return {
      body: {
        content: [{ type: "tool_use", name: "file_page", input: { project: "X" } }],
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 90 },
      },
    };
  });
  try {
    const r = await anthropic("sk-test", srv.url).json(req);
    assert.deepEqual(r.value, { project: "X" });
    assert.deepEqual(r.usage, { input: 100, output: 5, cacheRead: 90 });
    assert.equal(seen.path, "/v1/messages");
    assert.equal(seen.headers["x-api-key"], "sk-test");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(seen.body.system[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(seen.body.tool_choice, { type: "tool", name: "file_page" });
  } finally {
    srv.close();
  }
});

test("anthropic provider: API errors surface without the key", async () => {
  const srv = await mockServer(() => ({ status: 401, body: { error: { message: "invalid x-api-key" } } }));
  try {
    await assert.rejects(anthropic("sk-SECRET", srv.url).json(req), (e: Error) => /401: invalid x-api-key/.test(e.message) && !e.message.includes("sk-SECRET"));
  } finally {
    srv.close();
  }
});

test("openai-compatible provider: bearer, JSON mode, fenced JSON tolerated", async () => {
  let seen: any;
  const srv = await mockServer((path, headers, body) => {
    seen = { path, headers, body };
    return { body: { choices: [{ message: { content: '```json\n{"project":"Y"}\n```' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } } };
  });
  try {
    const r = await openaiCompatible(srv.url + "/v1", "k").json(req);
    assert.deepEqual(r.value, { project: "Y" });
    assert.equal(seen.path, "/v1/chat/completions");
    assert.equal(seen.headers.authorization, "Bearer k");
    assert.deepEqual(seen.body.response_format, { type: "json_object" });
    const noKey = await openaiCompatible(srv.url + "/v1").json(req);
    assert.deepEqual(noKey.value, { project: "Y" });
    assert.equal(seen.headers.authorization, undefined);
  } finally {
    srv.close();
  }
});

// ---------- Keys ----------

test("key file must be private (chmod 600)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tabbold-keys-"));
  const saved = process.env.TABBOLD_AI_KEY;
  delete process.env.TABBOLD_AI_KEY;
  try {
    assert.equal(await getApiKey("openai-compatible", dir), undefined);
    const f = join(dir, "openai-compatible.key");
    writeFileSync(f, "sk-file\n");
    chmodSync(f, 0o644);
    await assert.rejects(getApiKey("openai-compatible", dir), /chmod 600/);
    chmodSync(f, 0o600);
    assert.equal(await getApiKey("openai-compatible", dir), "sk-file");
    process.env.TABBOLD_AI_KEY = "sk-env";
    assert.equal(await getApiKey("openai-compatible", dir), "sk-env");
  } finally {
    if (saved === undefined) delete process.env.TABBOLD_AI_KEY;
    else process.env.TABBOLD_AI_KEY = saved;
  }
});

test("ops validate AI inputs", async () => {
  const { h } = setup({ provider: fakeProvider() });
  assert.equal((await dispatch(h, { id: 1, op: "suggestProject", args: { title: "x" } })).ok, false);
  assert.equal((await dispatch(h, { id: 2, op: "decideRule", args: { host: "a.com", project: "Tabbold" } })).ok, false);
  const st = await dispatch(h, { id: 3, op: "aiStatus", args: {} });
  assert.equal(st.ok, true);
});

test("network failures explain themselves instead of 'fetch failed'", async () => {
  const mk = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code, message: "x" } });
  const u = "https://api.anthropic.com/v1/messages";
  assert.match(networkError(mk("ENOTFOUND"), u).message, /look up api\.anthropic\.com.*--proxy/);
  assert.match(networkError(mk("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), u).message, /certificate.*company certificate/);
  assert.match(networkError(mk("SELF_SIGNED_CERT_IN_CHAIN"), u).message, /system's certificates/);
  assert.match(networkError(mk("ECONNREFUSED"), "http://localhost:11434/v1/chat/completions").message, /Nothing is answering at localhost:11434.*ollama serve/);
  assert.match(networkError(mk("ECONNRESET"), u).message, /cut.*proxy or firewall/);
  assert.match(networkError(Object.assign(new Error("t"), { name: "TimeoutError" }), u).message, /Timed out/);
  // Real failure: a port nothing is listening on
  const tmp = await mockServer(() => ({ body: {} }));
  const port = new URL(tmp.url).port;
  tmp.close();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(anthropic("k", `http://127.0.0.1:${port}`).json(req), new RegExp(`Nothing is answering at 127\\.0\\.0\\.1:${port}`));
});

test("probe checks connection and key without spending tokens", async () => {
  let seen: any;
  const srv = await mockServer((path, headers) => {
    seen = { path, headers };
    return headers["x-api-key"] === "good" ? { body: { data: [] } } : { status: 401, body: { error: { message: "bad key" } } };
  });
  try {
    assert.match(await probe("anthropic", srv.url, "good"), /Connected to 127\.0\.0\.1:\d+; the API key works/);
    assert.equal(seen.path, "/v1/models?limit=1");
    await assert.rejects(probe("anthropic", srv.url, "bad"), /API key was rejected \(401\)/);
  } finally {
    srv.close();
  }
});

test("suggestMany: rules/site first, ONE AI call for the rest, policy and validation applied", async () => {
  const fake = fakeProvider({
    results: [
      { page: 1, project: "Backstage IDP", confidence: 0.9, reason: "plugins" },
      { page: 2, project: "Made Up Project", confidence: 0.99 },
      { page: 2, project: "Tabbold", confidence: 0.9 },
      { page: 99, project: "Tabbold", confidence: 1 },
    ],
  });
  const extra = {
    "config/browser-rules.md": "---\nrules:\n  - host: rules.example.org\n    project: '[[Tabbold]]'\n---\n",
  };
  const { h } = setup({ provider: fake, extra });
  const r = await h.suggestMany({
    items: [
      { url: "https://rules.example.org/a", title: "ruled" },
      { url: "https://backstage.io/docs/plugins?tok=1", title: "Plugins" },
      { url: "https://secret.example.com/x", title: "Secret" },
      { url: "https://example.net/y", title: "Something" },
      { url: "https://example.net/z", title: "Unanswered" },
    ],
  });
  assert.deepEqual(r.map((s) => [s.source, s.project]), [
    ["rule", "Tabbold"],
    ["ai", "Backstage IDP"],
    ["none", null],
    ["ai", null],
    ["none", null],
  ]);
  assert.equal(r[2].blocked, "policy: never");
  assert.equal(r[4].reason, "AI gave no answer for this page");
  assert.equal(fake.calls.length, 1, "one batched call");
  const u = fake.calls[0].user;
  assert.match(u, /^<pages>\n1\. Plugins \(https:\/\/backstage\.io\/docs\/plugins\)\n2\. Something/);
  assert.doesNotMatch(u, /Secret|ruled|tok=1/);
  const noAi = await h.suggestMany({ items: [{ url: "https://example.net/q", title: "q" }], noAi: true });
  assert.equal(noAi[0].source, "none");
  assert.equal(fake.calls.length, 1);
});

test("Re-organise: turned-down projects are skipped by rules, and the AI is told and checked", async () => {
  const fake = fakeProvider({
    results: [
      { page: 1, project: "Backstage IDP", confidence: 0.9 },
      { page: 2, project: "Backstage IDP", confidence: 0.95 }, // ignores the [not: …]: must be dropped
      { page: 3, project: null, confidence: 0.4, new_project: "Garden" },
    ],
  });
  const extra = {
    "config/browser-rules.md": "---\nrules:\n  - host: rules.example.org\n    project: '[[Tabbold]]'\n---\n",
  };
  const { h } = setup({ provider: fake, extra });
  const r = await h.suggestMany({
    items: [
      { url: "https://rules.example.org/a", title: "ruled", exclude: ["tabbold"] }, // rule turned down → asks AI
      { url: "https://example.net/b", title: "B", exclude: ["Backstage IDP"] },
      { url: "https://example.net/c", title: "C", exclude: ["garden"] },
    ],
  });
  assert.deepEqual(r.map((s) => [s.source, s.project]), [
    ["ai", "Backstage IDP"],
    ["ai", null],
    ["ai", null],
  ]);
  assert.equal(r[1].reason, "Only suggested a project you turned down");
  assert.equal(r[2].newProject, undefined, "a turned-down new-project name isn't offered again");
  const u = fake.calls[0].user;
  assert.match(u, /1\. ruled \(https:\/\/rules\.example\.org\/a\) \[not: tabbold\]/);
  assert.match(u, /2\. B .*\[not: Backstage IDP\]/);
  assert.match(fake.calls[0].system, /\[not: …\]/);
});

test("timeouts and batch sizes: sensible defaults for local vs cloud, clamped", () => {
  assert.deepEqual(aiLimits({ ...AI_DEFAULTS, provider: "anthropic" }), { timeoutMs: 30_000, batchSize: 40 });
  assert.deepEqual(aiLimits({ ...AI_DEFAULTS, provider: "openai-compatible" }), { timeoutMs: 120_000, batchSize: 8 });
  assert.deepEqual(aiLimits({ ...AI_DEFAULTS, provider: "openai-compatible", timeoutMs: 999_999, batchSize: 0 }), { timeoutMs: 180_000, batchSize: 1 });
  assert.deepEqual(aiLimits({ ...AI_DEFAULTS, provider: "anthropic", timeoutMs: 120_000, batchSize: 10 }), { timeoutMs: 120_000, batchSize: 10 });
});

test("a slow local model gets a local hint, not a proxy hint", async () => {
  const mk = Object.assign(new Error("t"), { name: "TimeoutError" });
  const local = networkError(mk, "http://localhost:11434/v1/chat/completions", 120_000).message;
  assert.match(local, /local model at localhost:11434 didn't answer within 120 s.*ai\.timeoutMs.*ai\.batchSize.*OLLAMA_KEEP_ALIVE/);
  assert.doesNotMatch(local, /proxy/);
  assert.match(networkError(mk, "https://api.anthropic.com/v1/messages").message, /proxy/);
});

test("the per-call timeout is enforced (and explained) by the provider", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    /* never answers */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    const t0 = Date.now();
    await assert.rejects(openaiCompatible(`http://127.0.0.1:${port}/v1`, undefined, 300).json(req), /didn't answer within 0 s/);
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("suggestMany uses smaller batches for local models", async () => {
  const replies = Array.from({ length: 3 }, () => ({ results: [] }));
  const fake = fakeProvider(...replies);
  const { h } = setup({ provider: fake, ai: { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1" } });
  const items = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.org/p${i}`, title: `p${i}` }));
  await h.suggestMany({ items });
  assert.equal(fake.calls.length, 2, "10 pages at batch size 8 → 2 calls");
});

test("createProject: creates a Project note once, safe name, reuses existing", async () => {
  const { h, root } = setup({ provider: fakeProvider(), git: true });
  const a = await h.createProject({ name: "  Home   Reno  " });
  assert.deepEqual([a.name, a.path, a.created, a.committed], ["Home Reno", "Home Reno.md", true, true]);
  assert.equal(readFileSync(join(root, "Home Reno.md"), "utf8"), "---\ntype: Project\nstatus: active\n---\n# Home Reno\n");
  const again = await h.createProject({ name: "home reno" });
  assert.deepEqual([again.path, again.created], ["Home Reno.md", false], "no duplicates (case-insensitive)");
  const byTitle = await h.createProject({ name: "Backstage IDP" });
  assert.equal(byTitle.created, false);
  const weird = await h.createProject({ name: "[[Evil]]/../#x?" });
  assert.equal(weird.path, "Evil..x.md");
  assert.equal((await dispatch(h, { id: 1, op: "createProject", args: { name: " [[ ]] " } })).ok, false);
});

test("suggestMany proposes new projects for tabs that fit nothing (clustered, never as fake existing)", async () => {
  const fake = fakeProvider({
    results: [
      { page: 1, project: null, confidence: 0.7, new_project: "Home Reno", reason: "kitchen" },
      { page: 2, project: null, confidence: 0.6, new_project: "[[Home Reno]]", reason: "tiles" },
      { page: 3, project: null, confidence: 0.8, new_project: "backstage idp", reason: "already exists" },
      { page: 4, project: null, confidence: 0.2 },
    ],
  });
  const { h } = setup({ provider: fake });
  const r = await h.suggestMany({
    items: ["kitchen", "tiles", "plugins", "random"].map((t) => ({ url: `https://example.org/${t}`, title: t })),
  });
  assert.deepEqual(r[0].newProject?.name, "Home Reno");
  assert.deepEqual(r[1].newProject?.name, "Home Reno", "same cluster name after cleaning");
  assert.deepEqual([r[2].project, r[2].newProject], ["Backstage IDP", undefined], "existing name → that project");
  assert.deepEqual([r[3].project, r[3].newProject], [null, undefined]);
  assert.match(fake.calls[0].system, /SAME new_project name/);
});

test("suggestSessions: rules/site majority for free, AI for the rest, policy respected", async () => {
  const fake = fakeProvider({ results: [{ session: 1, project: null, confidence: 0.7, new_project: "Home Reno" }] });
  const extra = { "config/browser-rules.md": "---\nrules:\n  - host: docs.gitlab.com\n    project: '[[Backstage IDP]]'\n---\n" };
  const { h } = setup({ provider: fake, extra });
  const mk = async (urls: string[]) =>
    (await h.saveSession({ startedAt: Date.now() + Math.random() * 1e6, tabs: urls.map((u, i) => ({ url: u, title: `t${i}` })) })).note.path;
  const ruled = await mk(["https://docs.gitlab.com/a", "https://docs.gitlab.com/b", "https://example.org/x"]);
  const reno = await mk(["https://example.org/kitchen", "https://example.org/tiles"]);
  const secret = await mk(["https://secret.example.com/a"]);
  const r = await h.suggestSessions({ paths: [ruled, reno, secret] });
  assert.deepEqual([r[0].source, r[0].project], ["rule", "Backstage IDP"]);
  assert.equal(r[1].newProject?.name, "Home Reno");
  assert.equal(r[2].blocked, "policy");
  assert.equal(fake.calls.length, 1, "one AI call for the one session that needed it");
  assert.doesNotMatch(fake.calls[0].user, /secret|docs\.gitlab/);
});

test("setSessionProject files a session (and validates)", async () => {
  const { h, root } = setup({ provider: fakeProvider() });
  const s = await h.saveSession({ startedAt: Date.now(), endedAt: Date.now() + 1, tabs: [] });
  await h.setSessionProject({ path: s.note.path, project: "Tabbold" });
  assert.match(readFileSync(join(root, s.note.path), "utf8"), /belongs_to: '\[\[Tabbold\]\]'/);
  await h.setSessionProject({ path: s.note.path, project: "" });
  assert.doesNotMatch(readFileSync(join(root, s.note.path), "utf8"), /belongs_to/);
  assert.equal((await dispatch(h, { id: 1, op: "setSessionProject", args: { path: s.note.path, project: "Nope" } })).ok, false);
  assert.equal((await dispatch(h, { id: 2, op: "setSessionProject", args: { path: "web/gitlab-ci-docs.md", project: "Tabbold" } })).ok, false);
});

// ---------- Page summaries ----------

test("setPageSummary: writes summary metadata and a Summary section; creates the note if needed", async () => {
  const { h, vault } = setup();
  const url = "https://blog.example.org/backstage-webhooks";
  const r = await h.setPageSummary({ url, title: "Backstage webhooks", summary: "How Backstage consumes GitLab webhook events\nfor the catalog.", keyPoints: ["- Push events", "Merge request payloads"], source: "on-device" });
  const n = vault.get(r.note.path)!;
  assert.equal(n.data.summary, "How Backstage consumes GitLab webhook events for the catalog.");
  assert.equal(n.data.summary_source, "on-device");
  assert.match(n.body, /## Summary\n\n<!-- tabbold:page-summary -->\nHow Backstage[\s\S]*- Push events\n- Merge request payloads[\s\S]*Summarised on this device/);
  // Again: replaces the section, keeps your own text
  await h.savePageNote({ url, title: "Backstage webhooks", body: n.body + "\nMy own thoughts.\n", baseMtime: n.mtimeMs });
  await h.setPageSummary({ url, title: "x", summary: "Updated summary.", source: "anthropic" });
  const again = vault.byUrl(url)!;
  assert.equal((again.body.match(/<!-- tabbold:page-summary -->/g) ?? []).length, 1);
  assert.match(again.body, /Updated summary\.[\s\S]*Summarised with anthropic[\s\S]*My own thoughts\./);
});

test("'your notes': a summarised page is matched to the project whose notes it resembles — no AI call", async () => {
  const fake = fakeProvider();
  const { h } = setup({ provider: fake });
  const url = "https://random.example.net/post";
  await h.setPageSummary({ url, title: "A post", summary: "Designing a webhook pipeline that routes GitLab merge request events into the developer portal", source: "on-device" });
  const s = await h.suggestProject({ url, title: "A post" });
  assert.equal(s.source, "notes");
  assert.equal(s.project, "Backstage IDP");
  assert.match(s.reason, /matches your notes in Backstage IDP/);
  assert.equal(fake.calls.length, 0);
  // Unrelated summary: no guess
  const url2 = "https://random.example.net/other";
  await h.setPageSummary({ url: url2, title: "Other", summary: "Sourdough baking schedule with rye flour and long cold fermentation", source: "on-device" });
  const s2 = await h.suggestProject({ url: url2, title: "Other", noAi: true });
  assert.equal(s2.project, null);
});

test("summaries reach the AI only where the policy allows full content; page summaries need 'full'", async () => {
  const fake = fakeProvider({ project: null, confidence: 0.2 }, { project: null, confidence: 0.2 }, { summary: "A one-line summary.", key_points: ["one", "two"] });
  const full = `---\ndefault: metadata-only\nfull:\n  - open.example.org\n---\n`;
  const { h } = setup({ provider: fake, extra: { "config/browser-ai.md": full } });
  await h.setPageSummary({ url: "https://open.example.org/a", title: "Open", summary: "Quantum gardening for beginners", source: "on-device" });
  await h.setPageSummary({ url: "https://meta.example.org/b", title: "Meta", summary: "Secret summary text here", source: "on-device" });
  await h.suggestProject({ url: "https://open.example.org/a", title: "Open" });
  await h.suggestProject({ url: "https://meta.example.org/b", title: "Meta" });
  assert.match(fake.calls[0].user, /summary: Quantum gardening/);
  assert.doesNotMatch(fake.calls[1].user, /Secret summary/);
  await assert.rejects(h.summarisePage({ url: "https://meta.example.org/b", title: "Meta", text: "x".repeat(200) }), /titles and addresses/);
  const ok = await h.summarisePage({ url: "https://open.example.org/a", title: "Open", text: "Some long page text. ".repeat(20) });
  assert.equal(ok.summary, "A one-line summary.");
  assert.deepEqual(ok.keyPoints, ["one", "two"]);
  assert.match(fake.calls[2].system, /untrusted data/);
});

test("logClosedTabs appends to a dated Closed tabs note", async () => {
  const { h, root } = setup();
  const r1 = await h.logClosedTabs({ tabs: [{ url: "https://a.example/x?q=1", title: "A [page]", group: "Backstage IDP", reason: "not viewed for 9 days" }] });
  const r2 = await h.logClosedTabs({ tabs: [{ url: "https://b.example/", title: "B", reason: "duplicate" }, { url: "chrome://newtab/", title: "New Tab", reason: "x" }] });
  assert.equal(r1.note.path, r2.note.path);
  assert.match(r1.note.path, /^sessions\/\d{4}\/\d{2}\/closed-\d{4}-\d{2}-\d{2}\.md$/);
  const text = readFileSync(join(root, r2.note.path), "utf8");
  assert.match(text, /type: Closed Tabs/);
  assert.match(text, /closed: 2/);
  assert.match(text, /- \[A page\]\(<https:\/\/a\.example\/x\?q=1>\) · not viewed for 9 days · was in “Backstage IDP”/);
  assert.match(text, /- \[B\]\(<https:\/\/b\.example\/>\) · duplicate/);
  assert.doesNotMatch(text, /newtab/);
});

test("savePageNote with keepSummary keeps the Summary section the editor hides", async () => {
  const { h, root } = setup();
  const url = "https://rain.example/barrels";
  await h.setPageSummary({ url, title: "Barrels", summary: "Fill a raised barrel.", keyPoints: ["Diverter"], source: "on-device" });
  const note = (await h.getPage({ url })).note!;
  // The editor sends only your text (no Summary section).
  const r = await h.savePageNote({ url, title: "Barrels", body: "# Barrels\n\nMy own notes.\n", path: note.path, baseMtime: note.mtimeMs, keepSummary: true });
  const text = readFileSync(join(root, r.note.path), "utf8");
  assert.match(text, /My own notes\.\n\n## Summary\n\n<!-- tabbold:page-summary -->\nFill a raised barrel\./);
  assert.equal(text.match(/<!-- tabbold:page-summary -->/g)!.length, 1);
  // A stale copy of the section in body is replaced, not duplicated.
  const n2 = (await h.getPage({ url })).note!;
  const r2 = await h.savePageNote({ url, title: "Barrels", body: n2.body + "\nMore.\n", path: n2.path, baseMtime: n2.mtimeMs, keepSummary: true });
  const t2 = readFileSync(join(root, r2.note.path), "utf8");
  assert.equal(t2.match(/<!-- tabbold:page-summary -->/g)!.length, 1);
  assert.match(t2, /More\.\n\n## Summary/);
});

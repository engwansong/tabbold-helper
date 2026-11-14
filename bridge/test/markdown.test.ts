import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify, wikilinks } from "../src/vault/markdown.ts";
import { normalizeUrl, safe, slugify } from "../src/vault/paths.ts";

test("frontmatter round-trips dates as written", () => {
  const src = "---\ntype: Session\nstart_date: 2026-11-06T09:10\n---\n# Hi\n";
  const { data, body } = parse(src);
  assert.equal(data.start_date, "2026-11-06T09:10");
  assert.equal(stringify(data, body), "---\ntype: Session\nstart_date: 2026-11-06T09:10\n---\n# Hi\n");
});

test("no frontmatter → whole file is body", () => {
  assert.deepEqual(parse("# Just text\n"), { data: {}, body: "# Just text\n" });
});

test("malformed frontmatter does not throw", () => {
  const r = parse("---\n: : bad: [\n---\nbody");
  assert.deepEqual(r.data, {});
});

test("wikilinks handles quoted, lists, aliases and unquoted YAML", () => {
  assert.deepEqual(wikilinks("[[A]]"), ["A"]);
  assert.deepEqual(wikilinks(["[[A]]", "[[B|alias]]", "[[C#heading]]"]), ["A", "B", "C"]);
  // unquoted `belongs_to: [[A]]` parses as [["A"]]
  assert.deepEqual(wikilinks(parse("---\nbelongs_to: [[A]]\n---\n").data.belongs_to), ["A"]);
  assert.deepEqual(wikilinks("plain text"), []);
  assert.deepEqual(wikilinks(undefined), []);
});

test("safe() keeps writes inside the vault", () => {
  const v = "/vault";
  assert.equal(safe(v, "web/a.md"), "/vault/web/a.md");
  assert.throws(() => safe(v, "../etc/passwd.md"));
  assert.throws(() => safe(v, "/etc/x.md"));
  assert.throws(() => safe(v, ".git/config.md"));
  assert.throws(() => safe(v, "web/a.txt"));
  assert.throws(() => safe(v, ""));
});

test("normalizeUrl strips tracking, hash, www and trailing slash", () => {
  assert.equal(
    normalizeUrl("https://www.Example.com/a/b/?utm_source=x&b=2&a=1#frag"),
    "https://example.com/a/b?a=1&b=2",
  );
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeUrl("not a url"), "not a url");
});

test("slugify", () => {
  assert.equal(slugify("GitLab Webhook Events — Docs!"), "gitlab-webhook-events-docs");
  assert.equal(slugify("   "), "untitled");
});

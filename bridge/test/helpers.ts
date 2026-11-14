import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function makeVault(files: Record<string, string>, git = false): string {
  const dir = mkdtempSync(join(tmpdir(), "tabbold-vault-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (git) {
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    g("init", "-q");
    g("config", "user.email", "test@example.com");
    g("config", "user.name", "Test");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
  }
  return dir;
}

export const sampleVault = {
  "Backstage IDP.md": `---
type: Project
status: active
---
# Backstage IDP

Internal developer portal work.
`,
  "Tabbold.md": `---
type: Project
status: active
---
# Tabbold
`,
  "gitlab-event-router.md": `---
type: Note
belongs_to: "[[Backstage IDP]]"
---
# GitLab event router

Webhook pipeline design notes.
`,
  "web/gitlab-webhook-events.md": `---
type: Web Resource
url: https://docs.gitlab.com/user/project/integrations/webhook_events/?utm_source=x
belongs_to: [[Backstage IDP]]
related_to:
  - "[[gitlab-event-router]]"
start_date: 2026-11-06T09:10
---
# GitLab webhook events

Push and merge request payloads.
`,
  "web/gitlab-ci-docs.md": `---
type: Web Resource
url: https://docs.gitlab.com/ci/
---
# GitLab CI docs
`,
  ".git-ignored/hidden.md": "should be skipped",
};

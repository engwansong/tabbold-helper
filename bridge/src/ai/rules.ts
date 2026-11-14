// Deterministic site → project rules (in the vault, so they're yours and
// portable) and the local corrections log they're learned from.
//
// Rules note: config/browser-rules.md
//   ---
//   type: Config
//   rules:
//     - host: docs.gitlab.com
//       project: "[[Backstage IDP]]"
//   ---

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { link, wikilinks } from "../vault/markdown.ts";
import type { Vault } from "../vault/vault.ts";

export const RULES_PATH = "config/browser-rules.md";
export const RULE_THRESHOLD = 3;

export interface Rule {
  host: string;
  project: string;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function loadRules(vault: Vault): Rule[] {
  const raw = vault.get(RULES_PATH)?.data.rules;
  if (!Array.isArray(raw)) return [];
  const out: Rule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const host = typeof (r as any).host === "string" ? (r as any).host.trim().toLowerCase().replace(/^www\./, "") : "";
    const project = wikilinks((r as any).project)[0] ?? (typeof (r as any).project === "string" ? (r as any).project.trim() : "");
    if (host && project) out.push({ host, project });
  }
  return out;
}

/** Most specific matching rule (longest host) wins. */
export function matchRule(rules: Rule[], url: string): Rule | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  return rules
    .filter((r) => host === r.host || host.endsWith(`.${r.host}`))
    .sort((a, b) => b.host.length - a.host.length)[0];
}

export async function addRule(vault: Vault, rule: Rule): Promise<string> {
  await vault.refresh(true);
  const existing = vault.get(RULES_PATH);
  const data = { ...(existing?.data ?? { type: "Config" }) } as Record<string, unknown>;
  const rules = loadRules(vault).filter((r) => r.host !== rule.host);
  rules.push(rule);
  rules.sort((a, b) => a.host.localeCompare(b.host));
  data.rules = rules.map((r) => ({ host: r.host, project: link(r.project) }));
  const body =
    existing?.body ??
    "# Browser rules\n\nTabbold files pages from these sites under these projects without asking AI. Edit or delete rules freely.\n";
  const note = await vault.write(RULES_PATH, data, body);
  return note.path;
}

// ---------- Corrections (local only) ----------

export interface Correction {
  at: string;
  host: string;
  title: string;
  suggested: string | null;
  chosen: string;
  source: string;
}

export class Corrections {
  constructor(readonly dir: string) {}
  private get path() {
    return join(this.dir, "corrections.jsonl");
  }
  private get declinedPath() {
    return join(this.dir, "declined-rules.json");
  }

  async add(c: Omit<Correction, "at">): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.path, JSON.stringify({ at: new Date().toISOString(), ...c, title: c.title.slice(0, 120) }) + "\n", {
      mode: 0o600,
    });
  }

  async recent(limit = 200): Promise<Correction[]> {
    try {
      const lines = (await readFile(this.path, "utf8")).trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l) as Correction;
          } catch {
            return null;
          }
        })
        .filter((c): c is Correction => !!c);
    } catch {
      return [];
    }
  }

  async declined(): Promise<string[]> {
    try {
      return JSON.parse(await readFile(this.declinedPath, "utf8"));
    } catch {
      return [];
    }
  }

  async decline(host: string, project: string): Promise<void> {
    const list = new Set(await this.declined());
    list.add(`${host}→${project}`);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.declinedPath, JSON.stringify([...list]), { mode: 0o600 });
  }

  /**
   * Propose a rule when you've filed the same site under the same project
   * RULE_THRESHOLD times recently, never under another project, and haven't
   * already said no.
   */
  async proposal(host: string, rules: Rule[]): Promise<Rule | undefined> {
    if (!host || rules.some((r) => r.host === host)) return undefined;
    const mine = (await this.recent()).filter((c) => c.host === host && c.chosen);
    const projects = new Set(mine.map((c) => c.chosen));
    if (projects.size !== 1 || mine.length < RULE_THRESHOLD) return undefined;
    const project = mine[0].chosen;
    if ((await this.declined()).includes(`${host}→${project}`)) return undefined;
    return { host, project };
  }
}

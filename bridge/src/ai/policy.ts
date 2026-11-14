// Per-site AI privacy policy, kept as a note in your vault: config/browser-ai.md
//
//   ---
//   default: metadata-only      # never | metadata-only | full
//   never:
//     - gitlab.mycompany.gov.sg
//     - "*.internal.example"
//   metadata_only: []
//   full: []
//   ---
//
// "metadata-only" sends a page's title and URL. "full" also lets you summarise
// a page's text with the helper's AI (when you ask; Chrome's on-device model
// needs no policy) and sends saved page summaries along with suggestions.
// Private and local hosts are always "never", whatever the note says.

import { isIP } from "node:net";
import type { Vault } from "../vault/vault.ts";

export type Level = "never" | "metadata-only" | "full";

export interface Policy {
  default: Level;
  never: string[];
  metadataOnly: string[];
  full: string[];
  /** Vault path the policy came from, if any. */
  source?: string;
}

export const POLICY_PATH = "config/browser-ai.md";
const LEVELS: Level[] = ["never", "metadata-only", "full"];

export function loadPolicy(vault: Vault): Policy {
  const note = vault.get(POLICY_PATH);
  const d = note?.data ?? {};
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  const def = typeof d.default === "string" && LEVELS.includes(d.default as Level) ? (d.default as Level) : "metadata-only";
  return {
    default: def,
    never: list(d.never),
    metadataOnly: list(d.metadata_only),
    full: list(d.full),
    source: note ? POLICY_PATH : undefined,
  };
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".private"];

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (!h.includes(".") && isIP(h) === 0) return true; // single-label intranet names
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return false;
}

function matches(host: string, pattern: string): boolean {
  const p = pattern.replace(/^\*\./, "").replace(/^\./, "");
  return host === p || host.endsWith(`.${p}`);
}

export function levelFor(url: string, policy: Policy): { level: Level; host: string; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { level: "never", host: "", reason: "not a URL" };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!/^https?:$/.test(u.protocol)) return { level: "never", host, reason: "not a web page" };
  if (u.username || u.password) return { level: "never", host, reason: "URL contains credentials" };
  if (isPrivateHost(host)) return { level: "never", host, reason: "private or local address" };
  if (policy.never.some((p) => matches(host, p))) return { level: "never", host, reason: "policy: never" };
  if (policy.metadataOnly.some((p) => matches(host, p))) return { level: "metadata-only", host, reason: "policy: metadata-only" };
  if (policy.full.some((p) => matches(host, p))) return { level: "full", host, reason: "policy: full" };
  return { level: policy.default, host, reason: `policy default: ${policy.default}` };
}

/**
 * What may be sent for a page. Query strings and fragments are dropped
 * (they often carry tokens, emails or search terms).
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "";
  }
}

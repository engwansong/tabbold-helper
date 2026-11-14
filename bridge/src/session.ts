// Session notes: a markdown note per working block, with Tabbold-managed
// blocks that can be regenerated without touching anything the user wrote.

import type { SessionTab } from "./api.ts";

export const TABS_START = "<!-- tabbold:tabs -->";
export const TABS_END = "<!-- /tabbold:tabs -->";
export const NOTES_START = "<!-- tabbold:notes -->";
export const NOTES_END = "<!-- /tabbold:notes -->";
/** A page note's summary (Summarise this page). */
export const PAGE_SUMMARY_START = "<!-- tabbold:page-summary -->";
export const PAGE_SUMMARY_END = "<!-- /tabbold:page-summary -->";
export const SUMMARY_START = "<!-- tabbold:summary -->";
export const SUMMARY_END = "<!-- /tabbold:summary -->";
export const PROJECT_SESSIONS_START = "<!-- tabbold:sessions -->";
export const PROJECT_SESSIONS_END = "<!-- /tabbold:sessions -->";

/** First bullet of an AI summary block, for one-line previews. */
export function gistOf(summaryBlock: string | undefined): string | undefined {
  const line = summaryBlock?.split("\n").find((l) => l.startsWith("- "));
  return line ? line.slice(2).trim().slice(0, 140) : undefined;
}

/** Local wall-clock time as Tolaria-style `YYYY-MM-DDTHH:MM`. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sessionFolder(base: string, ms: number): string {
  const d = new Date(ms);
  return `${base}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function sessionSlug(ms: number, label: string): string {
  return `${localStamp(ms).replace("T", "-").replace(":", "")}-${label}`;
}

function escapeLinkText(s: string): string {
  return s.replace(/[\[\]]/g, (c) => `\\${c}`).replace(/\s+/g, " ").trim();
}

export function renderTabs(tabs: SessionTab[], noteFor: (url: string) => string | undefined): string {
  if (tabs.length === 0) return "_No pages yet._";
  return tabs
    .map((t) => {
      const note = noteFor(t.url);
      const text = escapeLinkText(t.title || t.url) || t.url;
      return `- [${text}](<${t.url}>)${note ? ` — [[${note}]]` : ""}`;
    })
    .join("\n");
}

function block(start: string, end: string, content: string): string {
  return `${start}\n${content.trim()}\n${end}`;
}

export function newSessionBody(title: string, tabsMd: string, notes: string): string {
  return [
    `# ${title}`,
    "",
    "## Pages",
    "",
    block(TABS_START, TABS_END, tabsMd),
    "",
    "## Notes",
    "",
    block(NOTES_START, NOTES_END, notes || ""),
    "",
  ].join("\n");
}

/**
 * Replace the content of a managed block. If the user removed the markers,
 * append a fresh block rather than guessing where it went.
 */
export function replaceBlock(body: string, start: string, end: string, content: string, heading: string): string {
  const s = body.indexOf(start);
  const e = body.indexOf(end, s + start.length);
  const fresh = block(start, end, content);
  if (s !== -1 && e !== -1) return body.slice(0, s) + fresh + body.slice(e + end.length);
  const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${sep}## ${heading}\n\n${fresh}\n`;
}

export function readBlock(body: string, start: string, end: string): string | undefined {
  const s = body.indexOf(start);
  const e = body.indexOf(end, s + start.length);
  if (s === -1 || e === -1) return undefined;
  return body.slice(s + start.length, e).trim();
}

/** Parse the managed page list back into tabs (inverse of renderTabs). */
export function parseTabs(block: string | undefined): SessionTab[] {
  if (!block) return [];
  const out: SessionTab[] = [];
  for (const line of block.split("\n")) {
    const m = /^- \[((?:\\.|[^\]])*)\]\(<([^>]+)>\)/.exec(line.trim());
    if (m) out.push({ title: m[1].replace(/\\([\[\]])/g, "$1"), url: m[2] });
  }
  return out;
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Where a Session note no longer follows the format Tabbold writes. Never throws. */
export function sessionProblems(data: Record<string, unknown>, body: string, sessionType: string): string[] {
  const out: string[] = [];
  if (data.type !== sessionType) out.push(`type is “${String(data.type ?? "missing")}”, not “${sessionType}”`);
  const blocks: [string, string, string][] = [
    [TABS_START, TABS_END, "Pages"],
    [NOTES_START, NOTES_END, "Notes"],
    [SUMMARY_START, SUMMARY_END, "Summary"],
  ];
  for (const [start, end, name] of blocks) {
    const a = count(body, start);
    const b = count(body, end);
    if (a === 0 && b === 0) {
      if (name === "Pages") out.push("Pages markers are missing (Tabbold will add a new Pages section at the end)");
      continue;
    }
    if (a !== 1 || b !== 1) out.push(`${name} markers appear ${a}× / ${b}× (expected once each)`);
    else if (body.indexOf(end) < body.indexOf(start)) out.push(`${name} end marker comes before its start marker`);
  }
  const tabs = readBlock(body, TABS_START, TABS_END);
  if (tabs) {
    const lines = tabs.split("\n").filter((l) => l.trim() && !l.trim().startsWith("_"));
    const bad = lines.length - parseTabs(tabs).length;
    if (bad > 0) out.push(`${bad} line${bad === 1 ? "" : "s"} in Pages ${bad === 1 ? "isn't" : "aren't"} “- [title](<url>)” and will be dropped on the next save`);
  }
  for (const k of ["start_date", "end_date"]) {
    const v = data[k];
    if (v !== undefined && !(typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(v)) && !(v instanceof Date)) out.push(`${k} isn't a date like 2026-11-12T09:30`);
  }
  if (data.status !== undefined && data.status !== "active" && data.status !== "done") out.push(`status is “${String(data.status)}” (Tabbold uses active / done)`);
  return out;
}

/**
 * Three-way merge of a session's page list. `base` is what the extension last
 * saw in the note; `current` is the note now; `mine` is the extension's list.
 * The note wins for anything it changed (removals, order, titles); pages the
 * extension saw since `base` are added at the end.
 */
export function mergeTabs(base: string[] | undefined, current: SessionTab[], mine: SessionTab[]): SessionTab[] {
  if (!base) return mine;
  const baseSet = new Set(base);
  const cur = current.map((t) => t.url);
  const same = cur.length === base.length && cur.every((u, i) => u === base[i]);
  if (same) return mine;
  const have = new Set(cur);
  return [...current, ...mine.filter((t) => !baseSet.has(t.url) && !have.has(t.url))];
}

/** The "## Summary" section Tabbold manages in a page note (heading + marked block), or "" if none. */
const SUMMARY_SECTION = /\n*(?:## Summary\n+)?<!-- tabbold:page-summary -->[\s\S]*?<!-- \/tabbold:page-summary -->\n?/;
export function pageSummarySection(body: string): string {
  const m = SUMMARY_SECTION.exec(body);
  return m ? m[0].trim() : "";
}
/** The note text without Tabbold's Summary section (what you edit). */
export function withoutPageSummary(body: string): string {
  return body.replace(SUMMARY_SECTION, "\n").replace(/\n{3,}$/, "\n").replace(/\s+$/, "") + (body.trim() ? "\n" : "");
}

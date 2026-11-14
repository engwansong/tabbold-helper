import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { firstHeading, parse, stringify, wikilinks, type Frontmatter } from "./markdown.ts";
import { normalizeUrl, safe } from "./paths.ts";
import type { VaultProfile } from "./profile.ts";
import type { Note, NoteRef } from "../api.ts";

export type { Note, NoteRef };

interface Entry extends Note {
  size: number;
  normUrl?: string;
  host?: string;
}

export class ConflictError extends Error {
  constructor(public current: Note) {
    super("Note changed on disk since it was loaded");
  }
}

const REFRESH_MS = 1500;

export class Vault {
  private entries = new Map<string, Entry>();
  private lastScan = 0;

  constructor(
    readonly root: string,
    readonly profile: VaultProfile,
  ) {}

  private scanning: Promise<void> | null = null;

  /** Rescan the vault, re-reading only files whose mtime/size changed. Concurrent callers share one scan. */
  async refresh(force = false): Promise<void> {
    if (this.scanning) return this.scanning;
    if (!force && Date.now() - this.lastScan < REFRESH_MS) return;
    this.scanning = this.scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    for await (const abs of walk(this.root)) {
      const rel = toRel(this.root, abs);
      seen.add(rel);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      const prev = this.entries.get(rel);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
      try {
        this.entries.set(rel, this.toEntry(rel, await readFile(abs, "utf8"), st.mtimeMs, st.size));
      } catch {
        // unreadable file — skip
      }
    }
    for (const rel of this.entries.keys()) if (!seen.has(rel)) this.entries.delete(rel);
    this.lastScan = Date.now();
  }

  private toEntry(rel: string, content: string, mtimeMs: number, size: number): Entry {
    const { data, body } = parse(content);
    const f = this.profile.fields;
    const name = basename(rel, ".md");
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    // Recognise pages saved by other clippers too (Obsidian Web Clipper uses `source`).
    const url = [f.url, ...f.urlAliases].map((k) => str(data[k])).find((v) => v && /^https?:\/\//i.test(v));
    let host: string | undefined;
    if (url) {
      try {
        host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        /* not a URL */
      }
    }
    return {
      path: rel,
      name,
      title: str(data[f.title]) ?? firstHeading(body) ?? name,
      type: str(data[f.type]),
      status: str(data.status),
      url,
      normUrl: url ? normalizeUrl(url) : undefined,
      host,
      belongsTo: wikilinks(data[f.belongsTo]),
      relatedTo: wikilinks(data[f.relatedTo]),
      data,
      body,
      mtimeMs,
      size,
    };
  }

  get size(): number {
    return this.entries.size;
  }

  get(rel: string): Note | undefined {
    const e = this.entries.get(rel.split(sep).join("/"));
    return e ? toNote(e) : undefined;
  }

  /** Resolve a [[wikilink]] target by file stem, title, or path. */
  resolve(target: string): Note | undefined {
    const t = target.trim().toLowerCase();
    let byTitle: Entry | undefined;
    for (const e of this.entries.values()) {
      if (e.name.toLowerCase() === t || e.path.toLowerCase() === `${t}.md`) return toNote(e);
      if (!byTitle && e.title.toLowerCase() === t) byTitle = e;
    }
    return byTitle ? toNote(byTitle) : undefined;
  }

  byUrl(url: string): Note | undefined {
    const n = normalizeUrl(url);
    for (const e of this.entries.values()) if (e.normUrl === n) return toNote(e);
    return undefined;
  }

  byHost(url: string, limit = 10): NoteRef[] {
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return [];
    }
    return [...this.entries.values()]
      .filter((e) => e.host === host)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map(toRef);
  }

  /** Every note in the vault. */
  all(): NoteRef[] {
    return [...this.entries.values()].map(toRef);
  }

  ofType(type: string): NoteRef[] {
    const t = type.toLowerCase();
    return [...this.entries.values()]
      .filter((e) => e.type?.toLowerCase() === t)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(toRef);
  }

  /**
   * When each project was last worked on, from the vault alone: the newest of
   * its Session notes (start/end), notes filed under it (belongs_to, by edit
   * time) and the Project note itself (edit time). Keys are lower-cased link
   * targets, so look up by name or title.
   */
  activity(sessionType: string): Map<string, { ms: number; why: "session" | "note" | "project" }> {
    const out = new Map<string, { ms: number; why: "session" | "note" | "project" }>();
    const bump = (key: string, ms: number, why: "session" | "note" | "project") => {
      if (!key || !Number.isFinite(ms)) return;
      const k = key.toLowerCase();
      const cur = out.get(k);
      if (!cur || ms > cur.ms) out.set(k, { ms, why });
    };
    const stampMs = (v: unknown) => {
      const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v) : null;
      if (v instanceof Date) return v.getTime();
      return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)).getTime() : NaN;
    };
    const st = sessionType.toLowerCase();
    for (const e of this.entries.values()) {
      if (e.type?.toLowerCase() === st) {
        const ms = Math.max(stampMs(e.data.end_date) || 0, stampMs(e.data.start_date) || 0) || e.mtimeMs;
        for (const p of e.belongsTo) bump(p, ms, "session");
      } else {
        for (const p of e.belongsTo) bump(p, e.mtimeMs, "note");
      }
    }
    return out;
  }

  /**
   * For "your notes" matching: per project (lower-case link target), the text
   * of what is filed under it — note titles and their `summary:` lines.
   */
  projectTexts(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const e of this.entries.values()) {
      const summary = typeof e.data.summary === "string" ? e.data.summary : "";
      for (const p of e.belongsTo) {
        const k = p.toLowerCase();
        const list = out.get(k) ?? [];
        if (list.length < 200) list.push(`${e.title} ${summary}`);
        out.set(k, list);
      }
    }
    return out;
  }

  /** Notes whose belongs_to or related_to links to `name`. */
  linkingTo(name: string, limit = 50): NoteRef[] {
    const t = name.toLowerCase();
    const hits = [...this.entries.values()].filter((e) =>
      [...e.belongsTo, ...e.relatedTo].some((l) => l.toLowerCase() === t),
    );
    return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map(toRef);
  }

  search(q: string, limit = 20): (NoteRef & { snippet: string; score: number })[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const results: (NoteRef & { snippet: string; score: number })[] = [];
    for (const e of this.entries.values()) {
      const title = e.title.toLowerCase();
      const body = e.body.toLowerCase();
      let score = 0;
      let ok = true;
      for (const term of terms) {
        const inTitle = title.includes(term) || e.name.toLowerCase().includes(term);
        const count = countOf(body, term);
        if (!inTitle && count === 0) {
          ok = false;
          break;
        }
        score += (inTitle ? 10 : 0) + Math.min(count, 5);
      }
      if (!ok) continue;
      results.push({ ...toRef(e), score, snippet: snippet(e.body, terms[0]) });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Atomically write a note. If baseMtime is given and the file has changed
   * since, throw ConflictError so the UI can reload instead of clobbering an
   * edit made in Tolaria.
   */
  async write(rel: string, data: Frontmatter, body: string, baseMtime?: number): Promise<Note> {
    const abs = safe(this.root, rel);
    if (baseMtime !== undefined) {
      try {
        const st = await stat(abs);
        if (Math.abs(st.mtimeMs - baseMtime) > 1) {
          const content = await readFile(abs, "utf8");
          throw new ConflictError(toNote(this.toEntry(toRel(this.root, abs), content, st.mtimeMs, st.size)));
        }
      } catch (err) {
        if (err instanceof ConflictError) throw err;
        // file vanished — treat as new
      }
    }
    await mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.tabbold-${randomBytes(6).toString("hex")}.tmp`);
    const content = stringify(data, body);
    try {
      await writeFile(tmp, content, "utf8");
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    const st = await stat(abs);
    const relPath = toRel(this.root, abs);
    const entry = this.toEntry(relPath, content, st.mtimeMs, st.size);
    this.entries.set(relPath, entry);
    return toNote(entry);
  }

  /** First free vault-relative path like web/foo.md, web/foo-2.md, … */
  async freePath(folder: string, slug: string): Promise<string> {
    for (let i = 1; i < 1000; i++) {
      const rel = `${folder ? folder + "/" : ""}${slug}${i === 1 ? "" : `-${i}`}.md`;
      try {
        await stat(join(this.root, rel));
      } catch {
        return rel;
      }
    }
    throw new Error("Could not find a free file name");
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of items) {
    if (it.name.startsWith(".") || it.name === "node_modules") continue;
    const p = join(dir, it.name);
    if (it.isDirectory()) yield* walk(p);
    else if (it.isFile() && it.name.endsWith(".md")) yield p;
  }
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

const COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

function toRef(e: Entry): NoteRef {
  const c = typeof e.data.tabbold_color === "string" ? e.data.tabbold_color.trim().toLowerCase() : "";
  return { path: e.path, name: e.name, title: e.title, type: e.type, status: e.status, ...(COLORS.has(c) ? { color: c } : {}) };
}

function toNote(e: Entry): Note {
  const { size: _s, normUrl: _n, host: _h, ...note } = e;
  return note;
}

function countOf(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function snippet(body: string, term: string, radius = 60): string {
  const i = body.toLowerCase().indexOf(term);
  const text = i === -1 ? body.slice(0, radius * 2) : body.slice(Math.max(0, i - radius), i + term.length + radius);
  return text.replace(/\s+/g, " ").trim();
}

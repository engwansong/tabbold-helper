import { GROUP_COLORS, type OverviewProject, type OverviewSession } from "./api.ts";
import type { Op, PageContext, Requests, ResponseMsg, SavePageNoteInput, SaveResult, SaveSessionInput, SessionNoteState } from "./api.ts";
import { AiService, cleanProjectName, type OpContext } from "./ai/service.ts";
import { CancelledError, type Provider } from "./ai/providers.ts";
import { RULES_PATH } from "./ai/rules.ts";
import type { Config } from "./config.ts";
import { commitFile, commitFiles } from "./git.ts";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  localStamp,
  newSessionBody,
  NOTES_END,
  NOTES_START,
  gistOf,
  PROJECT_SESSIONS_END,
  PROJECT_SESSIONS_START,
  parseTabs,
  readBlock,
  renderTabs,
  replaceBlock,
  sessionFolder,
  sessionSlug,
  SUMMARY_END,
  SUMMARY_START,
  TABS_END,
  TABS_START,
  PAGE_SUMMARY_START,
  PAGE_SUMMARY_END,
  mergeTabs,
  sessionProblems,
  pageSummarySection,
  withoutPageSummary,
} from "./session.ts";
import { link, wikilinks } from "./vault/markdown.ts";
import { safe, slugify } from "./vault/paths.ts";
import { ConflictError, type Note, type NoteRef, type Vault } from "./vault/vault.ts";

export const VERSION = "0.24.2";

type Handlers = { [K in Op]: (args: Requests[K]["in"], ctx?: OpContext) => Promise<Requests[K]["out"]> };

/** Runs functions one at a time (vault writes). */
function mutex() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = last.then(fn, fn);
    last = run.catch(() => {});
    return run;
  };
}

/** Web pages only, no duplicates, at most 500. */
function cleanTabs(tabs: unknown[]): { url: string; title: string }[] {
  const seen = new Set<string>();
  return (tabs as { url?: unknown; title?: unknown }[])
    .filter((t) => {
      if (typeof t?.url !== "string" || !/^https?:\/\//i.test(t.url) || seen.has(t.url)) return false;
      seen.add(t.url);
      return true;
    })
    .map((t) => ({ url: t.url as string, title: typeof t.title === "string" ? t.title : "" }))
    .slice(0, 500);
}

/** Turned-down project names from the browser: a short list of short strings. */
function cleanExclude(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 80).slice(0, 20);
  return out.length ? out : undefined;
}

// ---------- In-flight requests (for heartbeats, "what are you doing?", Cancel) ----------
interface Inflight {
  op: string;
  started: number;
  stage: string;
  ctrl: AbortController;
}
export const HEARTBEAT_MS = 3_000;

/**
 * Requests in flight, per set of handlers. Locally there's one; on a shared
 * server each user (tenant) has their own, so ping/cancel only ever see that
 * user's work.
 */
const REGISTRY = Symbol("tabbold.inflight");
type Registry = Map<number, Inflight>;
function registryOf(handlers: Handlers): Registry {
  return (handlers as unknown as { [REGISTRY]: Registry })[REGISTRY];
}

function busyOf(reg: Registry): { id: number; op: string; stage: string; ms: number }[] {
  const now = Date.now();
  return [...reg.entries()]
    .filter(([, f]) => f.op !== "ping" && f.op !== "cancel")
    .map(([id, f]) => ({ id, op: f.op, stage: f.stage, ms: now - f.started }));
}

/** Abort everything for these handlers (the browser closed the connection). */
export function cancelAll(handlers: Handlers): void {
  for (const f of registryOf(handlers).values()) f.ctrl.abort();
}

export function createHandlers(vault: Vault, cfg: Config, opts: { provider?: Provider; vaultLabel?: string } = {}): Handlers {
  const inflight: Registry = new Map();
  const { fields, types } = vault.profile;
  const str = (v: unknown) => (typeof v === "string" ? v : v instanceof Date ? v.toISOString().slice(0, 16) : undefined);

  /** A Session note as it is on disk now (call after vault.refresh). */
  function noteState(path: string, startedAt?: number): SessionNoteState {
    const n = vault.get(path);
    if (!n) {
      // Moved or renamed? Another Session note with the same start, not open elsewhere.
      const stamp = startedAt ? localStamp(startedAt) : undefined;
      const movedTo = stamp
        ? vault
            .ofType(types.session)
            .map((r) => vault.get(r.path))
            .find((m) => m && str(m.data.start_date)?.slice(0, 16) === stamp)?.path
        : undefined;
      return { path, exists: false, pages: [], problems: [], movedTo };
    }
    return {
      path: n.path,
      exists: true,
      project: n.belongsTo[0],
      status: str(n.data.status),
      end: str(n.data.end_date),
      pages: parseTabs(readBlock(n.body, TABS_START, TABS_END)),
      notes: readBlock(n.body, NOTES_START, NOTES_END) ?? "",
      problems: sessionProblems({ ...n.data, type: n.data[fields.type] }, n.body, types.session),
    };
  }

  const SETTINGS_PATH = "config/browser-settings.md";

  /** Projects with when each was last worked on (sessions, filed notes, the Project note). */
  function projectsWithActivity() {
    const act = vault.activity(types.session);
    return vault.ofType(types.project).map((p) => {
      const candidates = [act.get(p.name.toLowerCase()), act.get(p.title.toLowerCase())];
      const own = vault.get(p.path);
      if (own) candidates.push({ ms: own.mtimeMs, why: "project" as const });
      const best = candidates.filter((c): c is NonNullable<typeof c> => !!c).sort((a, b) => b.ms - a.ms)[0];
      return { ...p, lastActiveMs: best?.ms, lastActiveWhy: best?.why };
    });
  }
  const ai = new AiService(vault, cfg, opts.provider);
  const writeLock = mutex();

  /**
   * Opt-in: keep a "Sessions" list in the Project note, between Tabbold's
   * markers, so project → session links show in Tolaria's backlinks and graph.
   * Only the managed block is rewritten; the rest of your note is untouched.
   * Best-effort: a failure here never fails the session save.
   */
  async function linkSessionsInProject(projectName: string | undefined): Promise<void> {
    if (!projectName) return;
    try {
      await vault.refresh(true);
      const p = vault.resolve(projectName);
      if (!p || p.type?.toLowerCase() !== types.project.toLowerCase()) return;
      const sessions = vault
        .linkingTo(p.name, 200)
        .filter((r) => r.type === types.session)
        .map((r) => vault.get(r.path)!)
        .filter(Boolean)
        .sort((a, b) => String(b.data.start_date ?? "").localeCompare(String(a.data.start_date ?? "")));
      const lines = sessions.slice(0, 10).map((n) => {
        const pages = parseTabs(readBlock(n.body, TABS_START, TABS_END)).length;
        const gist = gistOf(readBlock(n.body, SUMMARY_START, SUMMARY_END));
        const when = String(n.data.start_date ?? "").replace("T", " ");
        const live = n.data.status === "active" ? " · running" : "";
        return `- [[${n.name}]] · ${when} · ${pages} page${pages === 1 ? "" : "s"}${live}${gist ? ` · ${gist}` : ""}`;
      });
      if (sessions.length > 10) lines.push(`- …and ${sessions.length - 10} earlier`);
      const content = lines.length ? lines.join("\n") : "_No sessions yet._";
      if ((readBlock(p.body, PROJECT_SESSIONS_START, PROJECT_SESSIONS_END) ?? "") === content) return;
      const body = replaceBlock(p.body, PROJECT_SESSIONS_START, PROJECT_SESSIONS_END, content, "Sessions");
      const note = await vault.write(p.path, p.data, body);
      if (cfg.gitCommit) await commitFile(cfg.vault, note.path, `tabbold: sessions list for ${p.name}`);
    } catch (err) {
      console.error("tabbold: couldn't update project sessions list", err);
    }
  }

  const handlers: Handlers = {
    async ping() {
      await vault.refresh();
      // On a server, don't reveal where the vault lives on disk.
      return { version: VERSION, vault: opts.vaultLabel ?? cfg.vault, notes: vault.size, profile: vault.profile.name, busy: busyOf(inflight) };
    },

    async cancel({ id }) {
      const f = typeof id === "number" ? inflight.get(id) : undefined;
      f?.ctrl.abort();
      return { cancelled: !!f };
    },

    async getPage({ url }) {
      requireString(url, "url");
      await vault.refresh();
      const note = vault.byUrl(url) ?? null;
      const ctx: PageContext = { note, projects: [], related: [], sameSite: [] };
      const seen = new Set<string>();
      const add = (list: NoteRef[], ref: NoteRef | undefined) => {
        if (!ref || seen.has(ref.path) || ref.path === note?.path) return;
        seen.add(ref.path);
        list.push(ref);
      };
      if (note) {
        for (const p of note.belongsTo) add(ctx.projects, vault.resolve(p));
        for (const r of note.relatedTo) add(ctx.related, vault.resolve(r));
        for (const r of vault.linkingTo(note.name, 20)) add(ctx.related, r);
        for (const p of note.belongsTo) for (const r of vault.linkingTo(p, 10)) add(ctx.related, r);
      }
      for (const r of vault.byHost(url, 8)) add(ctx.sameSite, r);
      return ctx;
    },

    async projects() {
      await vault.refresh();
      return projectsWithActivity();
    },

    async search({ q, limit }) {
      requireString(q, "q");
      await vault.refresh();
      return vault.search(q, Math.min(limit ?? 20, 100));
    },

    async read({ path }) {
      requireString(path, "path");
      await vault.refresh();
      return vault.get(path) ?? null;
    },

    async savePageNote(input: SavePageNoteInput): Promise<SaveResult> {
      requireString(input.url, "url");
      requireString(input.title ?? "", "title", true);
      if (typeof input.body !== "string") throw badRequest("body must be a string");
      await vault.refresh(true);

      let path: string;
      let data: Record<string, unknown>;
      let isNew = false;
      if (input.path) {
        const existing = vault.get(input.path);
        if (!existing) throw badRequest(`No note at ${input.path}`);
        path = existing.path;
        data = { ...existing.data };
        if (!existing.url) data[fields.url] = input.url;
      } else {
        // Re-check by URL so two quick saves don't create duplicates.
        const byUrl = vault.byUrl(input.url);
        if (byUrl) {
          path = byUrl.path;
          data = { ...byUrl.data };
        } else {
          isNew = true;
          path = await vault.freePath(cfg.webFolder, slugify(input.title || hostOf(input.url)));
          data = { [fields.type]: types.webResource, [fields.url]: input.url };
        }
      }

      if (input.project !== undefined) {
        if (input.project === "") delete data[fields.belongsTo];
        else data[fields.belongsTo] = link(input.project);
      }
      if (input.related !== undefined) {
        if (input.related.length === 0) delete data[fields.relatedTo];
        else data[fields.relatedTo] = input.related.map(link);
      }

      let body = input.body;
      if (input.keepSummary) {
        const section = isNew ? "" : pageSummarySection(vault.get(path)?.body ?? "");
        body = withoutPageSummary(body);
        if (section) body = `${body.replace(/\s+$/, "")}${body.trim() ? "\n\n" : ""}${section}\n`;
      }
      if (isNew && !/^\s*#\s/.test(body)) {
        body = `# ${input.title || hostOf(input.url)}\n\n${body}`;
      }
      if (body && !body.endsWith("\n")) body += "\n";

      const note = await vault.write(path, data, body, isNew ? undefined : input.baseMtime);
      const commit = cfg.gitCommit
        ? await commitFile(cfg.vault, note.path, `tabbold: ${isNew ? "add" : "update"} ${note.title}`)
        : { committed: false, reason: "disabled" };
      return { note, committed: commit.committed, commitNote: commit.reason };
    },

    async appendPageNote(input) {
      requireString(input?.url, "url");
      requireString(input?.text, "text");
      if (!/^https?:\/\//i.test(input.url)) throw badRequest("Only web pages can have notes");
      await vault.refresh(true);
      const existing = vault.byUrl(input.url);
      const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : hostOf(input.url);
      const quote = input.text
        .replace(/\r\n?/g, "\n")
        .trim()
        .slice(0, 5000)
        .split("\n")
        .map((l) => `> ${l}`.trimEnd())
        .join("\n");
      let path: string;
      let data: Record<string, unknown>;
      let body: string;
      if (existing) {
        path = existing.path;
        data = { ...existing.data };
        body = existing.body.replace(/\s*$/, "\n");
        // Only fill the project if the note doesn't have one: never re-file your note.
        if (input.project && existing.belongsTo.length === 0) data[fields.belongsTo] = link(input.project);
      } else {
        path = await vault.freePath(cfg.webFolder, slugify(title));
        data = { [fields.type]: types.webResource, [fields.url]: input.url };
        if (input.project) data[fields.belongsTo] = link(input.project);
        body = `# ${title}\n`;
      }
      body += `\n${quote}\n`;
      const note = await vault.write(path, data, body);
      const commit = cfg.gitCommit
        ? await commitFile(cfg.vault, note.path, `tabbold: quote from ${note.title}`)
        : { committed: false, reason: "disabled" };
      return { note, committed: commit.committed, commitNote: commit.reason };
    },

    async sessions({ limit, path }) {
      await vault.refresh();
      const refs = path ? [vault.get(path)].filter((n) => n && n.type === types.session) : vault.ofType(types.session).map((r) => vault.get(r.path));
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      return refs
        .filter((n): n is NonNullable<typeof n> => !!n)
        .map((n) => ({
          path: n.path,
          name: n.name,
          title: n.title,
          project: n.belongsTo[0],
          status: str(n.data.status),
          start: str(n.data.start_date),
          end: str(n.data.end_date),
          pages: parseTabs(readBlock(n.body, TABS_START, TABS_END)),
          notes: readBlock(n.body, NOTES_START, NOTES_END) ?? "",
          mtimeMs: n.mtimeMs,
        }))
        .sort((a, b) => (b.start ?? "").localeCompare(a.start ?? "") || b.mtimeMs - a.mtimeMs)
        .slice(0, Math.min(limit ?? 20, 500));
    },

    async overview({ perProject } = {}) {
      await vault.refresh();
      const per = Math.min(Math.max(perProject ?? 5, 1), 50);
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const all: (OverviewSession & { project: string; mtimeMs: number })[] = vault
        .ofType(types.session)
        .map((r) => vault.get(r.path)!)
        .filter(Boolean)
        .map((n) => ({
          path: n.path,
          name: n.name,
          status: str(n.data.status),
          start: str(n.data.start_date),
          end: str(n.data.end_date),
          pages: parseTabs(readBlock(n.body, TABS_START, TABS_END)).slice(0, 50),
          gist: gistOf(readBlock(n.body, SUMMARY_START, SUMMARY_END)),
          project: n.belongsTo[0] ? (vault.resolve(n.belongsTo[0])?.name ?? n.belongsTo[0]) : "",
          mtimeMs: n.mtimeMs,
        }))
        .sort((a, b) => (b.start ?? "").localeCompare(a.start ?? "") || b.mtimeMs - a.mtimeMs);
      const byProject = new Map<string, typeof all>();
      for (const sess of all) byProject.set(sess.project, [...(byProject.get(sess.project) ?? []), sess]);
      const strip = ({ project: _p, mtimeMs: _m, ...rest }: (typeof all)[number]): OverviewSession => rest;
      const out: OverviewProject[] = projectsWithActivity().map((p) => {
        const list = byProject.get(p.name) ?? [];
        byProject.delete(p.name);
        return {
          name: p.name,
          title: p.title,
          path: p.path,
          status: p.status,
          color: p.color,
          sessions: list.slice(0, per).map(strip),
          sessionCount: list.length,
          lastActive: list[0]?.end ?? list[0]?.start,
          lastActiveMs: p.lastActiveMs,
          lastActiveWhy: p.lastActiveWhy,
        };
      });
      // Sessions whose project isn't a Project note (or none): one "Unsorted" group.
      const rest = [...byProject.values()].flat().sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
      if (rest.length) {
        out.push({ name: "", title: "Unsorted", sessions: rest.slice(0, per).map(strip), sessionCount: rest.length, lastActive: rest[0]?.end ?? rest[0]?.start });
      }
      return out;
    },

    async createProject({ name }) {
      const clean = cleanProjectName(name);
      if (!clean) throw badRequest("A project needs a name");
      return writeLock(async () => {
        await vault.refresh(true);
        // Never create a duplicate: an existing project (by name or title) is reused.
        const existing = vault.ofType(types.project).find((p) => p.name.toLowerCase() === clean.toLowerCase() || p.title.toLowerCase() === clean.toLowerCase());
        if (existing) return { name: existing.name, path: existing.path, created: false };
        const path = await vault.freePath(cfg.projectFolder ?? "", clean);
        const note = await vault.write(path, { [fields.type]: types.project, status: "active" }, `# ${clean}\n`);
        const commit = cfg.gitCommit ? await commitFile(cfg.vault, note.path, `tabbold: new project ${clean}`) : { committed: false };
        return { name: note.name, path: note.path, created: true, committed: commit.committed };
      });
    },

    async deleteProject({ name, withSessions }) {
      requireString(name, "name");
      return writeLock(async () => {
        await vault.refresh(true);
        const key = name.replace(/^\[\[|\]\]$/g, "").trim().toLowerCase();
        const proj = vault.ofType(types.project).find((p) => p.name.toLowerCase() === key || p.title.toLowerCase() === key);
        if (!proj) throw badRequest(`No project called ${name}`);
        const pname = proj.name.toLowerCase();
        const linked = (n: Note) => n.belongsTo.some((b) => b.toLowerCase() === pname || b.toLowerCase() === proj.title.toLowerCase());
        const all = vault.all().map((r) => vault.get(r.path)!).filter(Boolean);
        const sessions = all.filter((n) => n.type === types.session && linked(n));
        const toMove = [proj.path, ...(withSessions === true ? sessions.map((n) => n.path) : [])];
        const toUnlink = all.filter((n) => !toMove.includes(n.path) && linked(n));
        const id = `${localStamp(Date.now()).replace(/[^0-9]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
        const trash = join(cfg.vault, ".tabbold", "trash", id);
        await mkdir(join(trash, "files"), { recursive: true });
        await writeFile(join(cfg.vault, ".tabbold", ".gitignore"), "*\n").catch(() => {});
        const manifest = { id, project: proj.title || proj.name, at: new Date().toISOString(), moved: [] as string[], unlinked: [] as { path: string; before: string }[] };
        // Keep what you keep tidy: drop this project from their belongs_to (the old text is saved for Undo).
        for (const n of toUnlink) {
          const before = await readFile(join(cfg.vault, n.path), "utf8");
          const list = ([] as unknown[]).concat(n.data[fields.belongsTo] ?? []).filter((v) => {
            const s = String(v).replace(/^\[\[|\]\]$/g, "").trim().toLowerCase();
            return s !== pname && s !== proj.title.toLowerCase();
          });
          const data = { ...n.data };
          if (list.length) data[fields.belongsTo] = list;
          else delete data[fields.belongsTo];
          await vault.write(n.path, data, n.body);
          manifest.unlinked.push({ path: n.path, before });
        }
        for (const rel of toMove) {
          const dest = join(trash, "files", rel);
          await mkdir(dirname(dest), { recursive: true });
          await rename(join(cfg.vault, rel), dest);
          manifest.moved.push(rel);
        }
        await writeFile(join(trash, "manifest.json"), JSON.stringify(manifest, null, 2));
        await vault.refresh(true);
        const commit = cfg.gitCommit
          ? await commitFiles(cfg.vault, [...manifest.moved, ...manifest.unlinked.map((u) => u.path)], `tabbold: delete project ${manifest.project}`)
          : { committed: false };
        return { id, project: manifest.project, moved: manifest.moved, unlinked: manifest.unlinked.map((u) => u.path), committed: commit.committed };
      });
    },

    async deletedProjects() {
      const dir = join(cfg.vault, ".tabbold", "trash");
      const ids = await readdir(dir).catch(() => [] as string[]);
      const out: { id: string; project: string; at: string; moved: number; unlinked: number }[] = [];
      for (const id of ids) {
        try {
          const m = JSON.parse(await readFile(join(dir, id, "manifest.json"), "utf8"));
          out.push({ id, project: String(m.project), at: String(m.at), moved: m.moved?.length ?? 0, unlinked: m.unlinked?.length ?? 0 });
        } catch {
          // not one of ours
        }
      }
      return out.sort((a, b) => b.at.localeCompare(a.at));
    },

    async restoreProject({ id }) {
      requireString(id, "id");
      if (!/^[0-9]{8,14}-[a-z0-9]{4}$/.test(id)) throw badRequest("Unknown deletion");
      return writeLock(async () => {
        const dir = join(cfg.vault, ".tabbold", "trash", id);
        const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8").catch(() => {
          throw badRequest("That deletion isn't in the trash any more");
        })) as { project: string; moved: string[]; unlinked: { path: string; before: string }[] };
        const restored: string[] = [];
        for (const rel of m.moved) {
          const abs = safe(cfg.vault, rel);
          if (existsSync(abs)) throw badRequest(`${rel} exists again: move it aside first, then restore`);
          await mkdir(dirname(abs), { recursive: true });
          await rename(join(dir, "files", rel), abs);
          restored.push(rel);
        }
        for (const u of m.unlinked) {
          const abs = safe(cfg.vault, u.path);
          if (existsSync(abs)) {
            await writeFile(abs, u.before);
            restored.push(u.path);
          }
        }
        await rm(dir, { recursive: true, force: true });
        await vault.refresh(true);
        const commit = cfg.gitCommit ? await commitFiles(cfg.vault, restored, `tabbold: restore project ${m.project}`) : { committed: false };
        return { project: m.project, restored: restored.length, committed: commit.committed };
      });
    },

    async suggestSessions({ paths, noAi, exclude }, ctx) {
      if (!Array.isArray(paths)) throw badRequest("paths must be an array");
      await vault.refresh();
      const notes = paths
        .filter((p): p is string => typeof p === "string")
        .slice(0, 50)
        .map((p) => vault.get(p))
        .filter((n): n is NonNullable<typeof n> => !!n && n.type === types.session);
      const res = await ai.suggestSessions(
        notes.map((n) => ({ pages: parseTabs(readBlock(n.body, TABS_START, TABS_END)), exclude: cleanExclude(exclude?.[n.path]) })),
        ctx,
        noAi === true,
      );
      return res.map((r, i) => ({ ...r, path: notes[i].path }));
    },

    async setSessionProject({ path, project }) {
      requireString(path, "path");
      if (typeof project !== "string") throw badRequest("project must be a string");
      return writeLock(async () => {
        await vault.refresh(true);
        const n = vault.get(path);
        if (!n || n.type !== types.session) throw badRequest(`No session note at ${path}`);
        const data = { ...n.data };
        if (project === "") delete data[fields.belongsTo];
        else {
          const p = vault.resolve(project);
          if (!p || p.type?.toLowerCase() !== types.project.toLowerCase()) throw badRequest(`No Project note named ${project}`);
          data[fields.belongsTo] = link(p.name);
        }
        const note = await vault.write(n.path, data, n.body);
        const commit = cfg.gitCommit
          ? await commitFile(cfg.vault, note.path, `tabbold: file session under ${project || "(none)"}`)
          : { committed: false };
        return { path: note.path, committed: commit.committed };
      });
    },

    async setProjectColor({ project, color }) {
      requireString(project, "project");
      if (!(GROUP_COLORS as readonly string[]).includes(color)) throw badRequest(`color must be one of ${GROUP_COLORS.join(", ")}`);
      return writeLock(async () => {
        await vault.refresh(true);
        const p = vault.resolve(project);
        if (!p || p.type?.toLowerCase() !== types.project.toLowerCase()) throw badRequest(`No Project note named ${project}`);
        const note = await vault.write(p.path, { ...p.data, tabbold_color: color }, p.body);
        const commit = cfg.gitCommit ? await commitFile(cfg.vault, note.path, `tabbold: colour ${p.name} ${color}`) : { committed: false };
        return { path: note.path, committed: commit.committed };
      });
    },

    async saveSession(input: SaveSessionInput, ctx: OpContext = {}): Promise<SaveResult> {
      if (typeof input.startedAt !== "number") throw badRequest("startedAt is required");
      if (!Array.isArray(input.tabs)) throw badRequest("tabs must be an array");
      if (input.notes !== undefined && typeof input.notes !== "string") throw badRequest("notes must be a string");
      const tabs = cleanTabs(input.tabs);

      // AI summary first, OUTSIDE the write lock, so a slow model never holds up
      // other saves. Only if the note has none yet (never overwrite yours).
      let summarised: boolean | undefined;
      let summaryError: string | undefined;
      let summary: string | undefined;
      if (input.endedAt && input.summarise && ai.enabled) {
        await vault.refresh(true);
        const snap = input.path ? vault.get(input.path) : undefined;
        if (snap && readBlock(snap.body, SUMMARY_START, SUMMARY_END)) {
          summaryError = "kept existing summary";
        } else {
          try {
            const notes = input.notes ?? (snap ? (readBlock(snap.body, NOTES_START, NOTES_END) ?? "") : "");
            summary = await ai.summarise({ project: input.project || snap?.belongsTo[0], pages: tabs, notes }, ctx);
          } catch (err) {
            summarised = false;
            summaryError = err instanceof CancelledError ? "cancelled" : (err as Error).message; // the session still ends
          }
        }
      }

      return writeLock(async () => {
        await vault.refresh(true);
        // Link visited pages to their Web Resource notes where they exist.
        const noteFor = (url: string) => vault.byUrl(url)?.name;
        const tabsMd = renderTabs(tabs, noteFor);
        const pageLinks = tabs.map((t) => noteFor(t.url)).filter((n): n is string => !!n);

        let path: string;
        let data: Record<string, unknown>;
        let body: string;
        const existing = input.path ? vault.get(input.path) : undefined;
        if (input.path && !existing) {
          throw Object.assign(new Error(`The Session note ${input.path} was moved or deleted`), { code: "NOTE_MISSING" });
        }
        // Marked done elsewhere (Tolaria, git) while this session was running: don't
        // reopen it with a plain update. The extension ends the session instead.
        if (existing && input.tabsBase && !input.endedAt && existing.data.status === "done") {
          return { note: existing, committed: false, commitNote: "done elsewhere", skipped: "done-elsewhere" as const, session: noteState(existing.path) };
        }

        if (existing) {
          path = existing.path;
          data = { ...existing.data };
          // Merge, don't overwrite, if the note's page list changed since the extension last saw it.
          const merged = mergeTabs(input.tabsBase, parseTabs(readBlock(existing.body, TABS_START, TABS_END)), tabs);
          body = replaceBlock(existing.body, TABS_START, TABS_END, merged === tabs ? tabsMd : renderTabs(merged, noteFor), "Pages");
          if (input.notes !== undefined) {
            // User-written text: refuse to overwrite edits made elsewhere.
            // Compare content, not mtime, because tab-only updates also touch the file.
            const current = readBlock(existing.body, NOTES_START, NOTES_END) ?? "";
            if (input.notesBase !== undefined && current !== input.notesBase.trim()) {
              throw new ConflictError(existing);
            }
            body = replaceBlock(body, NOTES_START, NOTES_END, input.notes, "Notes");
          }
          // Tab-only updates touch just Tabbold-managed parts and are merged into
          // the freshly read file, so they never need a conflict check.
        } else {
          const label = input.project ? slugify(input.project, 50) : "session";
          path = await vault.freePath(sessionFolder(cfg.sessionFolder, input.startedAt), sessionSlug(input.startedAt, label));
          const title = `Session: ${input.project ?? "Unsorted"} — ${localStamp(input.startedAt).replace("T", " ")}`;
          data = {};
          body = newSessionBody(title, tabsMd, input.notes ?? "");
        }

        data[fields.type] = types.session;
        if (input.project !== undefined) {
          if (input.project === "") delete data[fields.belongsTo];
          else data[fields.belongsTo] = link(input.project);
        }
        const wasDone = existing?.data.status === "done";
        data.status = input.endedAt ? "done" : "active";
        // Keep the original start when resuming an existing session.
        if (!existing || !data.start_date) data.start_date = localStamp(input.startedAt);
        if (input.endedAt) data.end_date = localStamp(input.endedAt);
        else delete data.end_date; // active again (resumed)
        // Union with links the user added themselves.
        const has = [...new Set([...wikilinks(data.has), ...pageLinks])];
        if (has.length) data.has = has.map(link);

        if (summary) {
          if (readBlock(body, SUMMARY_START, SUMMARY_END)) {
            summaryError = "kept existing summary"; // added while the AI was writing
          } else {
            body = replaceBlock(body, SUMMARY_START, SUMMARY_END, summary, "Summary");
            summarised = true;
          }
        }

        // Keep Tabbold's fields in a readable order; anything else follows as it was.
        const order = [fields.type, fields.belongsTo, "status", "start_date", "end_date", "has"];
        const ordered: Record<string, unknown> = {};
        for (const k of order) if (k in data) ordered[k] = data[k];
        for (const k of Object.keys(data)) if (!(k in ordered)) ordered[k] = data[k];

        const note = await vault.write(path, ordered, body);
        const verb = !existing ? "start" : input.endedAt ? "end" : wasDone ? "resume" : "update";
        if (input.linkInProject && verb !== "update") await linkSessionsInProject(note.belongsTo[0]);
        const commit = cfg.gitCommit
          ? await commitFile(cfg.vault, note.path, `tabbold: ${verb} session ${input.project || note.belongsTo[0] || "unsorted"}`)
          : { committed: false, reason: "disabled" };
        return { note, committed: commit.committed, commitNote: commit.reason, summarised, summaryError, session: noteState(note.path) };
      });
    },

    async summarisePage(input, ctx) {
      requireString(input?.url, "url");
      if (typeof input.text !== "string" || input.text.trim().length < 40) throw badRequest("Not enough page text to summarise");
      await vault.refresh(); // pick up AI policy edits
      return ai.summarisePage({ url: input.url, title: String(input.title ?? ""), text: input.text }, ctx);
    },

    async logClosedTabs(input) {
      if (!Array.isArray(input?.tabs) || input.tabs.length === 0) throw badRequest("tabs must be a non-empty array");
      const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
      const tabs = input.tabs
        .filter((t) => typeof t?.url === "string" && /^https?:\/\//i.test(t.url))
        .slice(0, 500)
        .map((t) => ({ url: t.url.replace(/[<>\s]/g, encodeURIComponent), title: clean(t.title, 200).replace(/[[\]]/g, "") || hostOf(t.url), group: clean(t.group, 80), reason: clean(t.reason, 120) }));
      if (tabs.length === 0) throw badRequest("No web pages to record");
      return writeLock(async () => {
        await vault.refresh(true);
        const now = new Date();
        const stamp = localStamp(now.getTime());
        const day = stamp.slice(0, 10);
        const path = `${cfg.sessionFolder}/${day.slice(0, 4)}/${day.slice(5, 7)}/closed-${day}.md`;
        const existing = vault.get(path);
        const data: Record<string, unknown> = existing ? { ...existing.data } : { [fields.type]: "Closed Tabs", date: day };
        data.closed = (typeof data.closed === "number" ? data.closed : 0) + tabs.length;
        const lines = tabs.map((t) => `- [${t.title}](<${t.url}>)` + [t.reason, t.group ? `was in “${t.group}”` : ""].filter(Boolean).map((x) => ` · ${x}`).join(""));
        const head = existing?.body ?? `# Closed tabs — ${day}\n\nTabs you closed with Tabbold. Open a link to bring a page back.\n`;
        const body = `${head.replace(/\s*$/, "")}\n\n## ${stamp.slice(11, 16)}\n\n${lines.join("\n")}\n`;
        const note = await vault.write(path, data, body);
        const commit = cfg.gitCommit ? await commitFile(cfg.vault, note.path, `tabbold: closed ${tabs.length} tab${tabs.length === 1 ? "" : "s"}`) : { committed: false, reason: "disabled" };
        return { note, committed: commit.committed, commitNote: commit.reason };
      });
    },

    async setPageSummary(input) {
      requireString(input?.url, "url");
      requireString(input?.summary, "summary");
      if (!/^https?:\/\//i.test(input.url)) throw badRequest("Only web pages can have notes");
      const summary = input.summary.replace(/[\r\n\t]+/g, " ").trim().slice(0, 600);
      const points = (Array.isArray(input.keyPoints) ? input.keyPoints : [])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.replace(/[\r\n\t]+/g, " ").replace(/^[-*•]\s*/, "").trim().slice(0, 300))
        .slice(0, 8);
      const source = String(input.source ?? "").replace(/[\r\n]+/g, " ").slice(0, 60) || "unknown";
      return writeLock(async () => {
        await vault.refresh(true);
        const existing = vault.byUrl(input.url);
        const title = String(input.title ?? "").trim() || hostOf(input.url);
        const path = existing?.path ?? (await vault.freePath(cfg.webFolder, slugify(title)));
        const data: Record<string, unknown> = existing ? { ...existing.data } : { [fields.type]: types.webResource, [fields.url]: input.url };
        data.summary = summary;
        data.summary_source = source;
        data.summarised_at = localStamp(Date.now());
        const md = [summary, ...(points.length ? ["", ...points.map((p) => `- ${p}`)] : []), "", `_${source === "on-device" ? "Summarised on this device" : `Summarised with ${source}`} · ${localStamp(Date.now()).replace("T", " ")}_`].join("\n");
        const base = existing?.body ?? `# ${title}\n\n`;
        const body = replaceBlock(base, PAGE_SUMMARY_START, PAGE_SUMMARY_END, md, "Summary");
        const note = await vault.write(path, data, body);
        const commit = cfg.gitCommit ? await commitFile(cfg.vault, note.path, `tabbold: summary of ${note.title}`) : { committed: false, reason: "disabled" };
        return { note, committed: commit.committed, commitNote: commit.reason };
      });
    },

    async notesForUrls(input) {
      if (!Array.isArray(input?.urls)) throw badRequest("urls must be an array");
      await vault.refresh();
      return input.urls
        .filter((u): u is string => typeof u === "string")
        .slice(0, 300)
        .map((url) => {
          const n = vault.byUrl(url);
          const target = n?.belongsTo[0];
          return { url, path: n?.path, project: target ? (vault.resolve(target)?.name ?? target) : undefined };
        });
    },

    async sessionState(input) {
      if (!Array.isArray(input?.sessions)) throw badRequest("sessions must be an array");
      await vault.refresh(true); // a sync: always read what's on disk now
      return input.sessions
        .filter((x) => typeof x?.path === "string" && x.path)
        .slice(0, 50)
        .map((x) => noteState(x.path, typeof x.startedAt === "number" ? x.startedAt : undefined));
    },

    async getBrowserSettings() {
      await vault.refresh(true);
      const n = vault.get(SETTINGS_PATH);
      if (!n) return { exists: false, problems: [] };
      const raw = n.data.settings;
      const problems: string[] = [];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) problems.push("No “settings:” map in the frontmatter");
      return { exists: true, settings: problems.length ? undefined : (raw as Record<string, unknown>), problems, mtimeMs: n.mtimeMs };
    },

    async putBrowserSettings(input) {
      const settings = input?.settings;
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw badRequest("settings must be an object");
      // Only plain values: never anything secret, never nested structures.
      const clean: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(settings)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) continue;
        if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 200)) clean[k] = v;
      }
      return writeLock(async () => {
        await vault.refresh(true);
        const existing = vault.get(SETTINGS_PATH);
        const before = JSON.stringify(existing?.data.settings ?? null);
        if (before === JSON.stringify(clean)) return { path: SETTINGS_PATH, committed: false, changed: false };
        const data = { ...(existing?.data ?? { [fields.type]: "Config" }), settings: clean };
        const body =
          existing?.body ??
          "# Tabbold browser settings\n\nThe Tabbold extension's settings, kept here so a copy of your vault restores them (Settings → Sync from vault). Edit freely; API keys are never stored here.\n";
        const note = await vault.write(SETTINGS_PATH, data, body);
        const commit = cfg.gitCommit ? await commitFile(cfg.vault, note.path, "tabbold: browser settings") : { committed: false };
        return { path: note.path, committed: commit.committed, changed: true };
      });
    },

    async aiStatus() {
      return ai.status();
    },

    async aiTest(_args, ctx) {
      return ai.test(ctx);
    },

    async suggestProject(input, ctx) {
      requireString(input?.url, "url");
      if (typeof input.title !== "string") throw badRequest("title must be a string");
      if (input.context !== undefined && !Array.isArray(input.context)) throw badRequest("context must be an array");
      return ai.suggest(
        { url: input.url, title: input.title, noAi: input.noAi === true, context: input.context?.filter((t) => typeof t?.url === "string" && typeof t?.title === "string") },
        ctx,
      );
    },

    async suggestMany(input, ctx) {
      if (!Array.isArray(input?.items)) throw badRequest("items must be an array");
      const items = input.items
        .filter((t) => typeof t?.url === "string" && typeof t?.title === "string")
        .slice(0, 200)
        .map((t) => ({ url: t.url, title: t.title, exclude: cleanExclude(t.exclude) }));
      return ai.suggestMany(items, input.noAi === true, ctx);
    },

    async feedback(input) {
      requireString(input?.url, "url");
      if (typeof input.chosen !== "string") throw badRequest("chosen must be a string");
      await vault.refresh();
      const proposedRule = await ai.feedback({
        url: input.url,
        title: typeof input.title === "string" ? input.title : "",
        suggested: typeof input.suggested === "string" ? input.suggested : null,
        chosen: input.chosen,
        source: typeof input.source === "string" ? input.source : "manual",
      });
      return { proposedRule };
    },

    async decideRule(input) {
      requireString(input?.host, "host");
      requireString(input?.project, "project");
      if (typeof input.accept !== "boolean") throw badRequest("accept must be true or false");
      await vault.refresh();
      const path = await ai.decideRule({ host: input.host, project: input.project }, input.accept);
      if (!path) return {};
      const commit = cfg.gitCommit
        ? await commitFile(cfg.vault, RULES_PATH, `tabbold: rule ${input.host} → ${input.project}`)
        : { committed: false };
      return { path, committed: commit.committed };
    },
  };

  // Vault writes run one at a time; reads and AI calls run alongside them.
  for (const k of ["savePageNote", "appendPageNote", "decideRule", "feedback"] as const) {
    const f = handlers[k] as (a: unknown, c?: OpContext) => Promise<unknown>;
    (handlers as Record<string, unknown>)[k] = (a: unknown, c?: OpContext) => writeLock(() => f(a, c));
  }
  Object.defineProperty(handlers, REGISTRY, { value: inflight, enumerable: false });
  return handlers;
}

export async function dispatch(handlers: Handlers, msg: unknown, send?: (m: unknown) => void, signal?: AbortSignal): Promise<ResponseMsg> {
  const m = msg as { id?: unknown; op?: unknown; args?: unknown };
  const id = typeof m?.id === "number" ? m.id : -1;
  if (typeof m?.op !== "string" || !(m.op in handlers)) {
    return { id, ok: false, error: `Unknown op: ${String(m?.op)}`, code: "BAD_REQUEST" };
  }
  const op = m.op;
  const entry: Inflight = { op, started: Date.now(), stage: "", ctrl: new AbortController() };
  const inflight = registryOf(handlers);
  if (id >= 0) inflight.set(id, entry);
  // The caller went away (HTTP client disconnected): stop the work too.
  if (signal) {
    if (signal.aborted) entry.ctrl.abort();
    else signal.addEventListener("abort", () => entry.ctrl.abort(), { once: true });
  }
  // Heartbeat: "still working on it", so the browser can tell busy from stuck.
  const beat = send
    ? setInterval(() => send({ type: "progress", id, op, stage: entry.stage, elapsedMs: Date.now() - entry.started }), HEARTBEAT_MS)
    : undefined;
  try {
    const fn = handlers[op as Op] as (a: unknown, c: OpContext) => Promise<unknown>;
    const result = await fn(m.args ?? {}, {
      signal: entry.ctrl.signal,
      progress: (stage) => {
        entry.stage = stage;
      },
    });
    return { id, ok: true, result } as ResponseMsg;
  } catch (err) {
    if (err instanceof CancelledError) return { id, ok: false, error: "Cancelled", code: "CANCELLED" };
    if (err instanceof ConflictError) {
      return { id, ok: false, error: err.message, code: "CONFLICT", current: err.current };
    }
    const e = err as Error & { badRequest?: boolean };
    const code = e.badRequest ? "BAD_REQUEST" : (e as { code?: string }).code === "NOTE_MISSING" ? "NOTE_MISSING" : "INTERNAL";
    return { id, ok: false, error: e.message || String(err), code };
  } finally {
    clearInterval(beat);
    if (id >= 0 && inflight.get(id) === entry) inflight.delete(id);
  }
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { badRequest: true });
}

function requireString(v: unknown, name: string, allowEmpty = false): asserts v is string {
  if (typeof v !== "string" || (!allowEmpty && v.trim() === "")) throw badRequest(`${name} is required`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "page";
  }
}

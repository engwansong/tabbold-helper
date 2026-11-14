// Wire protocol shared by the bridge and the extension (types only).

// Keep this file free of Node imports: the extension type-checks against it.

export interface NoteRef {
  path: string; // vault-relative, forward slashes
  name: string; // file stem — what [[wikilinks]] point at
  title: string;
  type?: string;
  status?: string;
  /** Chrome tab-group colour set in the note's frontmatter (`tabbold_color`), if any. */
  color?: string;
}

export interface Note extends NoteRef {
  url?: string;
  belongsTo: string[];
  relatedTo: string[];
  data: Record<string, unknown>;
  body: string;
  mtimeMs: number;
}

export interface PageContext {
  /** The Web Resource note for this URL, if one exists. */
  note: Note | null;
  /** Projects the note belongs to (resolved from belongs_to). */
  projects: NoteRef[];
  /** related_to targets, notes linking to this one, and recent notes in the same project. */
  related: NoteRef[];
  /** Other notes about pages on the same site — a hint when there's no note yet. */
  sameSite: NoteRef[];
}

export interface SavePageNoteInput {
  url: string;
  title: string;
  body: string;
  /** Existing note path; omit to create a new Web Resource note. */
  path?: string;
  /** mtime of the note when loaded, for conflict detection. */
  baseMtime?: number;
  /** Project note name (file stem). "" clears belongs_to; undefined leaves it. */
  project?: string;
  /** Note names for related_to. undefined leaves it unchanged. */
  related?: string[];
  /**
   * The editor shows your text without Tabbold's Summary section; true = keep
   * the note's current Summary section (re-attached at the end) instead of
   * reading it from body.
   */
  keepSummary?: boolean;
}

export interface SaveResult {
  note: Note;
  committed: boolean;
  commitNote?: string;
  /** Session end only: whether an AI summary was added, or why not. */
  summarised?: boolean;
  summaryError?: string;
  /** Session saves: the note as written (or, if not written, as it is). */
  session?: SessionNoteState;
  /** Session saves: the update was not written because the note is marked done elsewhere. */
  skipped?: "done-elsewhere";
}

export interface Rule {
  host: string;
  project: string;
}

export interface SuggestInput {
  url: string;
  title: string;
  context?: SessionTab[];
  /** Only use rules and site history (free, local); never call the model. */
  noAi?: boolean;
}

export interface Suggestion {
  project: string | null;
  confidence: number;
  reason: string;
  source: "rule" | "site" | "notes" | "similar" | "ai" | "none";
  newProject?: { name: string; why: string };
  blocked?: string;
  proposedRule?: Rule;
}

export interface AiStatus {
  enabled: boolean;
  provider: string;
  classifyModel: string;
  summaryModel: string;
  callsToday: number;
  dailyCap: number;
  policy: string;
  keyPresent: boolean;
  error?: string;
  /** e.g. "proxy, system certificates" */
  network?: string;
}

export interface SessionTab {
  url: string;
  title: string;
}

export interface SaveSessionInput {
  /** Existing session note; omit to create one. */
  path?: string;
  /** Project note name. Written on create or when explicitly changed. */
  project?: string;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; set when the session ends. */
  endedAt?: number;
  /** Pages visited in the session, in first-seen order. */
  tabs: SessionTab[];
  /** Scratch notes from the panel. undefined = leave the notes block as is. */
  notes?: string;
  /**
   * The notes block as the panel last loaded it. If the file's block differs
   * (edited in Tolaria meanwhile) the save is refused with CONFLICT.
   */
  notesBase?: string;
  /** On end: add an AI summary if AI is on and the note has none yet. */
  summarise?: boolean;
  /** Opt-in: keep a "Sessions" list (managed block) in the Project note up to date. */
  linkInProject?: boolean;
  /**
   * The page URLs as the note had them after the extension's last save or sync.
   * If the note's list has changed since (edited in Tolaria, restored from git),
   * the helper merges instead of overwriting: the note's list, plus pages the
   * extension saw since then. Also: if the note was marked done elsewhere, a
   * plain update is not written (the result says so, and the session ends).
   */
  tabsBase?: string[];
}

/** A Session note as it is on disk now, for running sessions to follow. */
export interface SessionNoteState {
  path: string;
  exists: boolean;
  project?: string;
  status?: string;
  end?: string;
  pages: SessionTab[];
  notes?: string;
  /** Where the note does not follow the Session note format. */
  problems: string[];
  /** The note is gone, but another Session note with the same start looks like it (moved/renamed). */
  movedTo?: string;
}

export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;

export interface OverviewSession {
  path: string;
  name: string;
  status?: string;
  start?: string;
  end?: string;
  pages: SessionTab[];
  /** First line of the AI summary, if there is one. */
  gist?: string;
}

export interface OverviewProject {
  /** "" = sessions with no project. */
  name: string;
  title: string;
  path?: string;
  status?: string;
  color?: string;
  sessions: OverviewSession[];
  sessionCount: number;
  lastActive?: string;
  /** Last activity from the vault (epoch ms): newest session, filed note, or Project-note edit. */
  lastActiveMs?: number;
  lastActiveWhy?: "session" | "note" | "project";
}

/** A project in pickers, with when it was last worked on (see OverviewProject). */
export type ProjectRef = NoteRef & { lastActiveMs?: number; lastActiveWhy?: "session" | "note" | "project" };

export interface SessionSummary {
  path: string;
  name: string;
  title: string;
  project?: string;
  status?: string;
  /** As written in the note, e.g. 2026-11-06T09:10 (local time). */
  start?: string;
  end?: string;
  pages: SessionTab[];
  notes: string;
  mtimeMs: number;
}

export interface Requests {
  ping: {
    in: Record<string, never>;
    out: { version: string; vault: string; notes: number; profile: string; busy?: BusyOp[] };
  };
  /** Stop an in-flight request (AI calls are aborted). */
  cancel: { in: { id: number }; out: { cancelled: boolean } };
  getPage: { in: { url: string }; out: PageContext };
  projects: { in: Record<string, never>; out: ProjectRef[] };
  search: { in: { q: string; limit?: number }; out: (NoteRef & { snippet: string; score: number })[] };
  read: { in: { path: string }; out: Note | null };
  savePageNote: { in: SavePageNoteInput; out: SaveResult };
  saveSession: { in: SaveSessionInput; out: SaveResult };
  /** Fallback page summary by the helper's AI (Chrome's on-device Summarizer is tried first). Policy must be "full". */
  summarisePage: { in: { url: string; title: string; text: string }; out: { summary: string; keyPoints: string[]; provider: string } };
  /** Store a page summary in its note: `summary:` in the frontmatter and a Summary section. Creates the note if needed. */
  /**
   * Record tabs Tabbold is about to close (you asked) in a dated "Closed tabs"
   * note, so nothing is lost: sessions/YYYY/MM/closed-YYYY-MM-DD.md.
   */
  logClosedTabs: {
    in: { tabs: { url: string; title: string; group?: string; reason: string }[] };
    out: SaveResult;
  };
  setPageSummary: {
    in: { url: string; title: string; summary: string; keyPoints?: string[]; source: string };
    out: SaveResult;
  };
  /** For each URL: the project its page note is filed under (resolved to the Project note's name), if any. */
  notesForUrls: { in: { urls: string[] }; out: { url: string; project?: string; path?: string }[] };
  /** Running sessions: how their notes look on disk now. `startedAt` helps find moved notes. */
  sessionState: { in: { sessions: { path: string; startedAt?: number }[] }; out: SessionNoteState[] };
  /** Browser settings kept in the vault (config/browser-settings.md), if any. */
  getBrowserSettings: { in: Record<string, never>; out: { exists: boolean; settings?: Record<string, unknown>; problems: string[]; mtimeMs?: number } };
  putBrowserSettings: { in: { settings: Record<string, unknown> }; out: { path: string; committed: boolean; changed: boolean } };
  /** Recent Session notes, newest first; or one session when `path` is given. */
  sessions: { in: { limit?: number; path?: string }; out: SessionSummary[] };
  /** Projects with their recent sessions, for the Projects view. */
  overview: { in: { perProject?: number }; out: OverviewProject[] };
  /** Create a Project note (or return the existing one with that name). */
  /**
   * Delete a project (you asked, and confirmed). Its Project note — and, if you
   * choose, its session notes — move to the vault's trash (.tabbold/trash/<id>/),
   * never erased; notes you keep lose their link to it. Undo with restoreProject.
   */
  deleteProject: {
    in: { name: string; withSessions: boolean };
    out: { id: string; project: string; moved: string[]; unlinked: string[]; committed: boolean };
  };
  /** Projects in the vault's trash, newest first. */
  deletedProjects: { in: Record<string, never>; out: { id: string; project: string; at: string; moved: number; unlinked: number }[] };
  /** Put a deleted project back exactly as it was (files and links). */
  restoreProject: { in: { id: string }; out: { project: string; restored: number; committed: boolean } };
  createProject: { in: { name: string }; out: { name: string; path: string; created: boolean; committed?: boolean } };
  /** Suggest projects for sessions that have none, from their pages. */
  /** `exclude`: per path, projects the user turned down for that session ("Re-organise"). */
  suggestSessions: { in: { paths: string[]; noAi?: boolean; exclude?: Record<string, string[]> }; out: (Suggestion & { path: string })[] };
  /** File a (finished) session under a project; "" clears it. */
  setSessionProject: { in: { path: string; project: string }; out: { path: string; committed: boolean } };
  /** Set a project's tab-group colour (writes `tabbold_color` in its note). */
  setProjectColor: { in: { project: string; color: string }; out: { path: string; committed: boolean } };
  aiStatus: { in: Record<string, never>; out: AiStatus };
  aiTest: { in: Record<string, never>; out: { ok: boolean; detail: string } };
  /** Quick capture: append a quote to the page's note, creating it if needed. */
  appendPageNote: {
    in: { url: string; title: string; text: string; project?: string };
    out: SaveResult;
  };
  suggestProject: { in: SuggestInput; out: Suggestion };
  /** Classify many tabs at once; AI (if allowed) is asked once per 40 pages. */
  /** `exclude`: projects (or new-project names) the user turned down for that page ("Re-organise"). */
  suggestMany: { in: { items: { url: string; title: string; exclude?: string[] }[]; noAi?: boolean }; out: Suggestion[] };
  /** Record which project you filed a page under; may return a rule proposal. */
  feedback: {
    in: { url: string; title: string; suggested: string | null; chosen: string; source: string };
    out: { proposedRule?: Rule };
  };
  decideRule: { in: Rule & { accept: boolean }; out: { path?: string; committed?: boolean } };
}

export type Op = keyof Requests;

/** A request the helper is still working on. */
export interface BusyOp {
  id: number;
  op: string;
  stage: string;
  ms: number;
}

/** Sent by the helper every few seconds while a request is still running. */
export interface ProgressMsg {
  type: "progress";
  id: number;
  op: string;
  stage: string;
  elapsedMs: number;
}

export interface RequestMsg<K extends Op = Op> {
  id: number;
  op: K;
  args: Requests[K]["in"];
}

export type ResponseMsg<K extends Op = Op> =
  | { id: number; ok: true; result: Requests[K]["out"] }
  | { id: number; ok: false; error: string; code?: "CONFLICT" | "BAD_REQUEST" | "INTERNAL" | "CANCELLED" | "NOTE_MISSING"; current?: Note };

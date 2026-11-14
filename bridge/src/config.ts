import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type AiProvider = "off" | "anthropic" | "openai-compatible";

export interface AiConfig {
  /** "off" (default) disables every AI feature; nothing is sent anywhere. */
  provider: AiProvider;
  /** Model for per-tab project suggestions (fast, cheap). */
  classifyModel: string;
  /** Model for session summaries. */
  summaryModel: string;
  /** API base URL. Anthropic default https://api.anthropic.com; for Ollama e.g. http://localhost:11434/v1 */
  baseUrl?: string;
  /** Max AI calls per local day. */
  dailyCap: number;
  /** Include your own session notes in summary prompts (default false: titles + URLs only). */
  summaryIncludesNotes: boolean;
  /**
   * Max time for one AI call, in ms (5 000–180 000). Default 30 s for cloud
   * providers, 120 s for openai-compatible (local models load slowly).
   */
  timeoutMs?: number;
  /** Pages per AI call when organising tabs. Default 40 for Anthropic, 8 for openai-compatible. */
  batchSize?: number;
}

/** Effective timeout / batch size for this config, with sane bounds. */
export function aiLimits(ai: AiConfig): { timeoutMs: number; batchSize: number } {
  const local = ai.provider === "openai-compatible";
  const clamp = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
  return {
    timeoutMs: clamp(ai.timeoutMs, 5_000, 180_000, local ? 120_000 : 30_000),
    batchSize: clamp(ai.batchSize, 1, 40, local ? 8 : 40),
  };
}

export const AI_DEFAULTS: AiConfig = {
  provider: "off",
  classifyModel: "claude-haiku-5-5",
  summaryModel: "claude-sonnet-5-5",
  dailyCap: 200,
  summaryIncludesNotes: false,
};

export interface Config {
  /** Absolute path to the markdown vault (e.g. your Tolaria vault). */
  vault: string;
  /** Commit each write to git when the vault is a git repo. Default true. */
  gitCommit: boolean;
  /** Folder (relative to vault) for new Web Resource notes. */
  webFolder: string;
  /** Folder (relative to vault) for Session notes; YYYY/MM subfolders are added. */
  sessionFolder: string;
  /** Folder (relative to vault) for Project notes Tabbold creates. Default: vault root. */
  projectFolder?: string;
  /** Vault conventions profile. Only "tolaria" for now. */
  profile: "tolaria";
  /** AI settings. Absent = AI off. */
  ai?: AiConfig;
  /** Local-only folder for the audit log, usage counter and corrections (never in the vault). */
  stateDir?: string;
}

export function stateDirFor(cfg: Config): string {
  return cfg.stateDir ?? dirname(configPath());
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "tabbold", "config.json");
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  let fileCfg: Partial<Config> & { ai?: Partial<AiConfig> } = {};
  try {
    fileCfg = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    // no config file yet — env or overrides must supply the vault
  }
  const vault = overrides.vault ?? process.env.TABBOLD_VAULT ?? fileCfg.vault;
  if (!vault) {
    throw new Error(
      `No vault configured. Set TABBOLD_VAULT or create ${configPath()} with {"vault": "/path/to/vault"}`,
    );
  }
  return {
    vault: resolve(vault.replace(/^~(?=$|\/)/, homedir())),
    gitCommit: overrides.gitCommit ?? fileCfg.gitCommit ?? true,
    webFolder: overrides.webFolder ?? fileCfg.webFolder ?? "web",
    sessionFolder: overrides.sessionFolder ?? fileCfg.sessionFolder ?? "sessions",
    projectFolder: overrides.projectFolder ?? fileCfg.projectFolder ?? "",
    profile: "tolaria",
    ai: { ...AI_DEFAULTS, ...(fileCfg.ai ?? {}), ...(overrides.ai ?? {}) },
    stateDir: overrides.stateDir ?? fileCfg.stateDir,
  };
}

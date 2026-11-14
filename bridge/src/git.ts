import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CommitResult {
  committed: boolean;
  reason?: string;
}

/**
 * Commit a single file. Never throws: a failed commit must not fail the save,
 * since the note is already safely on disk.
 */
export async function commitFile(vault: string, rel: string, message: string): Promise<CommitResult> {
  if (!existsSync(join(vault, ".git"))) return { committed: false, reason: "not a git repo" };
  try {
    await run("git", ["-C", vault, "add", "--", rel]);
    await run("git", ["-C", vault, "commit", "--quiet", "-m", message, "--only", "--", rel]);
    return { committed: true };
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr || (err as Error).message || err);
    if (/nothing to commit|no changes added/i.test(msg)) return { committed: false, reason: "no changes" };
    return { committed: false, reason: msg.trim().split("\n")[0] };
  }
}

/** Commit several files at once, including deletions. Never throws. */
export async function commitFiles(vault: string, rels: string[], message: string): Promise<CommitResult> {
  if (!rels.length) return { committed: false, reason: "no changes" };
  if (!existsSync(join(vault, ".git"))) return { committed: false, reason: "not a git repo" };
  try {
    await run("git", ["-C", vault, "add", "-A", "--", ...rels]);
    await run("git", ["-C", vault, "commit", "--quiet", "-m", message, "--only", "--", ...rels]);
    return { committed: true };
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr || (err as Error).message || err);
    if (/nothing to commit|no changes added/i.test(msg)) return { committed: false, reason: "no changes" };
    return { committed: false, reason: msg.trim().split("\n")[0] };
  }
}

// API keys are never stored in the extension or the vault. Lookup order:
//   1. TABBOLD_AI_KEY env var (CI / tests; Chrome-launched helpers don't see your shell env)
//   2. macOS Keychain:  security add-generic-password -s tabbold -a <provider> -w
//   3. Linux Secret Service: secret-tool store --label=tabbold service tabbold account <provider>
//   4. <config dir>/<provider>.key, only if readable by you alone (chmod 600)
// scripts/set-ai-key.sh stores a key the right way for your OS.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function getApiKey(provider: string, configDir: string): Promise<string | undefined> {
  const env = process.env.TABBOLD_AI_KEY?.trim();
  if (env) return env;

  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", "tabbold", "-a", provider, "-w"], { timeout: 5000 });
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* not in keychain */
    }
  } else if (process.platform === "linux") {
    try {
      const { stdout } = await run("secret-tool", ["lookup", "service", "tabbold", "account", provider], { timeout: 5000 });
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* no secret-tool or no entry */
    }
  }

  const file = join(configDir, `${provider}.key`);
  try {
    const st = await stat(file);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new Error(`${file} is readable by other users; run: chmod 600 "${file}"`);
    }
    const key = (await readFile(file, "utf8")).trim();
    return key || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

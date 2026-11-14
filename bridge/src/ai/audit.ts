// Local audit log + daily usage cap. Lives in the helper's state folder,
// never in the vault. The log records *what kind* of data left the machine
// (hosts, field names, counts) but not the content itself.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AuditEntry {
  op: "suggestProject" | "summariseSession" | "summarisePage";
  provider: string;
  model: string;
  hosts: string[];
  fields: string[];
  outcome: "ok" | "error" | "blocked";
  detail?: string;
  usage?: { input?: number; output?: number; cacheRead?: number };
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class Audit {
  constructor(readonly dir: string) {}

  get logPath(): string {
    return join(this.dir, "ai-audit.log");
  }
  private get usagePath(): string {
    return join(this.dir, "ai-usage.json");
  }

  async log(entry: AuditEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  }

  async usage(): Promise<{ date: string; calls: number }> {
    try {
      const u = JSON.parse(await readFile(this.usagePath, "utf8"));
      if (u.date === today() && typeof u.calls === "number") return u;
    } catch {
      /* none yet */
    }
    return { date: today(), calls: 0 };
  }

  /** Reserve one call against today's cap. Returns false if the cap is reached. */
  async tryConsume(cap: number): Promise<boolean> {
    const u = await this.usage();
    if (u.calls >= cap) return false;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.usagePath, JSON.stringify({ date: u.date, calls: u.calls + 1 }), { mode: 0o600 });
    return true;
  }
}

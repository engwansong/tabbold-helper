import { isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve a vault-relative path and refuse anything that escapes the vault. */
export function safe(vault: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("Path required");
  if (isAbsolute(rel)) throw new Error("Absolute paths are not allowed");
  const abs = resolve(vault, rel);
  const r = relative(vault, abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) {
    throw new Error(`Path escapes vault: ${rel}`);
  }
  if (!abs.endsWith(".md")) throw new Error("Only .md files can be written");
  if (r.split(sep).some((part) => part.startsWith("."))) {
    throw new Error("Hidden paths are not allowed");
  }
  return abs;
}

export function slugify(input: string, max = 80): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "untitled";
}

const TRACKING = /^(utm_|fbclid$|gclid$|mc_eid$|mc_cid$|ref_src$|igshid$)/i;

/** Normalise a URL so the same page matches regardless of tracking noise. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of params) u.searchParams.append(k, v);
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    let s = u.toString();
    if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
    return s;
  } catch {
    return raw.trim();
  }
}

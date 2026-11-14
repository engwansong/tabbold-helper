import yaml from "js-yaml";

export type Frontmatter = Record<string, unknown>;

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split a markdown file into frontmatter + body.
 * Uses the YAML core schema so dates stay as the strings the user wrote
 * (Tolaria's `start_date: 2026-11-06T09:10` must round-trip unchanged).
 */
export function parse(content: string): { data: Frontmatter; body: string } {
  const m = FM_RE.exec(content);
  if (!m) return { data: {}, body: content };
  let data: Frontmatter = {};
  try {
    const loaded = yaml.load(m[1], { schema: yaml.CORE_SCHEMA });
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      data = loaded as Frontmatter;
    }
  } catch {
    // Malformed frontmatter: treat as plain body rather than failing.
    return { data: {}, body: content };
  }
  return { data, body: content.slice(m[0].length) };
}

export function stringify(data: Frontmatter, body: string): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (keys.length === 0) return body;
  const clean: Frontmatter = {};
  for (const k of keys) clean[k] = data[k];
  const fm = yaml.dump(clean, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true });
  return `---\n${fm}---\n${body}`;
}

/**
 * Extract wikilink targets from a frontmatter value.
 * Handles quoted strings ("[[X]]"), lists of them, and the common YAML
 * gotcha where an unquoted [[X]] parses as a nested array [["X"]].
 */
export function wikilinks(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (typeof v === "string") {
      const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
      let m: RegExpExecArray | null;
      let found = false;
      while ((m = re.exec(v))) {
        out.push(m[1].trim());
        found = true;
      }
      // A bare string inside a nested array came from unquoted [[X]].
      if (!found && depth >= 2 && v.trim()) out.push(v.trim());
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return [...new Set(out)];
}

export function link(name: string): string {
  return `[[${name}]]`;
}

export function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return m?.[1];
}

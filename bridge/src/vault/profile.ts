// Per-app vault conventions. Tolaria is the first target; others (Obsidian,
// Logseq) can be added as further profiles without touching the core.

export interface VaultProfile {
  name: string;
  fields: {
    type: string;
    url: string;
    belongsTo: string;
    relatedTo: string;
    title: string;
    /** Extra fields that may hold a page URL, e.g. Obsidian Web Clipper's `source`. */
    urlAliases: string[];
  };
  types: {
    project: string;
    webResource: string;
    session: string;
  };
}

export const tolaria: VaultProfile = {
  name: "tolaria",
  fields: {
    type: "type",
    url: "url",
    belongsTo: "belongs_to",
    relatedTo: "related_to",
    title: "title",
    urlAliases: ["source"],
  },
  types: {
    project: "Project",
    webResource: "Web Resource",
    session: "Session",
  },
};

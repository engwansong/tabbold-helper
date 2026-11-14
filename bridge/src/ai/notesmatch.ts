// "Your notes": suggest a project for a page from its summary, by comparing it
// with what you've already filed under each project (titles and summaries of
// notes that belong to it, and the Project note itself). Local and free:
// nothing leaves the computer.
//
// Score = share of the page's (weighted) words that also appear in a project's
// notes. Words that appear in many projects count for less (a simple IDF), so
// "guide" or "team" don't decide anything.

const STOP = new Set(
  (
    "about above after again also among another any are around because been before being below between both but can could did does doing down during each even every few for from further had has have having here how into its itself just like made make many more most much must not now off once only other our out over own same she should since some such than that the their them then there these they this those through too under until very was way were what when where which while who whom why will with within without would you your yours page pages article post blog read using use used new get one two three also may might will can https http www com org net html"
  ).split(" "),
);

export function words(text: string): Set<string> {
  return new Set(
    String(text)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)),
  );
}

export interface NotesMatch {
  project: string;
  score: number;
  matched: string[];
}

/**
 * Best project for `text` among `bags` (project → words of its notes).
 * Needs at least 3 shared words, a score ≥ 0.3 and a clear lead (0.1) over the
 * runner-up; otherwise no guess.
 */
export function matchNotes(text: string, bags: Map<string, Set<string>>, min = 0.3): NotesMatch | null {
  const mine = words(text);
  if (mine.size < 3 || bags.size === 0) return null;
  const df = new Map<string, number>();
  for (const bag of bags.values()) for (const w of mine) if (bag.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(1 + bags.size / (1 + (df.get(w) ?? 0)));
  const total = [...mine].reduce((a, w) => a + idf(w), 0);
  const ranked = [...bags.entries()]
    .map(([project, bag]) => {
      const matched = [...mine].filter((w) => bag.has(w));
      return { project, matched, score: matched.reduce((a, w) => a + idf(w), 0) / total };
    })
    .filter((r) => r.matched.length >= 3)
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top || top.score < min) return null;
  if (ranked[1] && top.score - ranked[1].score < 0.1) return null;
  return { project: top.project, score: Math.min(1, top.score), matched: top.matched.slice(0, 6) };
}

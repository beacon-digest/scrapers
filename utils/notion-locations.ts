import type { Client } from "@notionhq/client";
import type { Interface } from "node:readline/promises";
import { readLine } from "./interactive.js";

/**
 * Resolves an Instagram-extracted location string to an existing Notion
 * "Location" select option whenever a reasonable one exists, instead of
 * letting Notion silently create a near-duplicate option (e.g. "Carter's
 * Restaurant and Events" next to the already-curated "Carter's (424 Main
 * Street)" — the same venue, spelled differently, and in that particular
 * case tripped up by a straight vs. curly apostrophe). When nothing matches
 * confidently, this asks interactively instead of creating a new option.
 */

const STOPWORDS = new Set([
  "the", "and", "of", "at", "in", "for", "beacon", "ny", "new", "york",
  "restaurant", "bar", "cafe", "arcade", "house", "club", "llc", "inc",
  "brewing", "brewery", "co",
]);

function normalizeQuotes(s: string): string {
  return s.replace(/[‘’ʼ′]/g, "'").replace(/[“”]/g, '"');
}

/** Lowercased, quote-normalized, with a trailing " (address)" or ", City, ST" dropped. */
function coreName(s: string): string {
  return normalizeQuotes(s)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/,.*$/, "")
    .trim();
}

function significantWords(s: string): Set<string> {
  return new Set(
    coreName(s)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

function wordOverlap(a: string, b: string): number {
  const wordsA = significantWords(a);
  let n = 0;
  for (const w of significantWords(b)) if (wordsA.has(w)) n++;
  return n;
}

let cachedOptions: string[] | null = null;

async function fetchLocationOptions(notion: Client, databaseId: string): Promise<string[]> {
  if (cachedOptions) return cachedOptions;
  let options: string[] = [];
  try {
    const db = await notion.databases.retrieve({ database_id: databaseId });
    const prop = (db as any).properties?.Location;
    options = prop?.type === "select" ? prop.select.options.map((o: { name: string }) => o.name) : [];
  } catch (err) {
    console.warn(
      `[notion-locations] Could not retrieve Location options (${(err as Error).message}); skipping location matching.`,
    );
  }
  cachedOptions = options;
  return options;
}

const resolvedCache = new Map<string, string>();

/**
 * Resolves `rawLocation` to an existing Location option when possible.
 * - Exact match (ignoring case, curly/straight quotes, and a trailing
 *   "(address)"/", City, ST") is used silently.
 * - A confident prefix/substring match is used silently — this is the same
 *   heuristic the rest of the pipeline already relied on, just normalized.
 * - Anything less certain is confirmed interactively: the closest existing
 *   options are offered as choices, alongside creating a new one, so a new
 *   Location option only ever gets created with an explicit yes. The answer
 *   is cached so the same raw string is never asked about twice in one run.
 */
export async function resolveLocation(
  rawLocation: string,
  notion: Client,
  databaseId: string,
  rl: Interface,
): Promise<string> {
  const cached = resolvedCache.get(rawLocation);
  if (cached) return cached;

  const options = await fetchLocationOptions(notion, databaseId);
  const remember = (result: string) => {
    resolvedCache.set(rawLocation, result);
    return result;
  };

  if (options.length === 0) return remember(rawLocation);

  const rawCore = coreName(rawLocation);

  const exact = options.find((o) => coreName(o) === rawCore);
  if (exact) return remember(exact);

  const prefixMatch = options.find((o) => rawCore.includes(coreName(o)) || coreName(o).includes(rawCore));
  if (prefixMatch) return remember(prefixMatch);

  const ranked = options
    .map((name) => ({ name, score: wordOverlap(rawLocation, name) }))
    .filter((o) => o.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((o) => o.name);

  console.log(`\n📍 No confident match in Notion for location "${rawLocation}".`);
  ranked.forEach((name, i) => console.log(`  ${i + 1}. ${name}`));
  const createChoice = ranked.length + 1;
  const typeChoice = ranked.length + 2;
  console.log(`  ${createChoice}. ✨ Create new location: "${rawLocation}"`);
  console.log(`  ${typeChoice}. ⌨️  Type a different name`);

  let picked: number | null = null;
  while (picked === null) {
    const answer = await readLine(rl, `Enter a number (1-${typeChoice}):`);
    if (answer === null) {
      throw new Error(`Input closed while choosing a Notion location for "${rawLocation}".`);
    }
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= typeChoice) {
      picked = n;
    } else {
      console.log(`  Please enter a number from 1 to ${typeChoice}.`);
    }
  }

  if (picked === createChoice) return remember(rawLocation);
  if (picked === typeChoice) {
    const typed = await readLine(rl, "Location name:");
    if (typed === null) {
      throw new Error(`Input closed while entering a Notion location for "${rawLocation}".`);
    }
    const final = typed || rawLocation;
    const typedMatch = options.find((o) => coreName(o) === coreName(final));
    return remember(typedMatch ?? final);
  }
  return remember(ranked[picked - 1]);
}

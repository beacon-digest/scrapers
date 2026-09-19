import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import rrulePkg from "rrule";
import { toDate } from "date-fns-tz";

const { RRule } = rrulePkg;

/**
 * Reads the same repeating-events.json that scrapers/repeating-events.ts turns
 * into Notion pages on its own schedule (weekly trivia, monthly karaoke, etc.).
 * An Instagram post from one of those venues often just re-announces that
 * same recurring program under a slightly different name ("Karaoke Boys" vs.
 * the rule's "Karaoke"), which would otherwise get posted a second time under
 * a different external_id and show up as a duplicate in the calendar.
 */

const RECURRING_EVENTS_PATH = path.resolve("repeating-events.json");
const TIME_ZONE = "America/New_York";

// Only the fields needed for conflict detection; .passthrough() so the rest
// of repeating-events.json's shape (time, duration, url, iconEmoji, ...)
// doesn't need to be re-declared here just to validate.
const RecurringRuleSchema = z
  .object({
    ruleId: z.string(),
    title: z.string(),
    location: z.string(),
    rrule: z.string(),
    endDate: z.string().optional(),
  })
  .passthrough();
const RecurringRulesSchema = z.array(RecurringRuleSchema);

export type RecurringRule = z.infer<typeof RecurringRuleSchema>;

let cached: RecurringRule[] | null = null;

/**
 * Loads and caches repeating-events.json. Returns an empty list (rather than
 * throwing) if the file is missing or malformed — a broken conflict check
 * shouldn't block posting Instagram events, it should just stop checking.
 */
export async function loadRecurringRules(): Promise<RecurringRule[]> {
  if (cached) return cached;
  try {
    const raw = JSON.parse(await fs.readFile(RECURRING_EVENTS_PATH, "utf-8"));
    const parsed = RecurringRulesSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[recurring-events] repeating-events.json failed validation; skipping duplicate checks.`);
      return (cached = []);
    }
    return (cached = parsed.data);
  } catch (err) {
    console.warn(
      `[recurring-events] Could not read repeating-events.json (${(err as Error).message}); skipping duplicate checks.`,
    );
    return (cached = []);
  }
}

/** Whether a rule's RRULE produces an occurrence on the given local calendar date. */
function ruleOccursOn(rule: RecurringRule, dateStr: string): boolean {
  if (rule.endDate && dateStr > rule.endDate) return false;
  try {
    const options = RRule.parseString(rule.rrule);
    // The exact dtstart date doesn't matter for BYDAY/BYSETPOS matching as
    // long as it's safely before the window we check — only the weekday
    // pattern in the RRULE itself determines which dates match.
    options.dtstart = toDate("2020-01-01T12:00:00", { timeZone: TIME_ZONE });
    options.tzid = TIME_ZONE;
    if (rule.endDate) options.until = toDate(`${rule.endDate}T23:59:59`, { timeZone: TIME_ZONE });
    const occurrences = new RRule(options).between(
      toDate(`${dateStr}T00:00:00`, { timeZone: TIME_ZONE }),
      toDate(`${dateStr}T23:59:59`, { timeZone: TIME_ZONE }),
      true,
    );
    return occurrences.length > 0;
  } catch {
    return false;
  }
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "at", "in", "of", "night", "nite", "party",
  "weekly", "monthly", "club", "presents", "with", "for", "beacon",
]);

function significantWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

function sharesSignificantWord(a: string, b: string): boolean {
  const wordsA = significantWords(a);
  for (const w of significantWords(b)) if (wordsA.has(w)) return true;
  return false;
}

/** Drops a trailing ", Beacon, NY"-style suffix so venue names compare cleanly. */
function normalizeLocation(s: string): string {
  return s.toLowerCase().replace(/,.*$/, "").trim();
}

function locationsMatch(a: string, b: string): boolean {
  const na = normalizeLocation(a);
  const nb = normalizeLocation(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na) || sharesSignificantWord(na, nb);
}

/**
 * Finds a recurring-event rule that plausibly generates the same real-world
 * occurrence as `candidate`: a fuzzy-matching venue, a shared keyword in the
 * title, and an RRULE occurrence on that exact date. All three are required —
 * matching only the date and venue would flag unrelated events that happen to
 * share a venue on the same day.
 */
export function findRecurringConflict(
  candidate: { title: string; location: string; date: string },
  rules: RecurringRule[],
): RecurringRule | undefined {
  return rules.find(
    (rule) =>
      locationsMatch(candidate.location, rule.location) &&
      sharesSignificantWord(candidate.title, rule.title) &&
      ruleOccursOn(rule, candidate.date),
  );
}

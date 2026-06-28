import { isWithinInterval, startOfDay, endOfDay } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import slugify from "slugify";
import { parse, HTMLElement } from "node-html-parser";

import type { Event, ScrapeOptions, Scraper } from "../types.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { logEventFound } from "../utils/logging.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "howland-cultural-center";
const LOCATION_NAME = "Howland Cultural Center";
const EVENTS_URL =
  "https://www.howlandculturalcenter.org/events_whats_happening.html";
const TIME_ZONE = "America/New_York";

// A browser-like UA avoids any bot-protection served to scripted clients.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Hosts that represent a real per-event ticket/registration link. Other buttons
// on the page (membership via donorbox, email signup, press, recurring-program
// signups) are intentionally excluded so they never get attached to an event.
const TICKET_HOSTS = [
  "ticketspice.com",
  "zeffy.com",
  "eventbrite.com",
  "brownpapertickets.com",
  "bit.ly",
];

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Format A: "Saturday, June 27 at 8 PM" (also "Tuesday, July 14 - 7 PM").
// The weekday and time are optional-ish; we only require "Month Day".
const DATE_RE_A =
  /(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*(?:at|-|–)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?)?/i;

// Format B: "June 30, 2026 | 7:00PM" (used by the Lyra Music Festival concerts).
const DATE_RE_B =
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\s*\|\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i;

interface ParsedDate {
  /** Whole matched substring, so we can strip it out of the description. */
  match: string;
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

/** Converts a 12-hour clock reading to 24-hour. Tolerates a missing period. */
function to24Hour(hour: number, period: string | undefined): number {
  let h = hour;
  if (period) {
    const isPM = period.toUpperCase() === "PM";
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
  } else if (h >= 1 && h <= 11) {
    // No AM/PM given. Every event at this venue is an afternoon/evening
    // program, so assume PM and warn rather than silently picking the morning.
    console.warn(
      `[${SCRAPER_ID}] No AM/PM on time "${h}" — assuming PM.`,
    );
    h += 12;
  }
  return h;
}

/**
 * Extracts the event date/time from a block of text. Tries the year-less
 * "Weekday, Month Day at Time" format first, then the Lyra
 * "Month Day, Year | Time" format. Returns undefined if neither matches.
 */
function parseEventDate(text: string, now: Date): ParsedDate | undefined {
  const a = DATE_RE_A.exec(text);
  if (a) {
    const month = MONTHS[a[1].toLowerCase()];
    const day = Number.parseInt(a[2], 10);
    const hour = a[3] ? to24Hour(Number.parseInt(a[3], 10), a[5]) : 0;
    const minute = a[4] ? Number.parseInt(a[4], 10) : 0;
    // No year in the source. Assume the current year, rolling to next year when
    // the month has already passed. Stale single days are dropped later by the
    // date-range filter, so we don't try to bump past days here.
    const currentYear = Number.parseInt(
      formatInTimeZone(now, TIME_ZONE, "yyyy"),
      10,
    );
    const currentMonth = Number.parseInt(
      formatInTimeZone(now, TIME_ZONE, "M"),
      10,
    );
    const year = month < currentMonth ? currentYear + 1 : currentYear;
    return { match: a[0], year, month, day, hour, minute };
  }

  const b = DATE_RE_B.exec(text);
  if (b) {
    const month = MONTHS[b[1].toLowerCase()];
    const day = Number.parseInt(b[2], 10);
    const year = Number.parseInt(b[3], 10);
    const hour = to24Hour(Number.parseInt(b[4], 10), b[6]);
    const minute = b[5] ? Number.parseInt(b[5], 10) : 0;
    return { match: b[0], year, month, day, hour, minute };
  }

  return undefined;
}

/** Builds an ISO 8601 string for a wall-clock time in the venue's timezone. */
function toIsoInTimeZone(d: ParsedDate): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const wall = `${d.year}-${pad(d.month)}-${pad(d.day)} ${pad(d.hour)}:${pad(
    d.minute,
  )}:00`;
  return fromZonedTime(wall, TIME_ZONE).toISOString();
}

/** Whether an <a> points at a known ticketing/registration host. */
function isTicketLink(href: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return TICKET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Walks the content tree in document order, collecting event `.paragraph`
 * blocks and ticket buttons. Each event's ticket link consistently appears in
 * the markup immediately *before* its paragraph, so we remember the most recent
 * ticket button and clear it whenever we pass any paragraph (so a button can't
 * leak across a bio/promo block to a later event).
 */
function collectNodes(
  root: HTMLElement,
): { paragraphs: HTMLElement[]; buttonBefore: Map<HTMLElement, string> } {
  const paragraphs: HTMLElement[] = [];
  const buttonBefore = new Map<HTMLElement, string>();
  let pendingButton: string | undefined;

  const visit = (node: HTMLElement) => {
    const cls = node.getAttribute("class") ?? "";
    const isParagraph = node.tagName === "DIV" && cls.includes("paragraph");
    const isButton = node.tagName === "A" && cls.includes("wsite-button");

    if (isButton) {
      const href = node.getAttribute("href") ?? "";
      if (isTicketLink(href)) pendingButton = href;
      return; // buttons have no nested paragraphs to descend into
    }

    if (isParagraph) {
      paragraphs.push(node);
      if (pendingButton) buttonBefore.set(node, pendingButton);
      pendingButton = undefined; // consumed (or reset by a non-event paragraph)
      return;
    }

    for (const child of node.childNodes) {
      if (child instanceof HTMLElement) visit(child);
    }
  };

  visit(root);
  return { paragraphs, buttonBefore };
}

/** Title = first `<font size="5">` whose text is not itself the date line. */
function extractTitle(
  block: HTMLElement,
  dateMatch: string,
): string | undefined {
  const fonts = block.querySelectorAll('font[size="5"]');
  for (const font of fonts) {
    const text = font.text.replace(/\s+/g, " ").trim();
    if (text && text !== dateMatch && !parseEventDate(text, new Date())) {
      return text;
    }
  }
  return undefined;
}

/**
 * Description = the block's remaining content after removing the title and date
 * nodes. We strip those nodes from the DOM (rather than filtering markdown
 * lines) so we never leave behind unbalanced emphasis markers.
 *
 * Mutates `block`; safe because each block is only processed once.
 */
function extractDescription(
  block: HTMLElement,
  title: string,
  dateMatch: string,
): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const titleNorm = norm(title);
  const dateNorm = norm(dateMatch);

  // Remove the title node (the first size=5 font matching the title).
  for (const font of block.querySelectorAll('font[size="5"]')) {
    if (norm(font.text) === titleNorm) {
      font.remove();
      break;
    }
  }

  // Remove the smallest element that exactly wraps the date string. This covers
  // both formats: the colored size=5 font (Format A) and the <strong> (Format B).
  let dateNode: HTMLElement | undefined;
  for (const el of block.querySelectorAll("*")) {
    if (norm(el.text) === dateNorm) dateNode = el; // last (deepest) wins
  }
  dateNode?.remove();

  let md = convertHtmlToMarkdown(block.innerHTML)
    .replace(/^\s*[*_]+\s*$/gm, "") // drop emphasis-only lines left by node removal
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Removing the title/date nodes can orphan one half of a bold/italic pair.
  // If a marker is left unbalanced, drop a trailing one rather than emit `**`.
  if ((md.match(/\*\*/g)?.length ?? 0) % 2 === 1) md = md.replace(/\s*\*\*\s*$/, "");
  if ((md.match(/(?<!\*)\*(?!\*)/g)?.length ?? 0) % 2 === 1)
    md = md.replace(/\s*\*\s*$/, "");

  return md.trim();
}

const scrapeHowlandCulturalCenterEvents = async (
  options: ScrapeOptions,
): Promise<Event[]> => {
  const { startDate, endDate = startDate, verbose } = options;
  const now = new Date();

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatInTimeZone(
      startDate,
      TIME_ZONE,
      "yyyy-MM-dd",
    )} to ${formatInTimeZone(endDate, TIME_ZONE, "yyyy-MM-dd")}...`,
  );

  try {
    const response = await fetch(EVENTS_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch events page: ${response.status} ${response.statusText}`,
      );
    }
    const html = await response.text();
    const root = parse(html);

    // Scope to the main content region when present; fall back to the whole doc.
    const content =
      root.querySelector(".wsite-section-elements") ?? root;

    const { paragraphs, buttonBefore } = collectNodes(content);
    if (verbose) {
      console.log(
        `[${SCRAPER_ID}] Found ${paragraphs.length} paragraph blocks.`,
      );
    }

    const events: Event[] = [];
    const dateInterval = {
      start: startOfDay(startDate),
      end: endOfDay(endDate),
    };

    for (const block of paragraphs) {
      const blockText = block.text.replace(/\s+/g, " ").trim();
      const parsed = parseEventDate(blockText, now);
      if (!parsed) continue; // bio/promo/recurring blocks without a concrete date

      const title = extractTitle(block, parsed.match);
      if (!title) {
        console.warn(
          `[${SCRAPER_ID}] Skipping block with a date but no title: ${blockText.slice(0, 80)}`,
        );
        continue;
      }

      const startAt = toIsoInTimeZone(parsed);

      // Drop events outside the requested window (this also discards stale
      // past dates that the year inference may have left in the current year).
      if (!isWithinInterval(new Date(startAt), dateInterval)) continue;

      const url = buttonBefore.get(block) ?? EVENTS_URL;
      const description = extractDescription(block, title, parsed.match);
      const titleSlug = slugify(title, { lower: true, strict: true }).slice(
        0,
        50,
      );

      const event: Event = {
        title,
        description,
        location: LOCATION_NAME,
        start_at: startAt,
        url,
        external_id: `${SCRAPER_ID}-${formatInTimeZone(
          new Date(startAt),
          TIME_ZONE,
          "yyyy-MM-dd",
        )}-${titleSlug}`,
      };

      events.push(event);
      logEventFound(SCRAPER_ID, event);
    }

    console.log(
      `[${SCRAPER_ID}] Found ${events.length} events within the date range.`,
    );

    try {
      return EventsArraySchema.parse(events) as Event[];
    } catch (validationError) {
      console.error(`[${SCRAPER_ID}] Validation error:`, validationError);
      throw new Error(
        `[${SCRAPER_ID}] Event validation failed: ${JSON.stringify(validationError)}`,
      );
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] Error scraping events:`, error);
    return [];
  }
};

export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeHowlandCulturalCenterEvents,
};

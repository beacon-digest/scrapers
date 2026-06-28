import { isWithinInterval } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import slugify from "slugify";

import type { Event, ScrapeOptions, Scraper } from "../types.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { logEventFound } from "../utils/logging.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "beahive-beacon";
const LOCATION_NAME = "Beahive Beacon";
const TIME_ZONE = "America/New_York";

// The public-facing site (used to build human-readable event URLs).
const SITE_BASE = "https://beahivebeacon.nexudus.site/beahivebeacon";
// The Nexudus public JSON API. `pastEvents=false` (and no `featured` flag)
// returns the "Upcoming events" list rather than the homepage featured banner.
const API_BASE = "https://beahivebeacon.spaces.nexudus.com/api/public/events";
const PAGE_SIZE = 100;

/**
 * Shape of an event record returned by the Nexudus public events API.
 * Only the fields we consume are typed here.
 */
interface NexudusEventRecord {
  Id: number;
  Name: string;
  ShortDescription: string | null;
  LongDescription: string | null;
  Location: string | null;
  StartDateUtc: string;
  EndDateUtc: string;
}

interface NexudusEventsResponse {
  CalendarEvents: {
    Records: NexudusEventRecord[];
    HasNextPage: boolean;
  };
}

/**
 * Fetches every page of upcoming events from the Nexudus public API.
 */
const fetchUpcomingRecords = async (): Promise<NexudusEventRecord[]> => {
  const records: NexudusEventRecord[] = [];
  let page = 1;

  while (true) {
    const url = `${API_BASE}?pastEvents=false&page=${page}&top=${PAGE_SIZE}`;
    console.log(`[${SCRAPER_ID}] Fetching ${url}...`);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        // A browser-like UA avoids the bot-protection 403 served to headless clients.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch events: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as NexudusEventsResponse;
    const pageRecords = data.CalendarEvents?.Records ?? [];
    records.push(...pageRecords);

    if (!data.CalendarEvents?.HasNextPage || pageRecords.length === 0) {
      break;
    }
    page += 1;
  }

  return records;
};

/**
 * Scrapes upcoming events from the Beahive Beacon (Nexudus) events page.
 */
const scrapeBeahiveBeaconEvents = async (
  options: ScrapeOptions,
): Promise<Event[]> => {
  const { startDate, endDate = startDate } = options;

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatInTimeZone(
      startDate,
      TIME_ZONE,
      "yyyy-MM-dd",
    )} to ${formatInTimeZone(endDate, TIME_ZONE, "yyyy-MM-dd")}...`,
  );

  try {
    const records = await fetchUpcomingRecords();
    console.log(`[${SCRAPER_ID}] API returned ${records.length} upcoming events.`);

    const allEvents: Event[] = [];

    for (const record of records) {
      if (!record.Name || !record.StartDateUtc) {
        console.warn(
          `[${SCRAPER_ID}] Skipping event with missing required data: ${record.Name || "Unnamed event"}`,
        );
        continue;
      }

      const eventStart = new Date(record.StartDateUtc);
      const eventEnd = record.EndDateUtc
        ? new Date(record.EndDateUtc)
        : eventStart;

      // Skip events outside the requested date range.
      if (
        !isWithinInterval(eventStart, { start: startDate, end: endDate }) &&
        !isWithinInterval(eventEnd, { start: startDate, end: endDate }) &&
        !(startDate >= eventStart && endDate <= eventEnd) // Event spans our entire range
      ) {
        continue;
      }

      const slug = slugify(record.Name, { lower: true, strict: true });
      const html = record.LongDescription || record.ShortDescription || "";

      const scrapedEvent: Event = {
        title: record.Name.trim(),
        description: html ? convertHtmlToMarkdown(html) : "",
        location: record.Location?.trim() || LOCATION_NAME,
        start_at: eventStart.toISOString(),
        end_at: eventEnd.toISOString(),
        url: `${SITE_BASE}/events/view/${record.Id}/${slug}`,
        external_id: `${SCRAPER_ID}-${record.Id}`,
      };

      allEvents.push(scrapedEvent);
      logEventFound(SCRAPER_ID, scrapedEvent);
    }

    console.log(
      `[${SCRAPER_ID}] Found ${allEvents.length} events within specified date range.`,
    );

    try {
      const validatedEvents = EventsArraySchema.parse(allEvents);
      console.log(
        `[${SCRAPER_ID}] Validation successful for ${validatedEvents.length} events.`,
      );
      return validatedEvents;
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
  scrape: scrapeBeahiveBeaconEvents,
};

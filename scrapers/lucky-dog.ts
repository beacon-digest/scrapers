import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

import type { Event, ScrapeOptions, Scraper } from "../types.js";
import { logEventFound } from "../utils/logging.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "lucky-dog";
const LOCATION_NAME = "Lucky Dog";
const BASE_URL = "https://www.luckydogbeacon.com";
const EVENTS_URL = `${BASE_URL}/events`;
const TIME_ZONE = "America/New_York";

interface RawEvent {
  title: string;
  url: string;
  date: string;
  startTime: string;
  endTime: string;
  descriptionHtml: string;
  googleCalendarUrl: string;
}

/** Parse the compact timestamps Squarespace puts in its Google Calendar URL. */
function parseCalendarTimestamp(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    value,
  );
  if (!match) return undefined;

  const [, year, month, day, hour = "00", minute = "00", second = "00", zulu] =
    match;
  const isoLike = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const date = zulu
    ? new Date(`${isoLike}Z`)
    : fromZonedTime(isoLike, TIME_ZONE);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseCalendarRange(
  googleCalendarUrl: string,
): { start: Date; end?: Date } | undefined {
  try {
    const dates = new URL(googleCalendarUrl).searchParams.get("dates");
    if (!dates) return undefined;

    const [rawStart, rawEnd] = dates.split("/");
    const start = parseCalendarTimestamp(rawStart);
    if (!start) return undefined;

    const end = rawEnd ? parseCalendarTimestamp(rawEnd) : undefined;
    return { start, end };
  } catch {
    return undefined;
  }
}

/** Fallback for an event whose Google Calendar export link is absent. */
function parseLocalDateTime(date: string, time: string): Date | undefined {
  const match = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(
    time.replace(/[\u00a0\u202f]/g, " ").trim(),
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !match) return undefined;

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;

  const wallTime = `${date}T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:00`;
  const parsed = fromZonedTime(wallTime, TIME_ZONE);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function eventSlug(url: string): string | undefined {
  try {
    const parts = new URL(url, BASE_URL).pathname.split("/").filter(Boolean);
    return parts.at(-1);
  } catch {
    return undefined;
  }
}

async function scrapeLuckyDogEvents(options: ScrapeOptions): Promise<Event[]> {
  const { startDate, endDate = startDate, browser, verbose } = options;
  if (!browser) throw new Error("A Puppeteer browser instance must be provided.");

  const startKey = formatInTimeZone(startDate, TIME_ZONE, "yyyy-MM-dd");
  const endKey = formatInTimeZone(endDate, TIME_ZONE, "yyyy-MM-dd");
  console.log(
    `[${SCRAPER_ID}] Scraping events from ${startKey} to ${endKey}...`,
  );

  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await page.goto(EVENTS_URL, { waitUntil: "networkidle0", timeout: 60_000 });

    try {
      await page.waitForSelector(".eventlist--upcoming .eventlist-event", {
        timeout: 20_000,
      });
    } catch {
      console.warn(`[${SCRAPER_ID}] No upcoming event entries found.`);
      return [];
    }

    const rawEvents = await page.evaluate((): RawEvent[] => {
      return Array.from(
        document.querySelectorAll(".eventlist--upcoming .eventlist-event"),
      ).map((element) => ({
        title:
          element.querySelector(".eventlist-title-link")?.textContent?.trim() ??
          "",
        url:
          element
            .querySelector<HTMLAnchorElement>(".eventlist-title-link")
            ?.getAttribute("href") ?? "",
        date:
          element
            .querySelector<HTMLTimeElement>("time.event-date")
            ?.getAttribute("datetime") ?? "",
        startTime:
          element
            .querySelector("time.event-time-localized-start")
            ?.textContent?.trim() ?? "",
        endTime:
          element
            .querySelector("time.event-time-localized-end")
            ?.textContent?.trim() ?? "",
        descriptionHtml:
          element
            .querySelector(
              ".eventlist-excerpt, .eventlist-description .sqs-html-content",
            )
            ?.innerHTML?.trim() ?? "",
        googleCalendarUrl:
          element
            .querySelector<HTMLAnchorElement>(".eventlist-meta-export-google")
            ?.href ?? "",
      }));
    });

    if (verbose) {
      console.log(
        `[${SCRAPER_ID}] Found ${rawEvents.length} upcoming event entries.`,
      );
    }

    const events: Event[] = [];
    for (const raw of rawEvents) {
      if (!raw.title || !raw.url) {
        console.warn(`[${SCRAPER_ID}] Skipping an entry without a title or URL.`);
        continue;
      }

      const calendarRange = parseCalendarRange(raw.googleCalendarUrl);
      const start =
        calendarRange?.start ?? parseLocalDateTime(raw.date, raw.startTime);
      const end = calendarRange?.end ?? parseLocalDateTime(raw.date, raw.endTime);
      if (!start) {
        console.warn(
          `[${SCRAPER_ID}] Skipping "${raw.title}" because its start time could not be parsed.`,
        );
        continue;
      }

      const eventDateKey = formatInTimeZone(start, TIME_ZONE, "yyyy-MM-dd");
      if (eventDateKey < startKey || eventDateKey > endKey) continue;

      const fullUrl = new URL(raw.url, BASE_URL).toString();
      const slug = eventSlug(fullUrl) ?? `${eventDateKey}-${raw.title}`;
      const event: Event = {
        title: raw.title,
        description: raw.descriptionHtml
          ? convertHtmlToMarkdown(raw.descriptionHtml)
          : "",
        location: LOCATION_NAME,
        start_at: start.toISOString(),
        end_at: end?.toISOString(),
        url: fullUrl,
        external_id: `${SCRAPER_ID}-${slug}`,
      };

      events.push(event);
      logEventFound(SCRAPER_ID, event);
    }

    const validated = EventsArraySchema.parse(events);
    console.log(
      `[${SCRAPER_ID}] Found ${validated.length} events within the requested date range.`,
    );
    return validated;
  } finally {
    await page.close();
  }
}

export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeLuckyDogEvents,
};

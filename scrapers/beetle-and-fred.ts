import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import type { Event, ScrapeOptions, Scraper } from "../types.js";
import { logEventFound } from "../utils/logging.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "beetle-and-fred";
const LOCATION_NAME = "Beetle and Fred";
const BASE_URL = "https://www.beetleandfred.com";
const CLASSES_URL = `${BASE_URL}/classes.htm`;
const TIME_ZONE = "America/New_York";

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

interface RawClass {
  title: string;
  timestamp: string;
  url: string;
  description: string;
}

/** Converts Beetle and Fred's displayed Eastern class time to a UTC instant. */
export function parseBeetleAndFredDateTime(value: string): Date | undefined {
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([ap]m)$/i.exec(
    value.trim(),
  );
  if (!match) return undefined;

  const [, rawMonth, rawDay, rawYear, rawHour, rawMinute, rawPeriod] = match;
  const month = MONTHS[rawMonth.toLowerCase()];
  const day = Number(rawDay);
  const year = Number(rawYear);
  let hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!month || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) {
    return undefined;
  }
  if (rawPeriod.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (rawPeriod.toLowerCase() === "am" && hour === 12) hour = 0;

  const wallTime = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const parsed = fromZonedTime(wallTime, TIME_ZONE);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function scrapeBeetleAndFredClasses(options: ScrapeOptions): Promise<Event[]> {
  const { startDate, endDate = startDate, browser, verbose } = options;
  if (!browser) throw new Error("A Puppeteer browser instance must be provided.");

  const startKey = formatInTimeZone(startDate, TIME_ZONE, "yyyy-MM-dd");
  const endKey = formatInTimeZone(endDate, TIME_ZONE, "yyyy-MM-dd");
  console.log(`[${SCRAPER_ID}] Scraping classes from ${startKey} to ${endKey}...`);

  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await page.goto(CLASSES_URL, { waitUntil: "networkidle0", timeout: 60_000 });
    await page.waitForSelector('span.hidden-xs a[href*="/module/class/"]', {
      timeout: 20_000,
    });

    const rawClasses = await page.$$eval(
      'div.row:has(span.hidden-xs a[href*="/module/class/"])',
      (rows): RawClass[] =>
        rows.flatMap((row) => {
          const detail = Array.from(row.children).find((child) =>
            child.matches(".col-sm-9, .col-md-9, .col-lg-10"),
          ) as HTMLElement | undefined;
          const heading = detail?.querySelector<HTMLSpanElement>(":scope > span.hidden-xs");
          const link = heading?.querySelector<HTMLAnchorElement>('a[href*="/module/class/"]');
          if (!heading || !link || !detail) return [];
          const title = link.textContent?.trim() ?? "";
          const timestamp = (heading.textContent ?? "").replace(title, "").replace(/^\s*-\s*/, "").trim();
          const description = (detail.textContent ?? "").replace(heading.textContent ?? "", "").replace(/\s+/g, " ").trim();
          return [{ title, timestamp, url: link.href, description }];
        }),
    );

    if (verbose) console.log(`[${SCRAPER_ID}] Found ${rawClasses.length} class entries.`);

    const events: Event[] = [];
    for (const rawClass of rawClasses) {
      const start = parseBeetleAndFredDateTime(rawClass.timestamp);
      if (!start || !rawClass.title || !rawClass.url) {
        console.warn(`[${SCRAPER_ID}] Skipping an entry with an invalid title, URL, or timestamp.`);
        continue;
      }
      const eventDate = formatInTimeZone(start, TIME_ZONE, "yyyy-MM-dd");
      if (eventDate < startKey || eventDate > endKey) continue;

      const classId = new URL(rawClass.url).pathname.split("/").filter(Boolean).at(-2);
      const event: Event = {
        title: rawClass.title,
        description: rawClass.description,
        location: LOCATION_NAME,
        start_at: start.toISOString(),
        url: rawClass.url,
        external_id: `${SCRAPER_ID}-${eventDate}-${classId ?? rawClass.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      };
      events.push(event);
      logEventFound(SCRAPER_ID, event);
    }

    const validated = EventsArraySchema.parse(events);
    console.log(`[${SCRAPER_ID}] Found ${validated.length} classes within the requested date range.`);
    return validated;
  } finally {
    await page.close();
  }
}

export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeBeetleAndFredClasses,
};

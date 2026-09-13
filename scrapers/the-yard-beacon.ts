import type { Browser, Page } from "puppeteer";
import {
  parseISO,
  isValid as isValidDate,
  isWithinInterval,
  startOfDay,
  endOfDay,
  format as formatDateFn, // Keep this if used in logging
} from "date-fns";
// Reinstate if needed for helper functions
import { toDate, formatInTimeZone } from "date-fns-tz";
import { decode } from "html-entities";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { logEventFound } from "../utils/logging.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";
import { formatDate } from "../utils/date.js"; // For logging

const SCRAPER_ID = "the-yard-beacon";
const LOCATION_NAME = "The Yard";
const BASE_URL = "https://www.theyardbeacon.com";
const EVENTS_URL = `${BASE_URL}/upcoming-events`;
const TIME_ZONE = "America/New_York";

// Reinstate RawEventData if using DOM scraping
interface RawEventData {
  title: string;
  url: string;
  dateStr: string; // YYYY-MM-DD from datetime attribute
  timeStr: string; // e.g., "5:00 PM 11:00 PM"
}

// --- Restore Helper Functions for DOM scraping --- START

function convert12to24Yard(
  hour: string,
  min: string,
  period: string,
): string | undefined {
  let h = Number.parseInt(hour, 10);
  if (Number.isNaN(h) || h < 1 || h > 12) return undefined;
  const m = Number.parseInt(min, 10);
  if (Number.isNaN(m) || m < 0 || m > 59) return undefined;
  const lcPeriod = period?.toLowerCase();
  if (lcPeriod === "pm" && h !== 12) {
    h += 12;
  } else if (lcPeriod === "am" && h === 12) {
    h = 0;
  }
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:00`;
}

function parseTheYardTime(timeString: string): {
  startTime?: string;
  endTime?: string;
} {
  if (!timeString) return {};
  const timeRegex =
    /^(\d{1,2}):(\d{2})\s*(am|pm)(?:\s+(\d{1,2}):(\d{2})\s*(am|pm))?$/i;
  let match = timeString.match(timeRegex);
  if (!match) {
    const tightTimeRegex =
      /^(\d{1,2}):(\d{2})(am|pm)(?:\s+(\d{1,2}):(\d{2})(am|pm))?$/i;
    match = timeString.match(tightTimeRegex);
    if (!match) {
      console.warn(
        `[${SCRAPER_ID}] Could not parse time string: "${timeString}"`,
      );
      return {};
    }
  }
  const [, startHour, startMin, startPeriod, endHour, endMin, endPeriod] =
    match;
  const startTime = convert12to24Yard(startHour, startMin, startPeriod);
  let endTime: string | undefined = undefined;
  if (endHour && endMin && endPeriod) {
    endTime = convert12to24Yard(endHour, endMin, endPeriod);
  }
  return { startTime: startTime ?? undefined, endTime };
}

function combineAndGetISO(
  dateStr: string,
  timeStr?: string,
): string | undefined {
  const effectiveTimeStr = timeStr || "00:00:00";
  try {
    const fullDateTimeStr = `${dateStr}T${effectiveTimeStr}`;
    const zonedDate = toDate(fullDateTimeStr, { timeZone: TIME_ZONE });
    if (!isValidDate(zonedDate)) {
      throw new Error("Parsed date is invalid");
    }
    return zonedDate.toISOString();
  } catch (e) {
    console.error(
      `[${SCRAPER_ID}] Error creating ISO date for ${dateStr} ${timeStr}:`,
      e,
    );
    return undefined;
  }
}
// --- Restore Helper Functions for DOM scraping --- END

// --- Scraper Implementation (Node.js Parsing Strategy) ---

const scrapeTheYardEvents = async (
  options: ScrapeOptions,
): Promise<Event[]> => {
  const { startDate, endDate: inputEndDate, browser } = options;
  const endDate = inputEndDate || startDate;

  if (!browser) {
    throw new Error("A Puppeteer browser instance must be provided.");
  }

  const allEvents: Event[] = [];
  let page: Page | undefined;

  console.log(
    `[${SCRAPER_ID}] Scraping events using Node parsing from ${formatDate(
      startDate,
    )} to ${formatDate(endDate)}...`,
  );
  if (options.verbose) {
    console.log(`[${SCRAPER_ID}] Navigating to ${EVENTS_URL}...`);
  }

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    );

    await page.goto(EVENTS_URL, { waitUntil: "networkidle0", timeout: 90000 });

    const sourceSelector =
      ".eventlist--upcoming article.eventlist-event, #dice-event-list-widget article";

    await page.waitForSelector(sourceSelector, { timeout: 15000 }).catch(() => {
      throw new Error(
        `[${SCRAPER_ID}] No upcoming event source loaded. Expected native Squarespace events or populated Dice widget.`,
      );
    });

    const rawEventsData = await page.evaluate((selector) => {
      const monthNumbers: Record<string, string> = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
      };
      const events: { title: string; url: string; dateStr: string; timeStr: string }[] = [];

      for (const article of Array.from(document.querySelectorAll(selector))) {
        const native = article.matches(".eventlist-event");
        const titleElement = native
          ? article.querySelector(".eventlist-title-link")
          : article.querySelector("img[alt], img");
        const linkElement = native
          ? article.querySelector(".eventlist-title-link")
          : article.querySelector('a[href*="dice.fm"]');
        const title = (native ? titleElement?.textContent : titleElement?.getAttribute("alt"))?.trim() || "";
        const url = (linkElement as HTMLAnchorElement | null)?.href || "";

        let dateStr = native
          ? article.querySelector("time.event-date")?.getAttribute("datetime") || ""
          : "";
        let timeStr = "";
        if (native) {
          const start = article.querySelector(".event-time-localized-start")?.textContent?.trim() || "";
          const end = article.querySelector(".event-time-localized-end")?.textContent?.trim() || "";
          timeStr = [start, end].filter(Boolean).join(" " ).replace(/\u00a0/g, " " );
        } else {
          const text = article.textContent || "";
          const dateMatch = text.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
          const timeMatch = text.match(/\b\d{1,2}:\d{2}\s*(?:am|pm)\b(?:\s+\d{1,2}:\d{2}\s*(?:am|pm)\b)?/i);
          if (dateMatch) {
            const [, , day, month] = dateMatch;
            dateStr = `${new Date().getFullYear()}-${monthNumbers[month.toLowerCase()]}-${day.padStart(2, "0")}`;
          }
          timeStr = timeMatch?.[0] || "";
        }

        // Do not infer dates or times. In particular, do not include
        // multi-day exhibition blocks without a specific event date.
        if (title && url && dateStr && timeStr) {
          events.push({ title, url, dateStr, timeStr });
        }
      }
      return events;
    }, sourceSelector);

    if (rawEventsData.length === 0) {
      throw new Error(
        `[${SCRAPER_ID}] Event source loaded but contained no dated upcoming events.`,
      );
    }
    console.log(`[${SCRAPER_ID}] Found ${rawEventsData.length} dated event elements. Processing...`);

    // --- Event processing logic (restored) --- START
    const dateInterval = {
      start: startOfDay(startDate),
      end: endOfDay(endDate),
    };
    const uniqueEventIds = new Set<string>();

    for (const rawEvent of rawEventsData) {
      try {
        const { startTime, endTime } = parseTheYardTime(rawEvent.timeStr);
        const start_at_iso = combineAndGetISO(rawEvent.dateStr, startTime);
        const end_at_iso = endTime
          ? combineAndGetISO(rawEvent.dateStr, endTime)
          : undefined;

        if (!start_at_iso) {
          continue;
        }

        const eventStartDate = parseISO(start_at_iso);
        if (
          !isValidDate(eventStartDate) ||
          !isWithinInterval(eventStartDate, dateInterval)
        ) {
          continue;
        }

        let external_id = "";
        try {
          const url = new URL(rawEvent.url);
          const slug = url.pathname.split("/").filter(Boolean).pop();
          if (slug) {
            external_id = `${SCRAPER_ID}-${slug}`;
          } else {
            throw new Error("Could not extract slug");
          }
        } catch (e) {
          console.error(
            `[${SCRAPER_ID}] Error generating external_id for ${rawEvent.url}:`,
            e,
          );
          const dateSlug = rawEvent.dateStr.replace(/-/g, "");
          const fallbackTitleSlug = rawEvent.title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .substring(0, 30);
          external_id = `${SCRAPER_ID}-${dateSlug}-${fallbackTitleSlug}`;
          console.warn(`[${SCRAPER_ID}] Using fallback ID: ${external_id}`);
        }

        if (uniqueEventIds.has(external_id)) {
          /* ... */ continue;
        }
        uniqueEventIds.add(external_id);

        let description = `Event at ${LOCATION_NAME}. For more details and tickets, visit the event link.`;

        const event: Event = {
          title: decode(rawEvent.title),
          description: description,
          start_at: start_at_iso,
          end_at: end_at_iso,
          url: rawEvent.url,
          location: LOCATION_NAME,
          external_id: external_id,
        };
        allEvents.push(event);
        logEventFound(SCRAPER_ID, event);
      } catch (processingError) {
        console.error(
          `[${SCRAPER_ID}] Error processing event data for "${rawEvent.title}":`,
          processingError,
        );
      }
    }
    // --- Event processing logic (restored) --- END

    console.log(
      `[${SCRAPER_ID}] Finished processing. Found ${allEvents.length} valid events within the date range.`,
    );

    // Final Validation
    try {
      const validationResult = EventsArraySchema.parse(allEvents);
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.length} events.`,
      );
      return validationResult as Event[];
    } catch (validationError) {
      console.error(
        `[${SCRAPER_ID}] Zod validation failed: ${JSON.stringify(
          validationError,
          null,
          2,
        )}`,
      );
      console.error(
        `[${SCRAPER_ID}] Failing events data: ${JSON.stringify(
          allEvents,
          null,
          2,
        )}`,
      );
      throw new Error(`[${SCRAPER_ID}] Event validation failed.`);
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] An unexpected error occurred:`, error);
    throw error;
  } finally {
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (closeError) {
        console.warn(`[${SCRAPER_ID}] Could not close page cleanly:`, closeError);
      }
    }
  }
};

export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeTheYardEvents,
};

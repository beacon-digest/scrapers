import type { Page } from "puppeteer";
import {
  parse as parseDate,
  isWithinInterval,
  formatISO,
  isValid as isValidDate,
  startOfDay,
  endOfDay,
  format as formatDateFn,
} from "date-fns";
import { toDate } from "date-fns-tz";
import { decode } from "html-entities";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { logEventFound } from "../utils/logging.js";
import { formatDate } from "../utils/date.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "saint-ritas-music-room";
const BASE_URL = "https://www.saintritasmusicroom.com";
const EVENTS_URL = BASE_URL;
const LOCATION_NAME = "Saint Rita's Music Room";
const TIME_ZONE = "America/New_York";

/**
 * Helper function to parse Saint Rita's date/time strings
 * Example date: "Friday, August 22, 2025"
 * Example times: "8:00 PM" and "11:00 PM"
 */
function parseSaintRitasDateTime(
  dateStr: string,
  startTimeStr: string,
  endTimeStr?: string,
): {
  date?: string;
  startTime?: string;
  endTime?: string;
} {
  if (!dateStr) return {};

  // Parse date format "Friday, August 22, 2025"
  let date: string | undefined;
  try {
    const parsedDate = parseDate(dateStr, "EEEE, MMMM d, yyyy", new Date());
    if (isValidDate(parsedDate)) {
      date = formatDateFn(parsedDate, "yyyy-MM-dd");
    }
  } catch (_) {
    console.warn(`[${SCRAPER_ID}] Could not parse date format: "${dateStr}"`);
    return {};
  }

  // Parse time formats "8:00 PM", "11:00 PM"
  let startTime: string | undefined;
  let endTime: string | undefined;

  if (startTimeStr) {
    startTime = convert12to24(startTimeStr);
  }

  if (endTimeStr) {
    endTime = convert12to24(endTimeStr);
  }

  return { date, startTime, endTime };
}

/**
 * Helper to convert 12-hour time to 24-hour format
 */
function convert12to24(timeStr: string): string | undefined {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!match) return undefined;

  const [, hour, min, period] = match;
  let h = Number.parseInt(hour, 10);

  if (Number.isNaN(h)) return undefined;

  const isPM = period.toUpperCase() === "PM";
  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0; // Midnight case

  return `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
}

/**
 * Helper to combine date and time into ISO string
 */
function combineToISOString(date: string, time?: string): string | undefined {
  if (!date) return undefined;

  const effectiveTime = time || "00:00:00";

  try {
    const dateTimeString = `${date}T${effectiveTime}`;
    const dateObj = toDate(dateTimeString, { timeZone: TIME_ZONE });
    if (!isValidDate(dateObj)) {
      console.warn(
        `[${SCRAPER_ID}] Invalid date constructed from ${dateTimeString}`,
      );
      return undefined;
    }
    return formatISO(dateObj);
  } catch (error) {
    console.error(`[${SCRAPER_ID}] Error creating ISO date:`, error);
    return undefined;
  }
}

/**
 * Scrapes events from Saint Rita's Music Room
 */
async function scrapeSaintRitasMusicRoomEvents(
  options: ScrapeOptions,
): Promise<Event[]> {
  const { startDate, endDate = startDate, browser } = options;

  if (!browser) {
    throw new Error("A Puppeteer browser instance must be provided.");
  }

  const events: Event[] = [];
  let page: Page | undefined;

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatDate(startDate)} to ${formatDate(endDate)}...`,
  );

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    if (options.verbose) {
      console.log(`[${SCRAPER_ID}] Navigating to ${EVENTS_URL}`);
    }
    await page.goto(EVENTS_URL, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    // Wait for events to load
    console.log(`[${SCRAPER_ID}] Waiting for events to load...`);
    try {
      await page.waitForSelector(".eventlist-event", { timeout: 30000 });
    } catch (_) {
      console.warn(`[${SCRAPER_ID}] No events found on page`);
      return [];
    }

    // Extract events from both upcoming and past sections
    const rawEvents = await page.evaluate(() => {
      const eventElements = document.querySelectorAll(".eventlist-event");

      return Array.from(eventElements)
        .map((element) => {
          // Extract title
          const titleElement = element.querySelector(".eventlist-title-link");
          const title = titleElement?.textContent?.trim() || "";
          const url = titleElement?.getAttribute("href") || "";

          // Extract date
          const dateElement = element.querySelector(".event-date");
          const dateStr = dateElement?.textContent?.trim() || "";

          // Extract start and end times
          const startTimeElement = element.querySelector(
            ".event-time-localized-start",
          );
          const endTimeElement = element.querySelector(
            ".event-time-localized-end",
          );
          const startTimeStr = startTimeElement?.textContent?.trim() || "";
          const endTimeStr = endTimeElement?.textContent?.trim() || "";

          // Extract description
          const descElement = element.querySelector(".eventlist-excerpt");
          const descriptionHtml = descElement?.innerHTML?.trim() || "";

          // Check if this is a past event
          const isPastEvent = element.closest(".eventlist--past") !== null;

          return {
            title,
            url,
            dateStr,
            startTimeStr,
            endTimeStr,
            descriptionHtml,
            isPastEvent,
          };
        })
        .filter((event) => event.title && event.dateStr);
    });

    console.log(
      `[${SCRAPER_ID}] Found ${rawEvents.length} raw events. Processing...`,
    );

    // Define the date range for filtering
    const dateInterval = {
      start: startOfDay(startDate),
      end: endOfDay(endDate),
    };

    // Process each raw event
    for (const rawEvent of rawEvents) {
      try {
        // Parse the date and time
        const { date, startTime, endTime } = parseSaintRitasDateTime(
          rawEvent.dateStr,
          rawEvent.startTimeStr,
          rawEvent.endTimeStr,
        );

        // Create ISO date strings
        const startAtIso = date
          ? combineToISOString(date, startTime)
          : undefined;
        const endAtIso =
          date && endTime ? combineToISOString(date, endTime) : undefined;

        if (!startAtIso) {
          console.warn(
            `[${SCRAPER_ID}] Could not parse date for event: ${rawEvent.title}`,
          );
          continue;
        }

        // Check if the event is within the requested date range
        const eventDate = new Date(startAtIso);
        if (
          !isValidDate(eventDate) ||
          !isWithinInterval(eventDate, dateInterval)
        ) {
          console.log(
            `[${SCRAPER_ID}] Event outside date range: ${rawEvent.title} on ${formatDateFn(eventDate, "yyyy-MM-dd")}`,
          );
          continue;
        }

        // Process description
        let description = "";
        if (rawEvent.descriptionHtml) {
          description = convertHtmlToMarkdown(rawEvent.descriptionHtml);
        }

        // Generate external ID from URL or title/date
        let external_id = "";
        if (rawEvent.url) {
          // Extract slug from URL like "/events/event-name"
          const urlParts = rawEvent.url.split("/").filter(Boolean);
          const slug = urlParts[urlParts.length - 1];
          external_id = `${SCRAPER_ID}-${slug}`;
        } else {
          // Fallback to title-based ID
          const dateSlug = date?.replace(/-/g, "") || "";
          const titleSlug = rawEvent.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .substring(0, 30);
          external_id = `${SCRAPER_ID}-${dateSlug}-${titleSlug}`;
        }

        // Create full URL
        const fullUrl = rawEvent.url
          ? rawEvent.url.startsWith("http")
            ? rawEvent.url
            : `${BASE_URL}${rawEvent.url}`
          : EVENTS_URL;

        // Create the event object
        const event: Event = {
          title: decode(rawEvent.title),
          description: description,
          start_at: startAtIso,
          end_at: endAtIso,
          url: fullUrl,
          location: LOCATION_NAME,
          external_id: external_id,
        };

        events.push(event);
        logEventFound(SCRAPER_ID, event);
      } catch (processingError) {
        console.error(
          `[${SCRAPER_ID}] Error processing event data for "${rawEvent.title}":`,
          processingError,
        );
      }
    }

    console.log(
      `[${SCRAPER_ID}] Finished processing. Found ${events.length} valid events within the date range.`,
    );

    // Validate the events before returning
    try {
      const validationResult = EventsArraySchema.parse(events);
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.length} events.`,
      );
      return validationResult as Event[];
    } catch (validationError) {
      console.error(`[${SCRAPER_ID}] Zod validation failed:`, validationError);
      throw new Error(`[${SCRAPER_ID}] Event validation failed.`);
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] An unexpected error occurred:`, error);
    return [];
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
  }
}

// Export the scraper object
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeSaintRitasMusicRoomEvents,
};

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
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";
import { formatDate } from "../utils/date.js"; // For logging

// --- Add Node.js HTML Parser Import ---
import { parse as parseHtml } from "node-html-parser";

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
  period: string
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
        `[${SCRAPER_ID}] Could not parse time string: "${timeString}"`
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
  timeStr?: string
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
      e
    );
    return undefined;
  }
}
// --- Restore Helper Functions for DOM scraping --- END

// --- Scraper Implementation (Node.js Parsing Strategy) ---

const scrapeTheYardEvents = async (
  options: ScrapeOptions
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
      startDate
    )} to ${formatDate(endDate)}...`
  );
  console.log(`[${SCRAPER_ID}] Navigating to ${EVENTS_URL}...`);

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    await page.goto(EVENTS_URL, { waitUntil: "networkidle0", timeout: 90000 });

    const parentSelector = ".eventlist";
    let parentHTML = "";

    try {
      // Wait for the parent container
      await page.waitForSelector(parentSelector, { timeout: 30000 });
      console.log(
        `[${SCRAPER_ID}] Parent container selector "${parentSelector}" found.`
      );

      // Fetch the HTML content of the parent container
      parentHTML = await page.$eval(parentSelector, (el) => el.outerHTML);
      console.log(
        `[${SCRAPER_ID}] Fetched outerHTML of parent ${parentSelector}. Length: ${parentHTML.length}`
      );

      if (!parentHTML) {
        throw new Error(`Fetched parent HTML for ${parentSelector} is empty.`);
      }
    } catch (e) {
      console.error(
        `[${SCRAPER_ID}] Error finding or fetching parent selector '${parentSelector}':`,
        e
      );
      // Log body HTML for debugging if wait fails
      try {
        const bodyHTML = await page.evaluate(() => document.body.outerHTML);
        console.log(
          `[${SCRAPER_ID}] Fallback body HTML snapshot on failure:\n${bodyHTML.substring(
            0,
            2000
          )}...`
        );
      } catch (logError) {
        console.error(
          `[${SCRAPER_ID}] Failed to get body HTML for debugging:`,
          logError
        );
      }
      return []; // Return empty if wait fails
    }

    // --- Parse HTML in Node.js Context --- START
    const rawEventsData: RawEventData[] = [];
    console.log(`[${SCRAPER_ID}] Parsing fetched HTML in Node.js context...`);

    try {
      // ** Use node-html-parser **
      const root = parseHtml(parentHTML);
      // The parentHTML is the outerHTML of .eventlist, so query for children within it.
      const eventElements = root.querySelectorAll(".eventlist-event");
      console.log(
        `[${SCRAPER_ID}] Found ${eventElements.length} elements via Node parser.`
      );

      for (const [, /* index */ el] of eventElements.entries()) {
        // Correct selector for title/link element
        const titleElement = el.querySelector("h1.eventlist-title a");
        const dateElement = el.querySelector("time.event-date");
        // Select start and end time elements separately
        const startTimeElement = el.querySelector(
          "time.event-time-localized-start"
        );
        const endTimeElement = el.querySelector(
          "time.event-time-localized-end"
        );

        const title = titleElement?.text?.trim() || "";
        const relativeUrl = titleElement?.getAttribute("href") || "";
        const dateStr = dateElement?.getAttribute("datetime") || "";

        // Construct timeStr from separate elements
        const startTimeText = startTimeElement?.text?.trim();
        const endTimeText = endTimeElement?.text?.trim();
        let timeStr = "";
        if (startTimeText && endTimeText) {
          timeStr = `${startTimeText} ${endTimeText}`; // Combine like "5:00 PM 11:00 PM"
        } else if (startTimeText) {
          timeStr = startTimeText; // Handle cases with only start time
        }

        if (title && relativeUrl && dateStr && timeStr) {
          const url = new URL(relativeUrl, BASE_URL).toString();
          rawEventsData.push({ title, url, dateStr, timeStr });
        } else {
          console.warn(
            `[${SCRAPER_ID}] NodeParser: Skipping child element due to missing data: title=${!!title}, url=${!!relativeUrl}, dateStr=${!!dateStr}, timeStr=${!!timeStr}`
          );
        }
      }
    } catch (parseError) {
      console.error(
        `[${SCRAPER_ID}] Error during Node.js HTML parsing:`,
        parseError
      );
    }
    // --- Parse HTML in Node.js Context --- END

    console.log(
      `[${SCRAPER_ID}] Found ${rawEventsData.length} raw event elements via Node parsing. Processing...`
    );

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
          /* ... */ continue;
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
            e
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

        let description = "(Description not available)";
        console.log(
          `[${SCRAPER_ID}] Fetching details for: ${rawEvent.title} (${rawEvent.url})`
        );
        try {
          await page.goto(rawEvent.url, {
            waitUntil: "networkidle0",
            timeout: 60000,
          });
          const descriptionSelector = ".eventitem-column-content .sqs-layout";
          await page.waitForSelector(descriptionSelector, { timeout: 30000 });
          const descriptionHtml = await page.$eval(
            descriptionSelector,
            (el) => el.innerHTML
          );
          if (descriptionHtml) {
            description = convertHtmlToMarkdown(descriptionHtml);
          } else {
            console.warn(
              `[${SCRAPER_ID}] Description element found but no content for ${rawEvent.title}`
            );
          }
        } catch (detailError) {
          console.error(
            `[${SCRAPER_ID}] Error fetching description from ${rawEvent.url}:`,
            detailError
          );
        }

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
      } catch (processingError) {
        console.error(
          `[${SCRAPER_ID}] Error processing event data for "${rawEvent.title}":`,
          processingError
        );
      }
    }
    // --- Event processing logic (restored) --- END

    console.log(
      `[${SCRAPER_ID}] Finished processing. Found ${allEvents.length} valid events within the date range.`
    );

    // Final Validation
    try {
      const validationResult = EventsArraySchema.parse(allEvents);
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.length} events.`
      );
      return validationResult as Event[];
    } catch (validationError) {
      console.error(
        `[${SCRAPER_ID}] Zod validation failed: ${JSON.stringify(
          validationError,
          null,
          2
        )}`
      );
      console.error(
        `[${SCRAPER_ID}] Failing events data: ${JSON.stringify(
          allEvents,
          null,
          2
        )}`
      );
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
};

export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeTheYardEvents,
};

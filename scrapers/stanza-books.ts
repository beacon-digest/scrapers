import type { Browser, Page } from "puppeteer";
import {
  parse as parseDate,
  isWithinInterval,
  formatISO,
  isValid as isValidDate,
  startOfDay,
  endOfDay,
  format as formatDateFn,
  addMonths,
  isBefore,
  isSameMonth,
  startOfMonth,
} from "date-fns";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { formatDate } from "../utils/date.js"; // For logging/errors
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "stanza-books";
const BASE_URL = "https://www.stanzabooks.com";
const EVENTS_URL = `${BASE_URL}/events`;
const DEFAULT_LOCATION = "Stanza Books";

// --- Define Helper Functions in Node Scope ---
function convert12to24(hour: string, min: string, period: string): string {
  let h = Number.parseInt(hour, 10);
  const isPM = period?.toUpperCase() === "PM";
  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0; // Midnight case
  return `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
}

function parseTime(timeStr: string | null | undefined): {
  start?: string;
  end?: string;
} {
  if (!timeStr) return {};
  const times = timeStr.split(/–|-|to/i).map((t) => t.trim());
  const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;

  const startTimeMatch = times[0]?.match(timeRegex);
  if (!startTimeMatch) return {};

  const start = convert12to24(
    startTimeMatch[1],
    startTimeMatch[2],
    startTimeMatch[3]
  );
  let end: string | undefined = undefined;

  if (times.length > 1) {
    const endTimeMatch = times[1]?.match(timeRegex);
    if (endTimeMatch) {
      let startPeriod = startTimeMatch[3];
      if (!startPeriod && endTimeMatch[3]) {
        const startH = Number.parseInt(startTimeMatch[1], 10);
        const endH = Number.parseInt(endTimeMatch[1], 10);
        const isEndPM = endTimeMatch[3].toUpperCase() === "PM";
        if (startH === 12) startPeriod = endTimeMatch[3];
        else if (startH < 12 && startH > endH && isEndPM) startPeriod = "AM";
        else startPeriod = endTimeMatch[3];
      }
      end = convert12to24(
        endTimeMatch[1],
        endTimeMatch[2],
        endTimeMatch[3] || startPeriod
      );
    }
  }
  return { start, end };
}
// --- End Helper Functions ---

/**
 * Scrapes events for a given date range from the Stanza Books events page,
 * navigating month by month through the calendar view.
 */
const scrapeStanzaBooksEvents = async (
  options: ScrapeOptions
): Promise<Event[]> => {
  const { startDate, endDate: inputEndDate, browser } = options;
  const endDate = inputEndDate || startDate;

  if (!browser) {
    throw new Error("A Puppeteer browser instance must be provided.");
  }

  const allFoundEvents: Event[] = []; // Store all valid events scraped before filtering
  let page: Page | undefined;

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatDate(
      startDate
    )} to ${formatDate(endDate)}...`
  );

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );
    console.log(`[${SCRAPER_ID}] Navigating to ${EVENTS_URL}...`);
    await page.goto(EVENTS_URL, { waitUntil: "networkidle0", timeout: 60000 });

    // --- Calendar Navigation Logic ---
    const targetStartMonth = startOfMonth(startDate);
    const targetEndMonth = startOfMonth(endDate);
    const uniqueEventPaths = new Set<string>();

    // Helper to get current calendar month/year (needs robust selector)
    const getCurrentCalendarMonthYear = async (
      page: Page
    ): Promise<Date | null> => {
      try {
        // Selector for the calendar title (e.g., "March 2025")
        const calendarTitleSelector = ".yui3-calendar-header-label";
        await page.waitForSelector(calendarTitleSelector, { timeout: 10000 });
        const titleText = await page.$eval(
          calendarTitleSelector,
          (el) => el.textContent
        );
        if (!titleText) return null;
        // Attempt to parse "Month Year" format
        return parseDate(titleText, "MMMM yyyy", new Date());
      } catch (e) {
        console.error(`[${SCRAPER_ID}] Error getting calendar month/year:`, e);
        return null;
      }
    };

    let currentCalendarDate = await getCurrentCalendarMonthYear(page);
    if (!currentCalendarDate) {
      throw new Error("Could not determine initial calendar month.");
    }
    console.log(
      `[${SCRAPER_ID}] Initial calendar month detected: ${formatDateFn(
        currentCalendarDate,
        "yyyy-MM"
      )}`
    );

    // Navigate to the target start month if necessary
    // Selectors for prev/next buttons using aria-label
    const prevButtonSelector = 'a[aria-label="Go to previous month"]';
    const nextButtonSelector = 'a[aria-label="Go to next month"]';

    while (isBefore(currentCalendarDate, targetStartMonth)) {
      console.log(
        `[${SCRAPER_ID}] Navigating forward to target start month...`
      );
      await page.click(nextButtonSelector);
      // Wait for title update (or other indicator)
      await page.waitForFunction(
        (selector, expectedMonthYear) => {
          const el = document.querySelector(selector);
          return el?.textContent?.includes(expectedMonthYear);
        },
        { timeout: 10000 },
        ".yui3-calendar-header-label", // Use updated title selector
        formatDateFn(addMonths(currentCalendarDate, 1), "MMMM yyyy")
      );
      currentCalendarDate =
        (await getCurrentCalendarMonthYear(page)) || currentCalendarDate; // Update or keep old on error
    }
    while (isBefore(targetStartMonth, currentCalendarDate)) {
      console.log(
        `[${SCRAPER_ID}] Navigating backward to target start month...`
      );
      await page.click(prevButtonSelector);
      await page.waitForFunction(
        (selector, expectedMonthYear) => {
          const el = document.querySelector(selector);
          return el?.textContent?.includes(expectedMonthYear);
        },
        { timeout: 10000 },
        ".yui3-calendar-header-label", // Use updated title selector
        formatDateFn(addMonths(currentCalendarDate, -1), "MMMM yyyy")
      );
      currentCalendarDate =
        (await getCurrentCalendarMonthYear(page)) || currentCalendarDate;
    }

    console.log(
      `[${SCRAPER_ID}] Reached target start month: ${formatDateFn(
        currentCalendarDate,
        "yyyy-MM"
      )}`
    );

    // Loop through months in range, scraping links
    while (
      currentCalendarDate &&
      (isSameMonth(currentCalendarDate, targetEndMonth) ||
        isBefore(currentCalendarDate, targetEndMonth))
    ) {
      const currentMonthStr = formatDateFn(currentCalendarDate, "yyyy-MM");
      console.log(
        `[${SCRAPER_ID}] Scraping links for month: ${currentMonthStr}`
      );

      const pathsThisMonth = await page.$$eval(
        '.sqs-block-calendar a[href^="/events/"]',
        (links) => {
          const uniqueHrefs = new Set(
            links
              .map((a) => a.getAttribute("href"))
              .filter((href) => href !== null)
          );
          return Array.from(uniqueHrefs) as string[];
        }
      );
      for (const path of pathsThisMonth) {
        uniqueEventPaths.add(path);
      }
      console.log(
        `[${SCRAPER_ID}] Found ${pathsThisMonth.length} links (${uniqueEventPaths.size} total unique).`
      );

      // Navigate to next month if needed
      if (isBefore(currentCalendarDate, targetEndMonth)) {
        const nextMonthDate: Date = addMonths(currentCalendarDate, 1);
        const nextMonthStr = formatDateFn(nextMonthDate, "MMMM yyyy");
        console.log(
          `[${SCRAPER_ID}] Clicking next month to reach ${nextMonthStr}...`
        );
        await page.click(nextButtonSelector);
        await page.waitForFunction(
          (selector, expectedMonthYear) => {
            const el = document.querySelector(selector);
            return el?.textContent?.includes(expectedMonthYear);
          },
          { timeout: 10000 },
          ".yui3-calendar-header-label", // Use updated title selector
          formatDateFn(addMonths(currentCalendarDate, 1), "MMMM yyyy")
        );
        currentCalendarDate = nextMonthDate; // Assume success for loop condition
      } else {
        break; // Reached the end month
      }
    }
    // --- End Calendar Navigation ---

    const eventPaths = Array.from(uniqueEventPaths);
    console.log(
      `[${SCRAPER_ID}] Total unique event paths extracted: ${eventPaths.length}`
    );

    // --- Visit Each Event Page and Extract Details ---
    for (const eventPath of eventPaths) {
      try {
        // CHECK eventPath validity early
        if (!eventPath || typeof eventPath !== "string") {
          console.warn(
            `[${SCRAPER_ID}] Skipping invalid event path: ${eventPath}`
          );
          continue;
        }

        const eventUrl = `${BASE_URL}${eventPath}`;
        console.log(
          `[${SCRAPER_ID}] Navigating to event detail page: ${eventUrl}`
        );
        await page.goto(eventUrl, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });

        // --- LOGGING PARENT HTML ---
        // [Remove logging block]
        // --- END LOGGING ---

        // Use more specific selectors for event detail page
        const title = await page.$eval(".eventitem-title", (el) =>
          el.textContent?.trim()
        );
        // Get date string directly
        const dateStr = await page
          .$eval("li.eventitem-meta-date time[datetime]", (el) =>
            el.getAttribute("datetime")
          )
          .catch(() => null);

        // Get time strings directly from their list item
        const startTimeStrRaw = await page
          .$eval(
            "li.eventitem-meta-time .event-time-localized-start",
            (el) => el.innerHTML
          )
          .catch(() => null);
        const endTimeStrRaw = await page
          .$eval(
            "li.eventitem-meta-time .event-time-localized-end",
            (el) => el.innerHTML
          )
          .catch(() => null);

        // console.log(`[${SCRAPER_ID}] Raw Time HTML - Start: '${startTimeStrRaw}', End: '${endTimeStrRaw}'`); // Remove Log

        // Clean the HTML
        const startTimeStr = startTimeStrRaw?.replace(/&nbsp;/g, " ").trim();
        const endTimeStr = endTimeStrRaw?.replace(/&nbsp;/g, " ").trim();
        // console.log(`[${SCRAPER_ID}] Cleaned Time Strings - Start: '${startTimeStr}', End: '${endTimeStr}'`); // Remove Log

        const descriptionHtml = await page.$eval(
          ".eventitem-column-content .sqs-layout",
          (el) => el.innerHTML
        );

        if (!title || !dateStr) {
          console.warn(
            `[${SCRAPER_ID}] Skipping event page ${eventUrl} due to missing title or date string.`
          );
          continue;
        }

        // Parse time using Node-scope helper - adjust logic for separate start/end
        // For now, just use startTimeStr, will refine endTime logic later if needed
        const { start: startTime } = parseTime(startTimeStr); // parseTime needs adjustment or replacement
        const { start: endTime } = endTimeStr
          ? parseTime(endTimeStr)
          : { start: undefined }; // Basic parsing for end time

        if (!startTime) {
          console.warn(
            `[${SCRAPER_ID}] Could not parse start time "${
              startTimeStr ?? ""
            }" for event: ${title}`
          );
          continue;
        }

        // Process Description and Location
        const description = convertHtmlToMarkdown(descriptionHtml || "");
        let location = DEFAULT_LOCATION;
        // Refined Regex: Match non-tag/newline characters after "At the "
        const locationMatch = descriptionHtml?.match(
          /At the ([^<\n]+)(?:<br|<p|\n)/i
        );
        if (locationMatch?.[1]) {
          location = locationMatch[1]
            .replace(/\(map\)/i, "") // Remove (map) specifically
            .trim();
        } else if (descriptionHtml?.includes("Howland Cultural Center")) {
          location = "Howland Cultural Center";
        }
        // Log final location before constructing event object
        console.log(
          `[${SCRAPER_ID}] Final location for "${title}": "${location}"`
        );

        // Log the path and constructed URL before creating the object
        console.log(
          `[${SCRAPER_ID}] Path: ${eventPath}, Constructed URL: ${eventUrl}`
        );

        // Construct the event object
        const eventData: Event = {
          title: title,
          description: description,
          start_at: formatISO(
            parseDate(
              `${dateStr}T${startTime}`,
              "yyyy-MM-dd'T'HH:mm:ss",
              new Date()
            )
          ),
          url: eventUrl,
          location: location,
          external_id: `${SCRAPER_ID}-${eventPath.split("/").pop()}`,
          ...(endTime
            ? {
                end_at: formatISO(
                  parseDate(
                    `${dateStr}T${endTime}`,
                    "yyyy-MM-dd'T'HH:mm:ss",
                    new Date()
                  )
                ),
              }
            : {}),
        };

        allFoundEvents.push(eventData); // Add event before date filtering
      } catch (detailError) {
        console.error(
          `[${SCRAPER_ID}] Error processing event page ${eventPath}:`,
          detailError
        );
      }
    } // --- End loop over event paths ---

    console.log(
      `[${SCRAPER_ID}] Successfully scraped details for ${allFoundEvents.length} events.`
    );

    // --- Filter Events by Date Range ---
    const dateInterval = {
      start: startOfDay(startDate),
      end: endOfDay(endDate),
    };
    const filteredEvents = allFoundEvents.filter((event) => {
      try {
        // Use native Date constructor for ISO strings
        const eventStartDate = new Date(event.start_at);

        // Add logging for parsed date validity
        // console.log(`[${SCRAPER_ID}] Parsed filter date for "${event.title}": ${eventStartDate}, Valid: ${isValidDate(eventStartDate)}`);

        return (
          isValidDate(eventStartDate) &&
          isWithinInterval(eventStartDate, dateInterval)
        );
      } catch (filterError) {
        console.error(
          `[${SCRAPER_ID}] Error parsing date for filtering event "${event.title}":`,
          filterError
        );
        return false;
      }
    });

    console.log(
      `[${SCRAPER_ID}] Found ${
        filteredEvents.length
      } events within the date range ${formatDate(startDate)} to ${formatDate(
        endDate
      )}.`
    );

    // Validate final filtered list
    try {
      const validationResult = EventsArraySchema.parse(filteredEvents);
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.length} events.`
      );
      return validationResult as Event[];
    } catch (validationError) {
      console.error(
        `[${SCRAPER_ID}] Zod validation failed for final event list:`
      );
      throw new Error(`[${SCRAPER_ID}] Event validation failed.`);
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] An unexpected error occurred:`, error);
    return [];
  } finally {
    if (page?.isClosed() === false) {
      await page.close();
    }
    // Runner manages closing the browser instance
  }
};

// Export the scraper object
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: DEFAULT_LOCATION, // Use default name for the scraper registry
  scrape: scrapeStanzaBooksEvents,
};

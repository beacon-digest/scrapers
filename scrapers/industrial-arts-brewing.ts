import type { Page } from "puppeteer";
import {
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
import { formatDate } from "../utils/date.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "industrial-arts-brewing";
const BASE_URL = "https://www.industrialartsbrewing.com";
const EVENTS_URL = `${BASE_URL}/pages/visit-us#mahina-app`;
const LOCATION_NAME = "Industrial Arts Brewing Company";
const TIME_ZONE = "America/New_York";

/**
 * Helper function to parse Industrial Arts date/time strings
 * Example formats: "Thu, 24 Jul" with "07:00 PM - 08:30 PM"
 */
function parseIndustrialArtsDateTime(
  dateText: string,
  timeText: string,
): {
  date?: string;
  startTime?: string;
  endTime?: string;
} {
  if (!dateText) return {};

  // Parse date format "Thu, 24 Jul" - need to add year
  const currentYear = new Date().getFullYear();
  const dateMatch = dateText.match(/(\w{3}), (\d{1,2}) (\w{3})/);

  if (!dateMatch) {
    console.warn(`[${SCRAPER_ID}] Could not parse date format: "${dateText}"`);
    return {};
  }

  const [, , day, month] = dateMatch;
  const monthNumber = getMonthNumber(month);
  const date = `${currentYear}-${monthNumber}-${day.padStart(2, "0")}`;

  // Parse time format "07:00 PM - 08:30 PM"
  let startTime: string | undefined;
  let endTime: string | undefined;

  if (timeText) {
    const timeMatch = timeText.match(
      /(\d{1,2}:\d{2} [AP]M)\s*-\s*(\d{1,2}:\d{2} [AP]M)/,
    );
    if (timeMatch) {
      const [, startTimeStr, endTimeStr] = timeMatch;
      startTime = convert12to24(startTimeStr);
      endTime = convert12to24(endTimeStr);
    } else {
      // Try single time format
      const singleTimeMatch = timeText.match(/(\d{1,2}:\d{2} [AP]M)/);
      if (singleTimeMatch) {
        startTime = convert12to24(singleTimeMatch[1]);
      }
    }
  }

  return { date, startTime, endTime };
}

/**
 * Helper to convert month name to number
 */
function getMonthNumber(monthName: string): string {
  const months: Record<string, string> = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    september: "09",
    sept: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };

  const lowerMonth = monthName?.toLowerCase();
  return lowerMonth ? months[lowerMonth] || "01" : "01";
}

/**
 * Helper to convert 12-hour time to 24-hour format
 */
function convert12to24(timeStr: string): string | undefined {
  const match = timeStr.match(/(\d{1,2}):(\d{2}) ([AP]M)/);
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
 * Generate a useful event description based on available information
 */
function generateEventDescription(
  title: string,
  dateText: string,
  timeText: string,
): string {
  // Process title to create type of event description
  let description: string;

  if (title.toLowerCase().includes("anniversary")) {
    description = `Join us for the ${title} at Industrial Arts Brewing Company. Live music, food, and great beer!`;
  } else if (title.includes(",")) {
    // If there are multiple bands/performers (comma-separated)
    const bands = title.split(",").map((band) => band.trim());
    if (bands.length > 1) {
      description = `Live music featuring ${bands.join(", ")} at Industrial Arts Brewing Company.`;
    } else {
      description = `Live music event at Industrial Arts Brewing Company featuring ${title}.`;
    }
  } else {
    description = `Live music event at Industrial Arts Brewing Company featuring ${title}.`;
  }

  // Add event date and time details
  description += `\n\nEvent Date: ${dateText}`;

  // Add time information if available
  if (timeText) {
    description += `\nEvent Time: ${timeText}`;
  }

  // Add venue info
  description += "\n\nLocation: 511 Fishkill Ave, Beacon, NY 12508";

  // Add info about tickets and performing artists
  if (title.toLowerCase().includes("music") || title.includes(",")) {
    description += "\n\n*Cover charges may apply. 100% of cover goes to performing artists.";
  }

  return description;
}

/**
 * Scrapes events from Industrial Arts Brewing Company
 */
async function scrapeIndustrialArtsBrewingEvents(
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

    console.log(`[${SCRAPER_ID}] Navigating to ${EVENTS_URL}`);
    await page.goto(EVENTS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Try to handle age verification
    try {
      const ageGateExists = await page.$("#age-gate");
      if (ageGateExists) {
        console.log(`[${SCRAPER_ID}] Handling age verification...`);
        await page.evaluate(() => {
          const yesButton = document.querySelector('#age-gate button:first-of-type');
          if (yesButton) (yesButton as HTMLElement).click();
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (e) {
      console.log(`[${SCRAPER_ID}] Error handling age verification: ${e}`);
    }

    // Wait for Mahina app to load
    console.log(`[${SCRAPER_ID}] Waiting for Mahina calendar app to load...`);
    try {
      await page.waitForSelector('#mahina-app', {
        timeout: 30000,
      });

      // Additional wait for events to appear - either by class or by typical event element pattern
      await page.waitForFunction(
        () => {
          return document.querySelector('#mahina-app')?.querySelectorAll('div[class*="event"], div > h3')?.length > 0;
        },
        { timeout: 30000 }
      );
    } catch (e) {
      console.error(`[${SCRAPER_ID}] Error waiting for events to load: ${e}`);
    }

    // Extract events from the Mahina calendar
    const rawEvents = await page.evaluate(() => {
      const mahinaApp = document.querySelector("#mahina-app");
      if (!mahinaApp) return [];

      // Try multiple selectors to find events
      const eventSelectors = [
        ".ma-event",
        "[class*='event']",
        "div[class*='ma-'] > div > h3", // Events might be identified by headings
        "div > div > h3" // Generic pattern for events
      ];

      let eventItems: Element[] = [];

      // Try each selector until we find events
      for (const selector of eventSelectors) {
        const items = mahinaApp.querySelectorAll(selector);
        if (items.length > 0) {
          eventItems = Array.from(items);
          // If we're selecting by heading, get the parent element that contains the full event
          if (selector.includes("h3")) {
            eventItems = eventItems.map(el => el.parentElement?.parentElement || el);
          }
          break;
        }
      }

      return eventItems
        .map((item) => {
          // Get title from h3
          const titleElement = item.querySelector("h3");
          const title = titleElement?.textContent?.trim() || "";

          // Get event ID from data attribute
          const eventId = item.getAttribute("data-id") || "";

          // Get full text content to help with date/time extraction
          const fullText = item.textContent?.replace(/\s+/g, " ").trim() || "";

          // Extract date text - try attributes first, then look for patterns
          let dateText = "";
          const dateElement = item.querySelector('[class*="date-slot"], [class*="date"]');
          if (dateElement) {
            dateText = dateElement.textContent?.trim() || "";
          } else {
            // Try to find date pattern in text
            const dateMatch = fullText.match(/(\w{3},\s+\d{1,2}\s+\w{3})/);
            if (dateMatch) dateText = dateMatch[1];
          }

          // Extract time - either from dedicated elements or from text patterns
          let timeText = "";
          const timeElements = item.querySelectorAll('[class*="time"]');

          if (timeElements.length >= 2) {
            const startTime = timeElements[0]?.textContent?.trim() || "";
            const endTime = timeElements[1]?.textContent?.trim() || "";
            if (startTime && endTime) {
              timeText = `${startTime} - ${endTime}`;
            }
          } else if (timeElements.length === 1) {
            timeText = timeElements[0]?.textContent?.trim() || "";
          } else {
            // Try to find time pattern in text
            const timeMatch = fullText.match(/(\d{1,2}:\d{2}\s*[AP]M)(?:\s*-\s*(\d{1,2}:\d{2}\s*[AP]M))?/i);
            if (timeMatch) {
              timeText = timeMatch[0];
            }
          }

          // Get image if available
          const img = item.querySelector("img");
          const imgSrc = img?.src || "";

          return {
            title,
            eventId,
            dateText,
            timeText,
            imgSrc,
            fullText
          };
        })
        .filter(event => event.title && (event.dateText || event.fullText.match(/\w{3},\s+\d{1,2}\s+\w{3}/)));
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
        // Try to extract date and time if not already found
        let dateText = rawEvent.dateText;
        let timeText = rawEvent.timeText;

        if (!dateText || !timeText) {
          // Try to extract from full text
          const dateMatch = rawEvent.fullText.match(/(\w{3},\s+\d{1,2}\s+\w{3})/);
          if (dateMatch) dateText = dateMatch[1];

          const timeMatch = rawEvent.fullText.match(/(\d{1,2}:\d{2}\s*[AP]M)(?:\s*-\s*(\d{1,2}:\d{2}\s*[AP]M))?/i);
          if (timeMatch) timeText = timeMatch[0];
        }

        if (!dateText) {
          console.warn(
            `[${SCRAPER_ID}] Could not find date for event: ${rawEvent.title}`,
          );
          continue;
        }

        // Parse the date and time
        const { date, startTime, endTime } = parseIndustrialArtsDateTime(
          dateText,
          timeText,
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

        // Generate a description based on the available info
        const description = generateEventDescription(
          rawEvent.title,
          dateText,
          timeText
        );

        // Generate external ID
        const external_id = rawEvent.eventId
          ? `${SCRAPER_ID}-${rawEvent.eventId}`
          : `${SCRAPER_ID}-${date?.replace(/-/g, "")}-${rawEvent.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .substring(0, 30)}`;

        // Create the event object
        const event: Event = {
          title: decode(rawEvent.title),
          description: description,
          start_at: startAtIso,
          end_at: endAtIso,
          url: rawEvent.eventId
            ? `${BASE_URL}/pages/visit-us#?event-id=${rawEvent.eventId}`
            : EVENTS_URL,
          location: LOCATION_NAME,
          external_id: external_id,
        };

        events.push(event);
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
  scrape: scrapeIndustrialArtsBrewingEvents,
};

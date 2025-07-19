import type { Browser, Page } from "puppeteer";
import {
  format,
  parse as parseDate,
  isValid as isValidDate,
  isWithinInterval,
  startOfDay,
  endOfDay,
  formatISO,
} from "date-fns";
import { toDate } from "date-fns-tz";
import { decode } from "html-entities";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";
import { formatDate } from "../utils/date.js";

const SCRAPER_ID = "savage-wonder";
const LOCATION_NAME = "Savage Wonder";
const BASE_URL = "https://savagewonder.org";
const CALENDAR_URL = `${BASE_URL}/calendar/`;
const TIME_ZONE = "America/New_York";

interface RawEventData {
  title: string;
  dateTimeString: string;
  description: string;
  url: string;
  external_id: string;
}

/**
 * Helper function to parse Savage Wonder date/time strings
 * Example formats: "May 30 @ 8:00 pm - 9:30 pm", "June 7 @ 7:00 pm - 9:00 pm"
 */
function parseSavageWonderDateTime(dateTimeString: string): {
  date?: string;
  startTime?: string;
  endTime?: string;
} {
  if (!dateTimeString) return {};

  // Clean up the string - remove extra whitespace and normalize
  const cleanedString = dateTimeString.replace(/\s+/g, " ").trim();

  // Pattern for "Month Day @ Time - Time"
  const mainPattern =
    /([A-Za-z]+)\s+(\d{1,2})\s+@\s+(\d{1,2}):(\d{2})\s+([ap]m)(?:\s*-\s*(\d{1,2}):(\d{2})\s+([ap]m))?/i;

  let match = cleanedString.match(mainPattern);

  // Try alternative patterns if main pattern fails
  if (!match) {
    // Try pattern with different separators or spacing
    const altPattern =
      /([A-Za-z]+)\s+(\d{1,2}).*?(\d{1,2}):(\d{2})\s*([ap]m)(?:.*?(\d{1,2}):(\d{2})\s*([ap]m))?/i;
    match = cleanedString.match(altPattern);
  }

  if (!match) {
    console.warn(
      `[${SCRAPER_ID}] Could not parse date/time: "${dateTimeString}"`,
    );
    return {};
  }

  const [
    ,
    month,
    day,
    startHour,
    startMin,
    startPeriod,
    endHour,
    endMin,
    endPeriod,
  ] = match;

  // Construct date (assume current year, but handle year transitions)
  const now = new Date();
  let year = now.getFullYear();
  const monthNumber = getMonthNumber(month);
  const eventMonth = parseInt(monthNumber, 10);
  const currentMonth = now.getMonth() + 1;

  // If event month is significantly before current month, assume next year
  if (eventMonth < currentMonth - 6) {
    year += 1;
  }

  const date = `${year}-${monthNumber}-${day.padStart(2, "0")}`;

  let startTime: string | undefined;
  let endTime: string | undefined;

  if (startHour && startMin && startPeriod) {
    startTime = convert12to24(startHour, startMin, startPeriod);
  }

  if (endHour && endMin && endPeriod) {
    endTime = convert12to24(endHour, endMin, endPeriod);
  }

  return { date, startTime, endTime };
}

/**
 * Helper to convert month name to number
 */
function getMonthNumber(monthName: string): string {
  const months: Record<string, string> = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };

  const lowerMonth = monthName?.toLowerCase();
  return lowerMonth ? months[lowerMonth] || "01" : "01";
}

/**
 * Helper to convert 12-hour time to 24-hour format
 */
function convert12to24(hour: string, min: string, period: string): string {
  let h = Number.parseInt(hour, 10);
  if (Number.isNaN(h)) {
    console.warn(`[${SCRAPER_ID}] Invalid hour value: ${hour}`);
    h = 12;
  }

  const isPM = period?.toLowerCase() === "pm";

  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0; // Midnight case

  return `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
}

/**
 * Helper to combine date and time into ISO string
 */
function combineToISOString(date: string, time: string): string | undefined {
  try {
    // Validate date components before creating the date
    const [year, month, day] = date.split("-").map(Number);
    const testDate = new Date(year, month - 1, day);

    // Check if the date is valid (e.g., June 31 would become July 1)
    if (
      testDate.getFullYear() !== year ||
      testDate.getMonth() !== month - 1 ||
      testDate.getDate() !== day
    ) {
      console.warn(
        `[${SCRAPER_ID}] Invalid date components: ${date} (would become ${testDate.toISOString().split("T")[0]})`,
      );
      return undefined;
    }

    const dateTimeString = `${date}T${time}`;
    const dateObj = toDate(dateTimeString, { timeZone: TIME_ZONE });
    if (!isValidDate(dateObj)) {
      console.warn(
        `[${SCRAPER_ID}] Invalid date constructed from ${dateTimeString}`,
      );
      return undefined;
    }
    return formatISO(dateObj);
  } catch (error) {
    console.error(`[${SCRAPER_ID}] Error creating date:`, error);
    return undefined;
  }
}

/**
 * Scrapes events from the Savage Wonder calendar
 */
async function scrapeSavageWonderEvents(
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
    // Set realistic browser settings to avoid detection
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    // Set additional headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      DNT: "1",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    });

    // Set viewport to common desktop size
    await page.setViewport({ width: 1366, height: 768 });

    console.log(`[${SCRAPER_ID}] Navigating to ${CALENDAR_URL}`);
    await page.goto(CALENDAR_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    // Check for Cloudflare challenge and wait for it to complete
    console.log(`[${SCRAPER_ID}] Checking for Cloudflare challenge...`);
    const hasCloudflare = await page.evaluate(() => {
      return (
        document.body.innerHTML.includes("Just a moment") ||
        document.body.innerHTML.includes("Verify you are human") ||
        document.body.innerHTML.includes("cf-turnstile") ||
        document.body.innerHTML.includes("Cloudflare")
      );
    });

    if (hasCloudflare) {
      console.log(
        `[${SCRAPER_ID}] Cloudflare challenge detected, waiting for completion...`,
      );

      // Wait for the challenge to complete (look for calendar content to appear)
      try {
        await page.waitForFunction(
          () => {
            const body = document.body.innerHTML;
            return (
              !body.includes("Just a moment") &&
              !body.includes("Verify you are human") &&
              (body.includes("Calendar") ||
                body.includes("event") ||
                body.includes("calendar"))
            );
          },
          { timeout: 30000 },
        );

        console.log(
          `[${SCRAPER_ID}] Cloudflare challenge completed, proceeding...`,
        );

        // Wait a bit more for the page to fully load
        (await page.waitForLoadState?.("networkidle")) ||
          new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (e) {
        console.warn(
          `[${SCRAPER_ID}] Cloudflare challenge may not have completed, attempting to continue...`,
        );
      }
    } else {
      console.log(`[${SCRAPER_ID}] No Cloudflare challenge detected`);
      // Wait for network to be idle
      (await page.waitForLoadState?.("networkidle")) ||
        new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Wait for page content to load - try multiple possible selectors
    const possibleSelectors = [
      ".tribe-events-calendar",
      ".calendar",
      "#calendar",
      "[class*='calendar']",
      "[class*='event']",
      "main",
    ];

    let foundSelector = null;
    for (const selector of possibleSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        foundSelector = selector;
        console.log(`[${SCRAPER_ID}] Found content with selector: ${selector}`);
        break;
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!foundSelector) {
      console.log(
        `[${SCRAPER_ID}] No standard selectors found, will try to parse entire page`,
      );
    }

    // Check if we're still on the Cloudflare page
    const stillCloudflare = await page.evaluate(() => {
      const body = document.body.innerHTML;
      return (
        body.includes("Just a moment") || body.includes("Verify you are human")
      );
    });

    if (stillCloudflare) {
      console.error(
        `[${SCRAPER_ID}] Still on Cloudflare challenge page, cannot proceed`,
      );
      return [];
    }

    // Debug: log page HTML to see structure
    const pageHTML = await page.evaluate(() => {
      return document.body.innerHTML.substring(0, 5000); // First 5000 chars
    });
    console.log(
      `[${SCRAPER_ID}] Page HTML preview:`,
      pageHTML.substring(0, 500) + "...",
    );

    // Debug: log all elements that might contain events
    const debugInfo = await page.evaluate(() => {
      try {
        const allElements = document.querySelectorAll("*");
        const eventRelated = [];
        for (const el of allElements) {
          try {
            const text = el.textContent || "";
            const className = el.className ? String(el.className) : "";
            if (
              (text.includes("@") &&
                (text.includes("pm") || text.includes("am"))) ||
              className.includes("event") ||
              className.includes("calendar") ||
              text.includes("Purchase Tickets")
            ) {
              eventRelated.push({
                tag: el.tagName,
                class: className,
                text: text.substring(0, 100),
              });
            }
          } catch (innerErr) {
            // Skip problematic elements
          }
        }
        return eventRelated.slice(0, 20); // First 20 matches
      } catch (err) {
        return [{ error: err.message }];
      }
    });
    console.log(`[${SCRAPER_ID}] Event-related elements found:`, debugInfo);

    // Extract events from the calendar by using DOM selectors
    const rawEvents = await page.evaluate(
      (scraperId, locationName) => {
        try {
          const eventsList: RawEventData[] = [];

          // Find all event articles in the calendar grid using proper HTML selectors
          const eventArticles = Array.from(
            document.querySelectorAll('[role="gridcell"] article'),
          );
          console.log(
            `[${scraperId}] Found ${eventArticles.length} event articles`,
          );

          eventArticles.forEach((article, index) => {
            try {
              // Extract event title from heading
              const titleHeading = article.querySelector("h3");
              const titleLink = titleHeading?.querySelector("a");
              const title =
                titleLink?.textContent?.trim() ||
                titleHeading?.textContent?.trim();

              if (!title || title.length < 3) {
                console.log(
                  `[${scraperId}] Skipping article ${index} - no valid title found`,
                );
                return;
              }

              // Extract event URL
              let eventUrl = window.location.href; // Default to calendar URL
              if (titleLink) {
                const href = titleLink.getAttribute("href");
                if (href) {
                  eventUrl = href.startsWith("http")
                    ? href
                    : new URL(href, window.location.origin).toString();
                }
              }

              // Extract time information
              const timeElements = Array.from(article.querySelectorAll("time"));
              if (timeElements.length === 0) {
                console.log(
                  `[${scraperId}] Skipping "${title}" - no time elements found`,
                );
                return;
              }

              let startTime = "";
              let endTime = "";

              if (timeElements.length >= 2) {
                // Two separate time elements (start and end)
                startTime = timeElements[0].textContent?.trim() || "";
                endTime = timeElements[1].textContent?.trim() || "";
              } else {
                // Single time element - extract times from surrounding text
                const timeContainer = timeElements[0].parentElement;
                if (timeContainer) {
                  const timeText = timeContainer.textContent || "";
                  // Look for pattern like "7:00 pm - 9:00 pm"
                  const timeMatch = timeText.match(
                    /(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i,
                  );
                  if (timeMatch) {
                    startTime = timeMatch[1];
                    endTime = timeMatch[2];
                  } else {
                    startTime = timeElements[0].textContent?.trim() || "";
                  }
                }
              }

              // Extract date from the grid cell
              const gridCell = article.closest('[role="gridcell"]');
              const dayHeading = gridCell?.querySelector("h3");
              const dayTime = dayHeading?.querySelector("time");
              const dayNumber = dayTime?.textContent?.trim();

              if (!dayNumber) {
                console.log(
                  `[${scraperId}] Skipping "${title}" - no day number found`,
                );
                return;
              }

              // Get current month and year from the calendar header
              const monthYearElement = document.querySelector("time");
              const monthYearText = monthYearElement?.textContent?.trim() || "";
              const monthYearMatch = monthYearText.match(/(\w+)\s+(\d{4})/);

              let month = "";
              let year = "";
              if (monthYearMatch) {
                month = monthYearMatch[1];
                year = monthYearMatch[2];
              } else {
                // Fallback to current date
                const now = new Date();
                month = now.toLocaleString("default", { month: "long" });
                year = now.getFullYear().toString();
              }

              // Create date time string
              const dateTimeString =
                startTime && endTime
                  ? `${month} ${dayNumber} @ ${startTime} - ${endTime}`
                  : `${month} ${dayNumber} @ ${startTime}`;

              // Generate external ID
              const dateSlug = `${month}-${dayNumber}`
                .toLowerCase()
                .replace(/\s+/g, "-");
              const titleSlug = title
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, "")
                .replace(/\s+/g, "-")
                .slice(0, 30);
              const externalId = `${scraperId}-${dateSlug}-${titleSlug}`;

              console.log(
                `[${scraperId}] Found event: "${title}" on "${dateTimeString}" URL: ${eventUrl}`,
              );
              eventsList.push({
                title: title,
                dateTimeString: dateTimeString,
                description: "",
                url: eventUrl,
                external_id: externalId,
              });
            } catch (err) {
              console.error(
                `[${scraperId}] Error processing article ${index}:`,
                err.message,
              );
            }
          });

          return eventsList;
        } catch (err) {
          console.error(
            `[${scraperId}] Error in page evaluation:`,
            err.message,
          );
          return [];
        }
      },
      SCRAPER_ID,
      LOCATION_NAME,
    );

    console.log(
      `[${SCRAPER_ID}] Found ${rawEvents.length} raw events. Processing...`,
    );

    // Define the date range for filtering
    const dateInterval = {
      start: startOfDay(startDate),
      end: endOfDay(endDate),
    };

    // Deduplicate events by external_id
    const uniqueRawEvents = rawEvents.filter(
      (event, index, self) =>
        index === self.findIndex((e) => e.external_id === event.external_id),
    );

    console.log(
      `[${SCRAPER_ID}] After deduplication: ${uniqueRawEvents.length} unique events`,
    );

    // Process each raw event
    for (const rawEvent of uniqueRawEvents) {
      try {
        // Parse the date and time
        const { date, startTime, endTime } = parseSavageWonderDateTime(
          rawEvent.dateTimeString,
        );

        // Create ISO date strings
        const startAtIso = combineToISOString(date, startTime);
        const endAtIso = combineToISOString(date, endTime);

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
            `[${SCRAPER_ID}] Event outside date range: ${rawEvent.title} on ${format(eventDate, "yyyy-MM-dd")}`,
          );
          continue;
        }

        // Set description to empty string for now
        const description = "";

        // Create the event object
        const event: Event = {
          title: decode(rawEvent.title),
          description: description,
          start_at: startAtIso,
          end_at: endAtIso,
          url: rawEvent.url,
          location: LOCATION_NAME,
          external_id: rawEvent.external_id,
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
  scrape: scrapeSavageWonderEvents,
};

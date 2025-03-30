import type { Browser } from "puppeteer";
import { format } from "date-fns";
import { decode } from "html-entities";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { getDatesInRange, formatDate } from "../utils/date.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";
// Note: We assume the runner will provide the browser instance via options.
// If this scraper were to be run standalone, it would need utils/browser.js
// import { getBrowserInstance, closeBrowserInstance } from "../utils/browser.js";

const BASE_URL = "https://beaconlibrary.assabetinteractive.com/calendar";
const SCRAPER_ID = "howland-library";
const LOCATION_NAME = "Howland Public Library";

/**
 * Scrapes events for a given date range from the Howland Public Library calendar.
 */
const scrapeHowlandLibraryEvents = async (
  options: ScrapeOptions
): Promise<Event[]> => {
  const { startDate, endDate, browser } = options;

  if (!browser) {
    throw new Error("A Puppeteer browser instance must be provided.");
  }

  const datesToScrape = getDatesInRange(startDate, endDate);
  const allEvents: Event[] = [];
  let page: import("puppeteer").Page | undefined; // Declare page outside the loop with explicit type

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatDate(
      startDate
    )} to ${formatDate(endDate || startDate)}...`
  );

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" // Set a common user agent
    );

    for (const targetDate of datesToScrape) {
      const formattedMonthUrl = format(targetDate, "yyyy-MMMM").toLowerCase();
      const calendarUrl = `${BASE_URL}/${formattedMonthUrl}`;
      const targetDateString = formatDate(targetDate); // YYYY-MM-DD

      console.log(`[${SCRAPER_ID}] Processing date: ${targetDateString}`);
      console.log(
        `[${SCRAPER_ID}] Navigating to calendar month: ${calendarUrl}`
      );

      try {
        await page.goto(calendarUrl, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });

        // Wait for calendar script data to load
        await page.waitForSelector("script[type='application/ld+json']", {
          timeout: 60000,
        });

        console.log(
          `[${SCRAPER_ID}] Calendar month loaded, extracting events for ${targetDateString}...`
        );

        // Extract JSON-LD scripts for the target date
        const eventsForDate = await page.evaluate(
          (dateStr, scraperId, locationName) => {
            const scripts = Array.from(
              document.querySelectorAll("script[type='application/ld+json']")
            );
            const eventsList: Partial<Event>[] = []; // Use Partial initially

            for (const script of scripts) {
              try {
                const data = JSON.parse(script.textContent || "");
                // Ensure data.startDate matches the specific target date string (YYYY-MM-DD)
                if (data["@type"] === "Event" && data.startDate === dateStr) {
                  // Extract original external_id from URL
                  const originalId = data.url
                    ? data.url.split("/").filter(Boolean).pop() || ""
                    : "";

                  const event: Partial<Event> = {
                    title: data.name,
                    description: data.description || "", // Placeholder
                    // Temporary placeholders for dates/times
                    start_at: `${data.startDate}T00:00:00Z`,
                    end_at: data.endDate
                      ? `${data.endDate}T23:59:59Z`
                      : undefined,
                    url: data.url || "",
                    location: locationName, // Use passed location name
                    external_id: `${scraperId}-${originalId}`, // Prefix ID
                  };
                  eventsList.push(event);
                }
              } catch (e) {
                console.error(
                  `[${scraperId}] Error parsing JSON-LD event data:`,
                  e
                );
              }
            }
            return eventsList;
          },
          targetDateString,
          SCRAPER_ID,
          LOCATION_NAME
        );

        console.log(
          `[${SCRAPER_ID}] Found ${eventsForDate.length} potential events on ${targetDateString}. Fetching details...`
        );

        // Get full details for each event found
        for (const event of eventsForDate) {
          if (event.url) {
            try {
              console.log(
                `[${SCRAPER_ID}] Navigating to event page: ${event.url}`
              );
              await page.goto(event.url, {
                waitUntil: "networkidle0",
                timeout: 60000,
              });

              await page.waitForSelector(".event-description", {
                timeout: 60000,
              });

              // --- Get Date and Time ---
              let headerText = "";
              try {
                headerText = await page.$eval(
                  "h3.event-meta",
                  (el) => el.textContent || ""
                );
              } catch {
                console.warn(
                  `[${SCRAPER_ID}] Could not find event meta header (h3.event-meta) on ${event.url}`
                );
              }

              let eventDate = targetDateString; // Default to the target date

              const headerDateMatch = headerText.match(
                /([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})/
              );
              if (headerDateMatch) {
                const [, , month, day] = headerDateMatch;
                const year = targetDate.getFullYear(); // Use year from targetDate
                const monthNumber = getMonthNumber(month);
                if (monthNumber) {
                  eventDate = `${year}-${monthNumber}-${day.padStart(2, "0")}`;
                }
              }

              const timeText = await page.$eval(
                "span.event-time",
                (el) => el.textContent || ""
              );

              const { startTime, endTime } = parseTimeText(timeText);

              if (startTime) {
                event.start_at = new Date(
                  `${eventDate}T${startTime}`
                ).toISOString();
              } else {
                // Fallback if time parsing fails - keep placeholder or set to start of day?
                console.warn(
                  `[${SCRAPER_ID}] Could not parse start time from "${timeText}" for event: ${event.title}`
                );
                // Optionally default to start of day:
                event.start_at = new Date(
                  `${eventDate}T00:00:00`
                ).toISOString();
              }

              if (endTime) {
                event.end_at = new Date(
                  `${eventDate}T${endTime}`
                ).toISOString();
              } else {
                event.end_at = undefined; // Ensure end_at is undefined if not parsed
              }

              // --- Get Description ---
              const descriptionHtml = await page.$eval(
                ".event-description",
                (el) => el.innerHTML
              );
              event.description = convertHtmlToMarkdown(descriptionHtml);

              // --- Decode Title ---
              if (event.title) {
                event.title = decode(event.title);
              }

              // Add the fully processed event
              allEvents.push(event as Event); // Cast to Event after processing
            } catch (detailError) {
              console.error(
                `[${SCRAPER_ID}] Error fetching details for event ${event.title} (${event.url}):`,
                detailError
              );
            }
          } else {
            console.warn(
              `[${SCRAPER_ID}] Event "${event.title}" has no URL, skipping detail fetching.`
            );
          }
        } // End loop for fetching event details
      } catch (monthError) {
        console.error(
          `[${SCRAPER_ID}] Error processing date ${targetDateString}:`,
          monthError
        );
        // Continue to the next date
      }
    } // End loop for dates

    console.log(
      `[${SCRAPER_ID}] Finished scraping. Found ${allEvents.length} total events.`
    );

    // Validate all collected events
    try {
      const validationResult = EventsArraySchema.parse(allEvents);
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.length} events.`
      );
      return validationResult as Event[]; // Type assertion is safe after validation
    } catch (validationError) {
      console.error(`[${SCRAPER_ID}] Zod validation error:`, validationError);
      // Decide how to handle: return partially valid events, return [], or throw
      // For now, throwing an error to indicate failure
      throw new Error(
        `[${SCRAPER_ID}] Event validation failed: ${JSON.stringify(
          validationError
        )}`
      );
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] An unexpected error occurred:`, error);
    // Depending on requirements, could return [], or rethrow
    return []; // Return empty array on major failure
  } finally {
    // Close the page if it was opened
    if (page && !page.isClosed()) {
      await page.close();
    }
    // IMPORTANT: We do NOT close the browser here.
    // The runner script that called this function is responsible for closing
    // the shared browser instance when all scraping is done.
  }
};

// --- Helper Functions ---

/**
 * Converts month name to zero-padded number string (e.g., "April" -> "04").
 */
function getMonthNumber(monthName: string): string | null {
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
  };
  const lowerMonth = monthName?.toLowerCase();
  return lowerMonth ? months[lowerMonth] || null : null;
}

/**
 * Parses time string like "10:00 AM—1:00 PM" or "7-8 PM" into start and end times.
 * Returns { startTime: "HH:mm:ss", endTime: "HH:mm:ss" } in 24-hour format.
 */
function parseTimeText(timeText: string): {
  startTime?: string;
  endTime?: string;
} {
  if (!timeText) return {};

  // Tries different regex patterns to match common time formats

  // Format: "10:00 AM—1:00 PM" (handles different separators: —, -, to)
  let match = timeText.match(
    /(\d{1,2}):(\d{2})\s*(AM|PM)(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i
  );
  if (match) {
    const [, startHour, startMin, startPeriod, endHour, endMin, endPeriod] =
      match;
    return {
      startTime: convert12to24(startHour, startMin, startPeriod),
      endTime: convert12to24(endHour, endMin, endPeriod),
    };
  }

  // Format: "12:00—2:30 PM" (single AM/PM marker at the end)
  match = timeText.match(
    /(\d{1,2}):(\d{2})(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i
  );
  if (match) {
    const [, startHour, startMin, endHour, endMin, period] = match;
    const isEndPM = period.toUpperCase() === "PM";
    // Determine if start time is AM or PM - assumes start time is AM unless end time is also AM or start hour is 12
    // This logic can be ambiguous. Assumes start is before end.
    const startH = Number.parseInt(startHour, 10);
    const endH = Number.parseInt(endHour, 10);
    // Basic assumption: If end is PM, start is likely AM unless start hour > end hour (e.g. 10 PM - 1 AM), or start=12
    // More robust: If start hour >= end hour (and not 12), and end is PM, start is likely PM too. If end is AM, start must be AM.
    let isStartPM = isEndPM;
    if (startH < 12 && startH > endH && isEndPM) {
      // e.g. 10 (AM) - 1 (PM)
      isStartPM = !isEndPM;
    } else if (startH === 12) {
      // 12 PM is PM, 12 AM is AM
      isStartPM = isEndPM; // Simplified: If end is PM, 12 is PM. If end is AM, 12 is AM (unlikely range like 12AM-8AM?)
    } else if (startH >= endH && isEndPM) {
      // e.g. 2 PM - 4 PM or 11 PM - 1 AM (end is AM here though)
      // This case is tricky without knowing AM/PM for start implicitly
      // Let's refine: If startH >= endH, assume start period is the one *before* end period unless startH==12
      if (startH >= endH && startH !== 12) {
        isStartPM = !isEndPM;
      }
      // else if startH == 12, already handled
      else {
        isStartPM = isEndPM;
      }
    }

    return {
      startTime: convert12to24(startHour, startMin, isStartPM ? "PM" : "AM"),
      endTime: convert12to24(endHour, endMin, isEndPM ? "PM" : "AM"),
    };
  }

  // Format: "7-8 PM" or "7 AM - 8 AM" (handles different separators)
  match = timeText.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?(?:—|-|\s+to\s+)(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i
  );
  if (match) {
    let [
      ,
      startHour,
      startMin = "00",
      startPeriod,
      endHour,
      endMin = "00",
      endPeriod,
    ] = match;
    // If startPeriod is missing, infer from endPeriod based on hours
    if (!startPeriod) {
      const startH = Number.parseInt(startHour, 10);
      const endH = Number.parseInt(endHour, 10);
      const isEndPM = endPeriod.toUpperCase() === "PM";
      if (startH === 12) startPeriod = endPeriod; // Assume 12 PM - 1 PM etc.
      else if (startH < 12 && startH > endH && isEndPM)
        startPeriod = "AM"; // e.g. 10 - 1 PM -> start=AM
      else if (startH >= endH && !isEndPM)
        startPeriod = "AM"; // e.g. 10 - 8 AM -> start=AM (unlikely 10PM - 8AM?)
      else startPeriod = endPeriod; // Default assumption e.g., 7-8 PM -> start is PM
    }
    return {
      startTime: convert12to24(startHour, startMin, startPeriod),
      endTime: convert12to24(endHour, endMin, endPeriod),
    };
  }

  // Format: "7 PM" (single time) - Treat as start time only
  match = timeText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match) {
    const [, hour, min, period] = match;
    return { startTime: convert12to24(hour, min, period), endTime: undefined };
  }
  // Format: "7pm" (no space) - Treat as start time only
  match = timeText.match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (match) {
    const [, hour, min, period] = match;
    return { startTime: convert12to24(hour, min, period), endTime: undefined };
  }

  console.warn(`[${SCRAPER_ID}] Could not parse time text: "${timeText}"`);
  return {};
}

/**
 * Converts 12-hour time format parts to 24-hour format string "HH:mm:ss".
 */
function convert12to24(hour: string, min: string, period: string): string {
  let h = Number.parseInt(hour, 10);
  const isPM = period?.toUpperCase() === "PM";
  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0; // Midnight case
  return `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
}

// Export the scraper object conforming to the Scraper interface
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeHowlandLibraryEvents,
};

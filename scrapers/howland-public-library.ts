import type { Browser } from "puppeteer";
import { format } from "date-fns";
import { decode } from "html-entities";
import { toDate } from "date-fns-tz";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { getDatesInRange, formatDate } from "../utils/date.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";
import { logEventFound } from "../utils/logging.js";
// Note: We assume the runner will provide the browser instance via options.
// If this scraper were to be run standalone, it would need utils/browser.js
// import { getBrowserInstance, closeBrowserInstance } from "../utils/browser.js";

const BASE_URL = "https://beaconlibrary.assabetinteractive.com/calendar";
const SCRAPER_ID = "howland-library";
const LOCATION_NAME = "Howland Public Library";
const TIME_ZONE = "America/New_York";

/**
 * Scrapes events for a given date range from the Howland Public Library calendar.
 */
const scrapeHowlandLibraryEvents = async (
  options: ScrapeOptions,
): Promise<Event[]> => {
  const { startDate, endDate, browser } = options;

  if (!browser) {
    throw new Error("A Puppeteer browser instance must be provided.");
  }

  const datesToScrape = getDatesInRange(startDate, endDate);
  const allEvents: Event[] = [];
  let calendarPage: import("puppeteer").Page | undefined;
  let detailPage: import("puppeteer").Page | undefined;
  let loadedCalendarUrl: string | undefined;

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatDate(
      startDate,
    )} to ${formatDate(endDate || startDate)}...`,
  );

  try {
    calendarPage = await browser.newPage();
    detailPage = await browser.newPage();
    await calendarPage.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36", // Set a common user agent
    );
    await detailPage.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    );

    for (const targetDate of datesToScrape) {
      const formattedMonthUrl = format(targetDate, "yyyy-MMMM").toLowerCase();
      const calendarUrl = `${BASE_URL}/${formattedMonthUrl}`;
      const targetDateString = formatDate(targetDate); // YYYY-MM-DD

      if (options.verbose) {
        console.log(`[${SCRAPER_ID}] Processing date: ${targetDateString}`);
        if (loadedCalendarUrl !== calendarUrl) {
          console.log(
            `[${SCRAPER_ID}] Navigating to calendar month: ${calendarUrl}`,
          );
        }
      }

      try {
        if (loadedCalendarUrl !== calendarUrl) {
          await calendarPage.goto(calendarUrl, {
            waitUntil: "networkidle0",
            timeout: 60000,
          });

          // Wait for calendar script data to load
          await calendarPage.waitForSelector("script[type='application/ld+json']", {
            timeout: 60000,
          });
          loadedCalendarUrl = calendarUrl;
        }

        if (options.verbose) {
          console.log(
            `[${SCRAPER_ID}] Calendar month loaded, extracting events for ${targetDateString}...`,
          );
        }

        // Extract JSON-LD scripts for the target date
        const eventsForDate = await calendarPage.evaluate(
          (dateStr, scraperId, locationName) => {
            const scripts = Array.from(
              document.querySelectorAll("script[type='application/ld+json']"),
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
                  e,
                );
              }
            }
            return eventsList;
          },
          targetDateString,
          SCRAPER_ID,
          LOCATION_NAME,
        );

        if (options.verbose) {
          console.log(
            `[${SCRAPER_ID}] Found ${eventsForDate.length} potential events on ${targetDateString}. Fetching details...`,
          );
        }

        // Get full details for each event found
        for (const event of eventsForDate) {
          if (event.url) {
            try {
              await detailPage.goto(event.url, {
                waitUntil: "networkidle0",
                timeout: 60000,
              });

              await detailPage.waitForSelector(".event-description", {
                timeout: 60000,
              });

              // --- Get Date and Time ---
              let headerText = "";
              try {
                // Try to get the header text from h3.event-meta
                headerText = await detailPage.$eval(
                  "h3.event-meta",
                  (el) => el.textContent || "",
                );
              } catch {
                try {
                  // If h3.event-meta doesn't exist, try to get it from h3 tag directly (new format)
                  headerText = await detailPage.$eval(
                    "h3",
                    (el) => el.textContent || "",
                  );
                } catch {
                  console.warn(
                    `[${SCRAPER_ID}] Could not find event meta header on ${event.url}`,
                  );
                }
              }

              // The calendar JSON-LD matched this event to targetDateString. Use
              // that structured date as authoritative; detail-page text can be
              // malformed as "October 210:00 AM" and misread as October 21.
              const eventDate = targetDateString;

              let timeText = "";
              try {
                // Try to get time from span.event-time
                timeText = await detailPage.$eval(
                  "span.event-time",
                  (el) => el.textContent || "",
                );
              } catch {
                // If span.event-time doesn't exist, try to extract time from the header text directly
                // Look for cases where time format is "X:XX—X:XX AM/PM" with period at the end
                // This handles patterns like "4:00—4:30 PM", "9:00—9:30 AM", etc.
                const timeRangeMatch = headerText.match(
                  /(\d{1,2}):(\d{2})(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i,
                );

                if (timeRangeMatch) {
                  const [, startHour, startMin, endHour, endMin, period] =
                    timeRangeMatch;
                  // Add period to both times to ensure they're both treated the same
                  timeText = `${startHour}:${startMin} ${period}—${endHour}:${endMin} ${period}`;
                } else {
                  // Look for fully specified time ranges "X:XX AM/PM—X:XX AM/PM"
                  const fullTimeRangeMatch = headerText.match(
                    /(\d{1,2}):(\d{2})\s*(AM|PM)(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i,
                  );

                  if (fullTimeRangeMatch) {
                    timeText = fullTimeRangeMatch[0];
                  } else {
                    // Last resort - just find any time-like pattern
                    const basicTimeMatch = headerText.match(
                      /\d{1,2}:\d{2}.*?(AM|PM)/i,
                    );

                    if (basicTimeMatch) {
                      timeText = basicTimeMatch[0];
                    } else {
                      console.warn(
                        `[${SCRAPER_ID}] Could not find time information on ${event.url}`,
                      );
                    }
                  }
                }
              }

              const { startTime, endTime } = parseTimeText(timeText);
              if (startTime) {
                const dateTimeString = `${eventDate}T${startTime}`;
                try {
                  const startDate = toDate(dateTimeString, {
                    timeZone: TIME_ZONE,
                  });
                  event.start_at = startDate.toISOString();
                } catch (error) {
                  console.error(
                    `[${SCRAPER_ID}] Error creating start date from "${dateTimeString}":`,
                    error,
                  );
                  // Fallback to start of day
                  event.start_at = toDate(`${eventDate}T00:00:00`, {
                    timeZone: TIME_ZONE,
                  }).toISOString();
                }
              } else {
                // Fallback if time parsing fails - keep placeholder or set to start of day?
                console.warn(
                  `[${SCRAPER_ID}] Could not parse start time from "${timeText}" for event: ${event.title}`,
                );
                // Optionally default to start of day:
                event.start_at = toDate(`${eventDate}T00:00:00`, {
                  timeZone: TIME_ZONE,
                }).toISOString();
              }

              if (endTime) {
                const endDateTimeString = `${eventDate}T${endTime}`;
                try {
                  const endDate = toDate(endDateTimeString, {
                    timeZone: TIME_ZONE,
                  });
                  event.end_at = endDate.toISOString();
                } catch (error) {
                  console.error(
                    `[${SCRAPER_ID}] Error creating end date from "${endDateTimeString}":`,
                    error,
                  );
                  // Fallback to end of day
                  event.end_at = toDate(`${eventDate}T23:59:59`, {
                    timeZone: TIME_ZONE,
                  }).toISOString();
                }
              } else {
                event.end_at = undefined; // Ensure end_at is undefined if not parsed
              }

              // --- Get Description ---
              const descriptionHtml = await detailPage.$eval(
                ".event-description",
                (el) => el.innerHTML,
              );
              event.description = convertHtmlToMarkdown(descriptionHtml);

              // --- Decode Title ---
              if (event.title) {
                event.title = decode(event.title);
              }

              // Add the fully processed event
              const processedEvent = event as Event;
              allEvents.push(processedEvent);
              logEventFound(SCRAPER_ID, processedEvent);
            } catch (detailError) {
              console.error(
                `[${SCRAPER_ID}] Error fetching details for event ${event.title} (${event.url}):`,
                detailError,
              );
            }
          } else {
            console.warn(
              `[${SCRAPER_ID}] Event "${event.title}" has no URL, skipping detail fetching.`,
            );
          }
        } // End loop for fetching event details
      } catch (monthError) {
        console.error(
          `[${SCRAPER_ID}] Error processing date ${targetDateString}:`,
          monthError,
        );
        // Continue to the next date
      }
    } // End loop for dates

    console.log(
      `[${SCRAPER_ID}] Finished scraping. Found ${allEvents.length} total events.`,
    );

    // Validate all collected events
    try {
      const validationResult = EventsArraySchema.parse(allEvents);
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.length} events.`,
      );
      return validationResult as Event[]; // Type assertion is safe after validation
    } catch (validationError) {
      console.error(`[${SCRAPER_ID}] Zod validation error:`, validationError);
      // Decide how to handle: return partially valid events, return [], or throw
      // For now, throwing an error to indicate failure
      throw new Error(
        `[${SCRAPER_ID}] Event validation failed: ${JSON.stringify(
          validationError,
        )}`,
      );
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] An unexpected error occurred:`, error);
    // Depending on requirements, could return [], or rethrow
    return []; // Return empty array on major failure
  } finally {
    if (calendarPage && !calendarPage.isClosed()) {
      await calendarPage.close();
    }
    if (detailPage && !detailPage.isClosed()) {
      await detailPage.close();
    }
    // The runner owns the shared browser instance.
  }
};

// --- Helper Functions ---

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
    /(\d{1,2}):(\d{2})\s*(AM|PM)(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  );
  if (match) {
    const [, startHour, startMin, startPeriod, endHour, endMin, endPeriod] =
      match;
    return {
      startTime: convert12to24(startHour, startMin, startPeriod),
      endTime: convert12to24(endHour, endMin, endPeriod),
    };
  }

  // Format: "4:00 PM—4:30 PM" (repeated AM/PM)
  // This handles our reformatted cases where we explicitly add the period to both times
  match = timeText.match(
    /(\d{1,2}):(\d{2})\s*(AM|PM)(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i,
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
    /(\d{1,2}):(\d{2})(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  );
  if (match) {
    const [, startHour, startMin, endHour, endMin, period] = match;
    const isEndPM = period.toUpperCase() === "PM";
    const startH = Number.parseInt(startHour, 10);
    const endH = Number.parseInt(endHour, 10);

    // Improved period inference logic:
    // 1. If start hour equals end hour (like "4:00-4:30 PM"), both must be same period
    // 2. If start < end and both < 12, they're likely in same period
    let isStartPM = isEndPM;

    if (startH === endH) {
      // Same hour like "4:00-4:30 PM" - must be same period
      isStartPM = isEndPM;
    } else if (startH < endH && startH < 12 && endH < 12) {
      // Sequential hours both before noon like "9:00-11:30 AM" - likely same period
      isStartPM = isEndPM;
    } else if (startH === 12) {
      // 12 is special case (noon or midnight)
      isStartPM = isEndPM;
    } else if (startH < 12 && startH > endH && isEndPM) {
      // Like "10:00-1:30 PM" - start is AM, end is PM
      isStartPM = false;
    } else {
      // Default to same period for other cases
      isStartPM = isEndPM;
    }

    return {
      startTime: convert12to24(startHour, startMin, isStartPM ? "PM" : "AM"),
      endTime: convert12to24(endHour, endMin, isEndPM ? "PM" : "AM"),
    };
  }

  // Format: "7-8 PM" or "7 AM - 8 AM" (handles different separators)
  match = timeText.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?(?:—|-|\s+to\s+)(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i,
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

      // Improved period inference logic:
      // 1. If hours are the same (like "4-4:30 PM"), both must be same period
      if (startH === endH) {
        startPeriod = endPeriod;
      }
      // 2. If hours are both small and sequential (like "9-10 AM"), likely same period
      else if (startH < endH && startH < 12 && endH < 12) {
        startPeriod = endPeriod;
      }
      // 3. Special case for noon
      else if (startH === 12) {
        startPeriod = endPeriod;
      }
      // 4. Cases like "10-1 PM" where start hour is before noon but end is after
      else if (startH < 12 && startH > endH && isEndPM) {
        startPeriod = "AM";
      }
      // 5. Cases like "10-8 AM" - both must be AM (overnight would be specified differently)
      else if (startH >= endH && !isEndPM) {
        startPeriod = "AM";
      }
      // Default - assume same period
      else {
        startPeriod = endPeriod;
      }
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

  // Convert 12-hour format to 24-hour format
  if (isPM && h !== 12) h += 12; // 1 PM -> 13:00
  if (!isPM && h === 12) h = 0; // 12 AM -> 00:00

  const result = `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
  return result;
}

// Export the scraper object conforming to the Scraper interface
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeHowlandLibraryEvents,
};

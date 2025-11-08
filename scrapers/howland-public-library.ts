import type { Browser } from "puppeteer";
import { format } from "date-fns";
import { decode } from "html-entities";
import { toDate } from "date-fns-tz";

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
  let page: import("puppeteer").Page | undefined; // Declare page outside the loop with explicit type

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatDate(
      startDate,
    )} to ${formatDate(endDate || startDate)}...`,
  );

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36", // Set a common user agent
    );

    for (const targetDate of datesToScrape) {
      const formattedMonthUrl = format(targetDate, "yyyy-MMMM").toLowerCase();
      const calendarUrl = `${BASE_URL}/${formattedMonthUrl}`;
      const targetDateString = formatDate(targetDate); // YYYY-MM-DD

      console.log(`[${SCRAPER_ID}] Processing date: ${targetDateString}`);
      console.log(
        `[${SCRAPER_ID}] Navigating to calendar month: ${calendarUrl}`,
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
          `[${SCRAPER_ID}] Calendar month loaded, extracting events for ${targetDateString}...`,
        );

        // Extract JSON-LD scripts for the target date
        const eventsForDate = await page.evaluate(
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

        console.log(
          `[${SCRAPER_ID}] Found ${eventsForDate.length} potential events on ${targetDateString}. Fetching details...`,
        );

        // Get full details for each event found
        for (const event of eventsForDate) {
          if (event.url) {
            try {
              console.log(
                `[${SCRAPER_ID}] Navigating to event page: ${event.url}`,
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
                // Try to get the header text from h3.event-meta
                headerText = await page.$eval(
                  "h3.event-meta",
                  (el) => el.textContent || "",
                );
              } catch {
                try {
                  // If h3.event-meta doesn't exist, try to get it from h3 tag directly (new format)
                  headerText = await page.$eval(
                    "h3",
                    (el) => el.textContent || "",
                  );
                } catch {
                  console.warn(
                    `[${SCRAPER_ID}] Could not find event meta header on ${event.url}`,
                  );
                }
              }

              // For debugging
              console.log(`[${SCRAPER_ID}] Event URL: ${event.url}`);
              console.log(`[${SCRAPER_ID}] Event Title: ${event.title}`);
              console.log(`[${SCRAPER_ID}] Raw header text: "${headerText}"`);

              let eventDate = targetDateString; // Default to the target date

              // Updated regex to handle cases where date and time run together
              // For example: "Wednesday, August 204:00—4:30 PM" or "Wednesday, September 91:00 AM"
              // We want to capture day (1-2 digits) and separate it from any time that follows
              // Use a more restrictive approach: capture the longest sequence of digits after month
              // Then validate and correct if it includes time digits
              const headerDateMatch = headerText.match(
                /([A-Za-z]+),\s+([A-Za-z]+)\s+(\d+)/,
              );

              // Additional validation and correction for when day/time run together
              let correctedDay = null;
              if (headerDateMatch) {
                const potentialDay = headerDateMatch[3];
                console.log(
                  `[${SCRAPER_ID}] Potential day captured: "${potentialDay}"`,
                );

                // Check if this looks like day+time (e.g., "310" from "310:00")
                // Look for pattern where captured digits are followed by ":XX"
                const afterDayMatch = headerText.match(
                  new RegExp(
                    `([A-Za-z]+),\\s+([A-Za-z]+)\\s+${potentialDay}(:\\d{2})`,
                  ),
                );

                if (afterDayMatch && afterDayMatch[3]) {
                  // We captured day+time digits, need to separate them
                  console.log(
                    `[${SCRAPER_ID}] Detected day+time pattern: "${potentialDay}${afterDayMatch[3]}"`,
                  );

                  // Try different splits: double digit day first, then single digit day
                  for (let dayLength = 2; dayLength >= 1; dayLength--) {
                    if (potentialDay.length > dayLength) {
                      const testDay = potentialDay.substring(0, dayLength);
                      const testDayNum = parseInt(testDay);
                      const remainingDigits = potentialDay.substring(dayLength);

                      // Check if this makes sense (valid day 1-31, and remaining digits could be hour)
                      if (
                        testDayNum >= 1 &&
                        testDayNum <= 31 &&
                        parseInt(remainingDigits) >= 0 &&
                        parseInt(remainingDigits) <= 23
                      ) {
                        correctedDay = testDay;
                        console.log(
                          `[${SCRAPER_ID}] Corrected day from "${potentialDay}" to "${correctedDay}" (remaining: "${remainingDigits}")`,
                        );
                        break;
                      }
                    }
                  }
                } else if (
                  parseInt(potentialDay) >= 1 &&
                  parseInt(potentialDay) <= 31
                ) {
                  // Normal case - captured day is valid and not mixed with time
                  correctedDay = potentialDay;
                }
              }
              if (headerDateMatch && correctedDay) {
                const [, , month] = headerDateMatch;
                const day = correctedDay;
                const year = targetDate.getFullYear(); // Use year from targetDate
                const monthNumber = getMonthNumber(month);
                console.log(
                  `[${SCRAPER_ID}] Parsed header date: month=${month}, day=${day}, year=${year}, monthNumber=${monthNumber}`,
                );
                if (monthNumber) {
                  eventDate = `${year}-${monthNumber}-${day.padStart(2, "0")}`;
                  console.log(
                    `[${SCRAPER_ID}] Constructed eventDate: ${eventDate}`,
                  );
                } else {
                  console.warn(
                    `[${SCRAPER_ID}] Could not get month number for: ${month}`,
                  );
                }
              } else {
                console.log(
                  `[${SCRAPER_ID}] No valid header date match found in: "${headerText}"`,
                );
              }

              let timeText = "";
              try {
                // Try to get time from span.event-time
                timeText = await page.$eval(
                  "span.event-time",
                  (el) => el.textContent || "",
                );
              } catch {
                // If span.event-time doesn't exist, try to extract time from the header text directly
                console.log(`[${SCRAPER_ID}] Header text: "${headerText}"`);

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
                  console.log(
                    `[${SCRAPER_ID}] Extracted time range with single period: "${timeText}"`,
                  );
                } else {
                  // Look for fully specified time ranges "X:XX AM/PM—X:XX AM/PM"
                  const fullTimeRangeMatch = headerText.match(
                    /(\d{1,2}):(\d{2})\s*(AM|PM)(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i,
                  );

                  if (fullTimeRangeMatch) {
                    timeText = fullTimeRangeMatch[0];
                    console.log(
                      `[${SCRAPER_ID}] Extracted fully specified time range: "${timeText}"`,
                    );
                  } else {
                    // Last resort - just find any time-like pattern
                    const basicTimeMatch = headerText.match(
                      /\d{1,2}:\d{2}.*?(AM|PM)/i,
                    );

                    if (basicTimeMatch) {
                      timeText = basicTimeMatch[0];
                      console.log(
                        `[${SCRAPER_ID}] Extracted basic time from header: "${timeText}"`,
                      );
                    } else {
                      console.warn(
                        `[${SCRAPER_ID}] Could not find time information on ${event.url}`,
                      );
                    }
                  }
                }
              }

              console.log(`[${SCRAPER_ID}] Parsing time text: "${timeText}"`);
              const { startTime, endTime } = parseTimeText(timeText);
              console.log(
                `[${SCRAPER_ID}] Parsed times: start=${startTime}, end=${endTime}`,
              );

              if (startTime) {
                const dateTimeString = `${eventDate}T${startTime}`;
                console.log(
                  `[${SCRAPER_ID}] Constructing start datetime: "${dateTimeString}" in timezone: ${TIME_ZONE}`,
                );
                try {
                  const startDate = toDate(dateTimeString, {
                    timeZone: TIME_ZONE,
                  });
                  console.log(
                    `[${SCRAPER_ID}] Created start Date object: ${startDate}`,
                  );
                  event.start_at = startDate.toISOString();
                  console.log(
                    `[${SCRAPER_ID}] Start ISO string: ${event.start_at}`,
                  );
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
                console.log(
                  `[${SCRAPER_ID}] Constructing end datetime: "${endDateTimeString}" in timezone: ${TIME_ZONE}`,
                );
                try {
                  const endDate = toDate(endDateTimeString, {
                    timeZone: TIME_ZONE,
                  });
                  console.log(
                    `[${SCRAPER_ID}] Created end Date object: ${endDate}`,
                  );
                  event.end_at = endDate.toISOString();
                  console.log(
                    `[${SCRAPER_ID}] End ISO string: ${event.end_at}`,
                  );
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
              const descriptionHtml = await page.$eval(
                ".event-description",
                (el) => el.innerHTML,
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
  console.log(`[${SCRAPER_ID}] Parsing time text: "${timeText}"`);

  // Format: "10:00 AM—1:00 PM" (handles different separators: —, -, to)
  let match = timeText.match(
    /(\d{1,2}):(\d{2})\s*(AM|PM)(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  );
  if (match) {
    const [, startHour, startMin, startPeriod, endHour, endMin, endPeriod] =
      match;
    console.log(
      `[${SCRAPER_ID}] Matched full format time range with separate periods`,
    );
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
    console.log(
      `[${SCRAPER_ID}] Matched reformatted time with repeated periods`,
    );
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

    console.log(
      `[${SCRAPER_ID}] Time inference: startH=${startH}, endH=${endH}, period=${period}`,
    );

    if (startH === endH) {
      // Same hour like "4:00-4:30 PM" - must be same period
      isStartPM = isEndPM;
      console.log(
        `[${SCRAPER_ID}] Same hour case: both ${isStartPM ? "PM" : "AM"}`,
      );
    } else if (startH < endH && startH < 12 && endH < 12) {
      // Sequential hours both before noon like "9:00-11:30 AM" - likely same period
      isStartPM = isEndPM;
      console.log(
        `[${SCRAPER_ID}] Sequential hours < 12: both ${isStartPM ? "PM" : "AM"}`,
      );
    } else if (startH === 12) {
      // 12 is special case (noon or midnight)
      isStartPM = isEndPM;
      console.log(
        `[${SCRAPER_ID}] 12 o'clock case: both ${isStartPM ? "PM" : "AM"}`,
      );
    } else if (startH < 12 && startH > endH && isEndPM) {
      // Like "10:00-1:30 PM" - start is AM, end is PM
      isStartPM = false;
      console.log(
        `[${SCRAPER_ID}] Start < 12 & start > end & end is PM: start=AM, end=PM`,
      );
    } else {
      // Default to same period for other cases
      isStartPM = isEndPM;
      console.log(
        `[${SCRAPER_ID}] Default case: both ${isStartPM ? "PM" : "AM"}`,
      );
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

    console.log(
      `[${SCRAPER_ID}] Matched hour-only format: ${startHour}${startMin ? ":" + startMin : ""}${startPeriod ? " " + startPeriod : ""}-${endHour}${endMin ? ":" + endMin : ""} ${endPeriod}`,
    );

    // If startPeriod is missing, infer from endPeriod based on hours
    if (!startPeriod) {
      const startH = Number.parseInt(startHour, 10);
      const endH = Number.parseInt(endHour, 10);
      const isEndPM = endPeriod.toUpperCase() === "PM";

      console.log(
        `[${SCRAPER_ID}] Time period inference: startH=${startH}, endH=${endH}, endPeriod=${endPeriod}`,
      );

      // Improved period inference logic:
      // 1. If hours are the same (like "4-4:30 PM"), both must be same period
      if (startH === endH) {
        startPeriod = endPeriod;
        console.log(`[${SCRAPER_ID}] Same hour: both ${endPeriod}`);
      }
      // 2. If hours are both small and sequential (like "9-10 AM"), likely same period
      else if (startH < endH && startH < 12 && endH < 12) {
        startPeriod = endPeriod;
        console.log(`[${SCRAPER_ID}] Sequential hours < 12: both ${endPeriod}`);
      }
      // 3. Special case for noon
      else if (startH === 12) {
        startPeriod = endPeriod;
        console.log(
          `[${SCRAPER_ID}] 12 o'clock special case: both ${endPeriod}`,
        );
      }
      // 4. Cases like "10-1 PM" where start hour is before noon but end is after
      else if (startH < 12 && startH > endH && isEndPM) {
        startPeriod = "AM";
        console.log(`[${SCRAPER_ID}] Crossing noon case: start=AM, end=PM`);
      }
      // 5. Cases like "10-8 AM" - both must be AM (overnight would be specified differently)
      else if (startH >= endH && !isEndPM) {
        startPeriod = "AM";
        console.log(`[${SCRAPER_ID}] Both morning hours: both AM`);
      }
      // Default - assume same period
      else {
        startPeriod = endPeriod;
        console.log(`[${SCRAPER_ID}] Default case: both ${endPeriod}`);
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
  console.log(
    `[${SCRAPER_ID}] Converting ${hour}:${min} ${period} to ${result}`,
  );
  return result;
}

// Export the scraper object conforming to the Scraper interface
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeHowlandLibraryEvents,
};

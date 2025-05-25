import type { Page } from "puppeteer";
import {
  format,
  isValid,
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

const SCRAPER_ID = "beacon-government";
const LOCATION_NAME = "City of Beacon";
const BASE_URL = "https://beaconny.gov";
const EVENTS_URL = `${BASE_URL}/index.php/events/`;
const TIME_ZONE = "America/New_York";

// Helper function to extract date and time from strings like "May 5 @ 7:00 PM - 9:00 PM"
function parseBeaconDateTime(dateTimeString: string): {
  date?: string;
  startTime?: string;
  endTime?: string;
} {
  if (!dateTimeString) return {};

  // Multiple patterns to try for different date formats

  // Pattern for "Month Day @ Time - Time" or "Month Day @ Time"
  const atPattern =
    /([A-Za-z]+)\s+(\d{1,2})(?:\s+@\s+(\d{1,2}):(\d{2})\s+([AP]M)(?:\s+-\s+(\d{1,2}):(\d{2})\s+([AP]M))?)?/;

  // Pattern for "Month Day, Year"
  const simplePattern = /([A-Za-z]+)\s+(\d{1,2})(?:,\s+(\d{4}))?/;

  // Pattern for time "Time AM/PM - Time AM/PM"
  const timePattern =
    /(\d{1,2}):(\d{2})\s+([AP]M)(?:\s*-\s*(\d{1,2}):(\d{2})\s+([AP]M))?/;

  // Pattern for time without minutes "X AM - Y PM"
  const shortTimePattern = /(\d{1,2})\s+([AP]M)(?:\s*-\s*(\d{1,2})\s+([AP]M))?/;

  // Pattern for "All day" and similar formats
  const allDayPattern = /All day|All-day/i;

  // Pattern for "MMM DD YYYY" format
  const standardDatePattern = /([A-Za-z]{3})\s+(\d{1,2})(?:\s+|,\s+)(\d{4})/;

  // Pattern for "YYYY-MM-DD" format
  const isoDatePattern = /(\d{4})-(\d{2})-(\d{2})/;

  // Try the primary pattern first
  let match = dateTimeString.match(atPattern);
  if (match) {
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

    // Construct date part (assume current year)
    const year = new Date().getFullYear();
    const date = `${year}-${getMonthNumber(month)}-${day.padStart(2, "0")}`;

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

  // Try the simple date pattern
  match = dateTimeString.match(simplePattern);
  if (match) {
    const [, month, day, yearStr] = match;
    const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
    const date = `${year}-${getMonthNumber(month)}-${day.padStart(2, "0")}`;

    // Try to find time information elsewhere in the string
    const timeMatch = dateTimeString.match(timePattern);
    let startTime: string | undefined;
    let endTime: string | undefined;

    if (timeMatch) {
      const [, startHour, startMin, startPeriod, endHour, endMin, endPeriod] =
        timeMatch;
      if (startHour && startMin && startPeriod) {
        startTime = convert12to24(startHour, startMin, startPeriod);
      }

      if (endHour && endMin && endPeriod) {
        endTime = convert12to24(endHour, endMin, endPeriod);
      }
    }

    return { date, startTime, endTime };
  }

  // Try MMM DD YYYY format
  match = dateTimeString.match(standardDatePattern);
  if (match) {
    const [, month, day, year] = match;
    const date = `${year}-${getMonthNumber(month)}-${day.padStart(2, "0")}`;

    // Look for time information
    const timeMatch = dateTimeString.match(timePattern);
    let startTime: string | undefined;
    let endTime: string | undefined;

    if (timeMatch) {
      const [, startHour, startMin, startPeriod, endHour, endMin, endPeriod] =
        timeMatch;
      if (startHour && startMin && startPeriod) {
        startTime = convert12to24(startHour, startMin, startPeriod);
      }

      if (endHour && endMin && endPeriod) {
        endTime = convert12to24(endHour, endMin, endPeriod);
      }
    }

    return { date, startTime, endTime };
  }

  // Try ISO date format YYYY-MM-DD
  match = dateTimeString.match(isoDatePattern);
  if (match) {
    const [, year, month, day] = match;
    const date = `${year}-${month}-${day}`;

    // Look for time information
    const timeMatch = dateTimeString.match(timePattern);
    let startTime: string | undefined;
    let endTime: string | undefined;

    if (timeMatch) {
      const [, startHour, startMin, startPeriod, endHour, endMin, endPeriod] =
        timeMatch;
      if (startHour && startMin && startPeriod) {
        startTime = convert12to24(startHour, startMin, startPeriod);
      }

      if (endHour && endMin && endPeriod) {
        endTime = convert12to24(endHour, endMin, endPeriod);
      }
    }

    return { date, startTime, endTime };
  }

  // If no patterns match, return empty object
  return {};
}

// Helper to extract month name to number
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
    // Add abbreviated month names
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05", // Ensure "may" is handled in both forms
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    sept: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };

  const lowerMonth = monthName?.toLowerCase();
  return lowerMonth ? months[lowerMonth] || "01" : "01";
}

// Helper to convert 12-hour time to 24-hour format
function convert12to24(hour: string, min: string, period: string): string {
  let h = Number.parseInt(hour, 10);
  if (Number.isNaN(h)) {
    console.warn(`[${SCRAPER_ID}] Invalid hour value: ${hour}`);
    h = 12; // Default to noon
  }

  const isPM = period?.toUpperCase() === "PM";

  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0; // Midnight case

  return `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
}

// Helper to combine date and time into ISO string
function combineToISOString(date?: string, time?: string): string | undefined {
  if (!date || !time) return undefined;

  try {
    const dateTimeString = `${date}T${time}`;
    const dateObj = toDate(dateTimeString, { timeZone: TIME_ZONE });
    if (!isValid(dateObj)) {
      console.warn(
        `[${SCRAPER_ID}] Invalid date constructed from ${dateTimeString}`,
      );
      return undefined;
    }
    return formatISO(dateObj);
  } catch (e) {
    console.error(`[${SCRAPER_ID}] Error creating ISO date:`, e);
    return undefined;
  }
}

/**
 * Scrapes events from the City of Beacon government website.
 */
async function scrapeBeaconGovernmentEvents(
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
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    );

    // Navigate to events page
    console.log(`[${SCRAPER_ID}] Navigating to ${EVENTS_URL}`);
    await page.goto(EVENTS_URL, { waitUntil: "networkidle0", timeout: 60000 });

    // Check if there's a calendar or list view
    const hasList = await page.evaluate(() => {
      return Boolean(
        document.querySelector(
          ".tribe-events-calendar-list, .eventlist, ul.calendar-events",
        ),
      );
    });

    const hasCalendar = await page.evaluate(() => {
      return Boolean(
        document.querySelector(
          ".tribe-events-calendar-month, .calendar-month, #calendar-main",
        ),
      );
    });

    // If there's a list view button, click it to ensure we see all events
    const hasListViewButton = await page.evaluate(() => {
      const listButton = document.querySelector(
        'a[href*="list"], button[data-view="list"], a.list-view',
      );
      if (listButton) {
        (listButton as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (hasListViewButton) {
      // Wait for the list view to load
      // Use setTimeout with a Promise instead of page.waitForTimeout
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await page
        .waitForNetworkIdle({ timeout: 5000, idleTime: 500 })
        .catch(() => {
          console.log(
            `[${SCRAPER_ID}] Network did not fully idle, continuing anyway`,
          );
        });
    }

    // Extract events from the calendar page
    const rawEvents = await page.evaluate(() => {
      // Find event elements in the calendar display
      const eventElements = Array.from(
        document.querySelectorAll(
          ".type-tribe_events, li.eventlist-event, .calendar-event, li[class*='event'], article[class*='event'], .tribe-common-g-row--gutters",
        ),
      );

      return eventElements
        .map((element) => {
          // Extract title
          const titleElement = element.querySelector(
            "h3.eventlist-title, h1.tribe-events-single-event-title, .eventlist-title, .calendar-event h3, .event-title, h3 a, h1.entry-title, .tribe-events-calendar-list__event-title, .tribe-events-calendar-latest-past__event-title",
          );
          const title = titleElement?.textContent?.trim() || "";

          // Extract URL
          const linkElement = element.querySelector(
            "a[href*='/event/'], a.calendar-event-link, a[href*='events'], h3 a, .tribe-events-calendar-list__event-title-link",
          );
          const relativeUrl = linkElement?.getAttribute("href") || "";
          const url = relativeUrl
            ? new URL(relativeUrl, window.location.origin).toString()
            : "";

          // Extract date and time
          const dateTimeElement = element.querySelector(
            "time.event-date, .eventitem-meta-time, time, .event-time, .event-date, .date-time, .tribe-events-calendar-list__event-datetime, .tribe-events-calendar-latest-past__event-datetime",
          );
          const dateTimeString = dateTimeElement?.textContent?.trim() || "";

          // Extract description preview (if available)
          const descElement = element.querySelector(
            "p.eventlist-excerpt, .eventitem-excerpt, .calendar-event-description, .event-description, .description, .event-excerpt, .tribe-events-calendar-list__event-description, .tribe-events-calendar-latest-past__event-description",
          );
          const descriptionPreview = descElement?.textContent?.trim() || "";

          // Extract additional date and time information
          let formattedDateStr = "";
          const dateDisplay = element.querySelector(
            "span.event-date, .eventitem-meta-date span, .calendar-event .calendar-event-date, .tribe-events-calendar-list__event-date-tag-datetime",
          );
          if (dateDisplay) {
            formattedDateStr = dateDisplay.textContent?.trim() || "";
          }

          // Create a unique ID from URL or title
          let externalId = "";
          if (url) {
            const urlParts = url.split("/").filter(Boolean);
            externalId = `beacon-gov-${urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || ""}`;
          } else if (title) {
            // Fallback to title-based ID
            externalId = `beacon-gov-${title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .slice(0, 30)}`;
          }

          return {
            title,
            url,
            dateTimeString: dateTimeString || formattedDateStr,
            descriptionPreview,
            external_id: externalId,
          };
        })
        .filter((event) => event.title); // Only return events with at least a title
    });

    console.log(
      `[${SCRAPER_ID}] Found ${rawEvents.length} raw events. Processing...`,
    );

    // Define the date range for filtering
    const dateInterval = {
      start: startOfDay(startDate),
      end: endOfDay(endDate),
    };

    // Check for pagination
    let nextPageUrl = await page.evaluate(() => {
      const nextPageLink = document.querySelector(
        'a.next, a.pagination-next, a[rel="next"], a.tribe-events-c-nav__next',
      );
      return nextPageLink ? nextPageLink.getAttribute("href") : null;
    });

    // Process additional pages if they exist
    while (nextPageUrl) {
      console.log(
        `[${SCRAPER_ID}] Found next page, navigating to: ${nextPageUrl}`,
      );
      await page.goto(nextPageUrl, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      // Extract events from the next page
      const nextPageEvents = await page.evaluate(() => {
        // Find event elements in the calendar display
        const eventElements = Array.from(
          document.querySelectorAll(
            ".type-tribe_events, li.eventlist-event, .calendar-event, li[class*='event'], article[class*='event'], .tribe-common-g-row--gutters",
          ),
        );

        return eventElements
          .map((element) => {
            // Extract title
            const titleElement = element.querySelector(
              "h3.eventlist-title, h1.tribe-events-single-event-title, .eventlist-title, .calendar-event h3, .event-title, h3 a, h1.entry-title, .tribe-events-calendar-list__event-title, .tribe-events-calendar-latest-past__event-title",
            );
            const title = titleElement?.textContent?.trim() || "";

            // Extract URL
            const linkElement = element.querySelector(
              "a[href*='/event/'], a.calendar-event-link, a[href*='events'], h3 a, .tribe-events-calendar-list__event-title-link",
            );
            const relativeUrl = linkElement?.getAttribute("href") || "";
            const url = relativeUrl
              ? new URL(relativeUrl, window.location.origin).toString()
              : "";

            // Extract date and time
            const dateTimeElement = element.querySelector(
              "time.event-date, .eventitem-meta-time, time, .event-time, .event-date, .date-time, .tribe-events-calendar-list__event-datetime, .tribe-events-calendar-latest-past__event-datetime",
            );
            const dateTimeString = dateTimeElement?.textContent?.trim() || "";

            // Extract description preview (if available)
            const descElement = element.querySelector(
              "p.eventlist-excerpt, .eventitem-excerpt, .calendar-event-description, .event-description, .description, .event-excerpt, .tribe-events-calendar-list__event-description, .tribe-events-calendar-latest-past__event-description",
            );
            const descriptionPreview = descElement?.textContent?.trim() || "";

            // Extract additional date and time information
            let formattedDateStr = "";
            const dateDisplay = element.querySelector(
              "span.event-date, .eventitem-meta-date span, .calendar-event .calendar-event-date, .tribe-events-calendar-list__event-date-tag-datetime",
            );
            if (dateDisplay) {
              formattedDateStr = dateDisplay.textContent?.trim() || "";
            }

            // Create a unique ID from URL or title
            let externalId = "";
            if (url) {
              const urlParts = url.split("/").filter(Boolean);
              externalId = `beacon-gov-${urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || ""}`;
            } else if (title) {
              // Fallback to title-based ID
              externalId = `beacon-gov-${title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .slice(0, 30)}`;
            }

            return {
              title,
              url,
              dateTimeString: dateTimeString || formattedDateStr,
              descriptionPreview,
              external_id: externalId,
            };
          })
          .filter((event) => event.title); // Only return events with at least a title
      });

      // Add events from the next page to our collection
      rawEvents.push(...nextPageEvents);
      console.log(
        `[${SCRAPER_ID}] Added ${nextPageEvents.length} events from next page`,
      );

      // Check if there's another page
      nextPageUrl = await page.evaluate(() => {
        const nextPageLink = document.querySelector(
          'a.next, a.pagination-next, a[rel="next"], a.tribe-events-c-nav__next',
        );
        return nextPageLink ? nextPageLink.getAttribute("href") : null;
      });
    }

    console.log(
      `[${SCRAPER_ID}] Found ${rawEvents.length} total raw events. Processing...`,
    );

    // Process each raw event and fetch details
    for (const rawEvent of rawEvents) {
      try {
        // Parse the date and time
        let { date, startTime, endTime } = parseBeaconDateTime(
          rawEvent.dateTimeString,
        );

        // If time not found, try to extract just time using the simple time pattern
        if (date && !startTime && rawEvent.dateTimeString) {
          const shortTimeMatch = rawEvent.dateTimeString.match(
            /(\d{1,2})\s+([AP]M)(?:\s*-\s*(\d{1,2})\s+([AP]M))?/,
          );
          if (shortTimeMatch) {
            const [, startHour, startPeriod, endHour, endPeriod] =
              shortTimeMatch;
            startTime = convert12to24(startHour, "00", startPeriod);
            if (endHour && endPeriod) {
              endTime = convert12to24(endHour, "00", endPeriod);
            }
          }
        }

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
        const eventDate = startAtIso ? new Date(startAtIso) : null;
        if (!eventDate || !isValid(eventDate)) {
          // Try to extract a date from the title or description if date parsing failed
          const yearPattern = /\b(202[0-9])\b/; // Look for years like 2020-2029
          const yearMatch =
            rawEvent.title.match(yearPattern) ||
            rawEvent.descriptionPreview.match(yearPattern);

          if (yearMatch) {
            console.log(
              `[${SCRAPER_ID}] Found year in title/description for ${rawEvent.title}: ${yearMatch[1]}`,
            );
            // Create a basic date for this year and continue processing
            const year = yearMatch[1];
            // Use current month and day if we can't extract better info
            const month = new Date().getMonth() + 1;
            const day = new Date().getDate();
            const estimatedDate = `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
            const estimatedStartAt = combineToISOString(
              estimatedDate,
              "12:00:00",
            ); // Noon as default time

            if (estimatedStartAt) {
              console.log(
                `[${SCRAPER_ID}] Using estimated date for ${rawEvent.title}: ${estimatedDate}`,
              );
              rawEvent.dateTimeString = estimatedDate;
              continue; // Re-process this event in the next iteration
            }
          }

          console.warn(
            `[${SCRAPER_ID}] Invalid or missing date for event: ${rawEvent.title}`,
          );
          continue;
        }

        if (!isWithinInterval(eventDate, dateInterval)) {
          console.log(
            `[${SCRAPER_ID}] Event outside date range: ${rawEvent.title} on ${format(eventDate, "yyyy-MM-dd")}`,
          );
          continue;
        }

        // Default description from preview or placeholder
        let description =
          rawEvent.descriptionPreview || "(Description not available)";

        // Fetch detailed description if URL is available
        if (rawEvent.url) {
          try {
            console.log(
              `[${SCRAPER_ID}] Fetching details for: ${rawEvent.title} (${rawEvent.url})`,
            );
            await page.goto(rawEvent.url, {
              waitUntil: "networkidle0",
              timeout: 45000,
            });

            // Try to extract the full description from the event detail page
            const fullDescription = await page.evaluate(() => {
              // Look for standard event description containers
              const descContainer =
                document.querySelector(".tribe-events-content") ||
                document.querySelector(
                  ".tribe-events-single-event-description",
                ) ||
                document.querySelector(".event-content") ||
                document.querySelector(".eventitem-column-content") ||
                document.querySelector(".calendar-modal-description") ||
                document.querySelector(".calendar-event-content") ||
                document.querySelector(".event-description") ||
                document.querySelector(
                  ".tribe-events-calendar-latest-past__event-description",
                ) ||
                document.querySelector(".description") ||
                document.querySelector(".entry-content") ||
                document.querySelector(".event-detail-content") ||
                document.querySelector("article.event-detail") ||
                document.querySelector(".event-details");

              return descContainer ? descContainer.innerHTML : "";
            });

            if (fullDescription) {
              description = convertHtmlToMarkdown(fullDescription);
            }
          } catch (detailError) {
            console.error(
              `[${SCRAPER_ID}] Error fetching details from ${rawEvent.url}:`,
              detailError,
            );
            // Keep using the preview description on error
          }
        }

        // Check for "All day" events and adjust times accordingly
        let allDayEvent = false;
        if (
          rawEvent.dateTimeString &&
          rawEvent.dateTimeString.match(/All day|All-day/i)
        ) {
          allDayEvent = true;
        }

        // For all-day events, set start to beginning of day and end to end of day if not specified
        let finalStartAt = startAtIso;
        let finalEndAt = endAtIso;

        if (allDayEvent && date) {
          // Set start to beginning of day
          finalStartAt = combineToISOString(date, "00:00:00");

          // Set end to end of day if not specified
          if (!endAtIso) {
            finalEndAt = combineToISOString(date, "23:59:59");
          }
        }

        // Create the event object
        const event: Event = {
          title: decode(rawEvent.title),
          description: description,
          start_at: finalStartAt,
          end_at: finalEndAt,
          url: rawEvent.url || EVENTS_URL,
          location: LOCATION_NAME,
          external_id: rawEvent.external_id || `beacon-gov-${Date.now()}`,
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
    return []; // Return empty array on major error
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
    // Browser instance is closed by the runner
  }
}

// Export the scraper object
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeBeaconGovernmentEvents,
};

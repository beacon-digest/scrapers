import type { Browser, Page } from "puppeteer";
import { format, parse as parseDateFns } from "date-fns";
import { decode } from "html-entities";
import { toDate, formatInTimeZone } from "date-fns-tz";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";
import { formatDate } from "../utils/date.js"; // For logging

const BASE_URL_TEMPLATE =
  "https://diaart.org/program/calendar/period/{YYYY-MM-DD}/venue/dia-beacon-beacon-united-states";
const SCRAPER_ID = "dia-beacon";
const LOCATION_NAME = "Dia Beacon";
const TIME_ZONE = "America/New_York";

/**
 * Parses the date and time string found on Dia Beacon event listings.
 * Example formats:
 * "Saturday, April 26, 2025, 10:30 am"
 * "Sunday, April 27, 2025, 10 am–5 pm"
 * "Sunday, May 18, 2025, 11–12 pm"
 */
function parseDiaDateTimeString(dateTimeString: string): {
  eventDate: Date | null;
  startTimeIso: string | null; // Full ISO string with TZ offset
  endTimeIso: string | null; // Full ISO string with TZ offset
} {
  if (!dateTimeString) {
    return { eventDate: null, startTimeIso: null, endTimeIso: null };
  }

  // Regex to capture Month Day, Year and the time part separately
  const dateMatch = dateTimeString.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  const timeMatch = dateTimeString.match(/,\s+([\d\sapm–:-]+)$/i); // Capture everything after the last comma

  if (!dateMatch || !timeMatch) {
    console.warn(
      `[${SCRAPER_ID}] Could not parse date/time string: "${dateTimeString}"`
    );
    return { eventDate: null, startTimeIso: null, endTimeIso: null };
  }

  const [, month, day, year] = dateMatch;
  const timePart = timeMatch[1].trim();

  // Parse the date part first
  let eventDate: Date | null = null;
  try {
    // Using date-fns parse which is more robust
    const parsedDate = parseDateFns(
      `${month} ${day} ${year}`,
      "MMMM d yyyy",
      new Date()
    );
    if (!Number.isNaN(parsedDate.getTime())) {
      // Initially parse without timezone, we'll add it later with the time
      eventDate = parsedDate;
    } else {
      throw new Error("Invalid date parsed");
    }
  } catch (e) {
    console.error(
      `[${SCRAPER_ID}] Error parsing date part "${month} ${day} ${year}":`,
      e
    );
    return { eventDate: null, startTimeIso: null, endTimeIso: null };
  }

  // Now parse the time part
  let startTimeStr: string | null = null; // HH:mm:ss
  let endTimeStr: string | null = null; // HH:mm:ss

  // Format: "10:30 am"
  let match = timePart.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (match) {
    startTimeStr = convert12to24Dia(match[1], match[2], match[3]);
  } else {
    // Format: "10 am–5 pm" or "11–12 pm" (using en dash '–' or hyphen '-')
    match = timePart.match(
      /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:–|-)(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i
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

      // Infer startPeriod if missing (e.g., "11–12 pm")
      if (!startPeriod) {
        const startH = Number.parseInt(startHour, 10);
        const endH = Number.parseInt(endHour, 10);
        if (
          endPeriod.toLowerCase() === "pm" &&
          startH < endH &&
          startH !== 12
        ) {
          // If end is PM and start hour is numerically less, assume start is AM unless start is 12
          startPeriod = "am";
        } else if (endPeriod.toLowerCase() === "am" && startH > endH) {
          // If end is AM and start hour is numerically more (e.g. 10pm-1am), assume start is PM. unlikely for Dia?
          startPeriod = "pm"; // This is a guess, might need refinement
        } else {
          // Otherwise, assume start period is the same as end period
          startPeriod = endPeriod;
        }
      }

      startTimeStr = convert12to24Dia(startHour, startMin, startPeriod);
      endTimeStr = convert12to24Dia(endHour, endMin, endPeriod);
    }
  }

  // Combine date and time, then format to ISO string with timezone
  let startTimeIso: string | null = null;
  let endTimeIso: string | null = null;

  if (eventDate && startTimeStr) {
    try {
      const fullStartDateStr = `${format(
        eventDate,
        "yyyy-MM-dd"
      )}T${startTimeStr}`;
      startTimeIso = toDate(fullStartDateStr, {
        timeZone: TIME_ZONE,
      }).toISOString();
    } catch (e) {
      console.error(
        `[${SCRAPER_ID}] Error creating start ISO date for ${dateTimeString}:`,
        e
      );
    }
  }

  if (eventDate && endTimeStr) {
    try {
      const fullEndDateStr = `${format(eventDate, "yyyy-MM-dd")}T${endTimeStr}`;
      endTimeIso = toDate(fullEndDateStr, {
        timeZone: TIME_ZONE,
      }).toISOString();
    } catch (e) {
      console.error(
        `[${SCRAPER_ID}] Error creating end ISO date for ${dateTimeString}:`,
        e
      );
    }
  } else if (startTimeIso) {
    // If no end time is parsed, keep endTimeIso null.
    // Do not automatically set end time to start time + 1 hour etc.
  }

  // Return the original parsed date object (useful for filtering) along with ISO strings
  return { eventDate, startTimeIso, endTimeIso };
}

/**
 * Converts 12-hour time parts to 24-hour "HH:mm:ss".
 */
function convert12to24Dia(
  hour: string,
  min: string,
  period: string
): string | null {
  let h = Number.parseInt(hour, 10);
  if (Number.isNaN(h) || h < 1 || h > 12) return null; // Basic validation

  const m = min ? Number.parseInt(min, 10) : 0;
  if (Number.isNaN(m) || m < 0 || m > 59) return null;

  const lcPeriod = period?.toLowerCase();

  if (lcPeriod === "pm" && h !== 12) {
    h += 12;
  } else if (lcPeriod === "am" && h === 12) {
    h = 0; // Midnight
  }
  // If h is 12 PM, it remains 12. If h is 1-11 PM, it becomes 13-23.
  // If h is 12 AM, it becomes 0. If h is 1-11 AM, it remains 1-11.

  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:00`;
}

/**
 * Scrapes events for a given date range from the Dia Beacon calendar.
 */
const scrapeDiaBeaconEvents = async (
  options: ScrapeOptions
): Promise<Event[]> => {
  const { startDate, endDate = startDate, browser } = options;

  if (!browser) {
    throw new Error("A Puppeteer browser instance must be provided.");
  }

  const formattedStartDate = format(startDate, "yyyy-MM-dd");
  const calendarUrl = BASE_URL_TEMPLATE.replace(
    "{YYYY-MM-DD}",
    formattedStartDate
  );

  const allEvents: Event[] = [];
  let page: Page | undefined;

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatDate(
      startDate
    )} to ${formatDate(endDate || startDate)}...`
  );
  console.log(`[${SCRAPER_ID}] Navigating to calendar page: ${calendarUrl}`);

  try {
    page = await browser.newPage();

    // --- Forward browser console logs to Node console --- START
    page.on("console", (msg) => {
      const type = msg.type().toUpperCase();
      // Only forward logs, warnings, errors from our scraper
      if (msg.text().startsWith(`[${SCRAPER_ID}]`)) {
        if (type === "LOG" || type === "WARN" || type === "ERROR") {
          console.log(`[Browser ${type}] ${msg.text()}`);
        }
      }
    });
    // --- Forward browser console logs to Node console --- END

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    await page.goto(calendarUrl, { waitUntil: "networkidle0", timeout: 90000 }); // Increased timeout

    // --- Log Main Content Area HTML --- START
    try {
      const mainContentHTML = await page.evaluate(() => {
        const mainElement = document.querySelector("main");
        if (mainElement) {
          return mainElement.outerHTML;
        }
        // Fallback if <main> not found
        console.warn(
          `[${SCRAPER_ID}] <main> element not found, logging body instead.`
        );
        return document.body.outerHTML;
      });
      console.log(
        `[${SCRAPER_ID}] Main content area HTML snapshot:\n${mainContentHTML.substring(
          0,
          4000
        )}...`
      ); // Log more characters
    } catch (logError) {
      console.error(
        `[${SCRAPER_ID}] Failed to get main content HTML for debugging:`,
        logError
      );
    }
    // --- Log Main Content Area HTML --- END

    // Wait for event listings to be present
    // Trying a selector that targets the event article container
    // New Strategy: Select a container likely holding title, date, etc.
    const eventSelector = "section.calendar article";
    try {
      await page.waitForSelector(eventSelector, { timeout: 30000 });
      console.log(
        `[${SCRAPER_ID}] Event container selector "${eventSelector}" found.`
      );
    } catch (e) {
      console.warn(
        `[${SCRAPER_ID}] Event selector "${eventSelector}" not found, page might be empty or structure changed.`
      );
      // Log the body HTML for debugging if the selector fails
      try {
        const bodyHTML = await page.evaluate(() => document.body.outerHTML);
        console.log(
          `[${SCRAPER_ID}] Current page body HTML snapshot:\n${bodyHTML.substring(
            0,
            2000
          )}...`
        ); // Log first 2k chars
      } catch (logError) {
        console.error(
          `[${SCRAPER_ID}] Failed to get body HTML for debugging:`,
          logError
        );
      }
      // Check for a "no events" message if applicable, otherwise return empty
      const bodyText = await page.evaluate(() => document.body.textContent);
      if (bodyText?.includes("There are no programs")) {
        // Check specific text if known
        console.log(
          `[${SCRAPER_ID}] No events found message detected on page.`
        );
        return [];
      }
      // Otherwise, assume structure changed or timed out finding events
      console.warn(
        `[${SCRAPER_ID}] Continuing attempt to extract data, but initial selector failed.`
      );
    }

    console.log(
      `[${SCRAPER_ID}] Calendar page loaded, extracting event data...`
    );

    // Extract raw data for all potential events on the page
    const rawEventsData = await page.evaluate(
      (selector, scraperId, locationName) => {
        const eventElements = document.querySelectorAll(selector);
        console.log(
          `[${scraperId}] Inside evaluate: Found ${eventElements.length} elements matching selector '${selector}'`
        );
        const eventsList: {
          rawTitle: string;
          rawDateTimeString: string;
          rawUrl: string;
        }[] = [];

        Array.from(eventElements).forEach((el, index) => {
          // 'el' is now the <article> element
          console.log(
            `[${scraperId}] Processing <article> index ${index}: ${el.outerHTML.substring(
              0,
              300
            )}...`
          );

          const titleElement =
            el.querySelector("div.col-content h1 a") ||
            el.querySelector("div.col-content h1");
          const title = titleElement?.textContent?.trim() || "";
          const url =
            (el.querySelector("div.col-content h1 a") as HTMLAnchorElement)
              ?.href || "";

          // --- Find the Date/Time String --- START
          // Strategy based on image: Extract date/time from the text content of div.col-content
          let dateTimeString = "";
          const contentDiv = el.querySelector("div.col-content");
          const contentText = contentDiv?.textContent?.trim() ?? "";

          if (contentDiv) {
            // Regex to find the full date/time pattern in the text
            // Example: Saturday, April 26, 2025, 10:30 am OR Sunday, April 27, 2025, 10 am–5 pm
            const dateTimeRegex =
              /([A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4},?\s+[^\n]+(?:am|pm))/i;
            const match = contentText.match(dateTimeRegex);
            if (match?.[0]) {
              // Extracted string might include extra context like ", Dia Beacon", clean it up if needed by parseDiaDateTimeString
              dateTimeString = match[0].trim();
              console.log(
                `[${scraperId}] Extracted dateTimeString from content text: "${dateTimeString}"`
              );
            } else {
              console.warn(
                `[${scraperId}] Could not extract date/time pattern from content text for event "${title}". Text was: "${contentText.substring(
                  0,
                  100
                )}..."`
              );
            }
          } else {
            console.warn(
              `[${scraperId}] Could not find div.col-content for event "${title}"`
            );
          }

          // --- Find the Date/Time String --- END

          if (title && dateTimeString) {
            // Additional check: ensure dateTimeString looks like a parsable date before adding
            if (!dateTimeString.match(/[A-Za-z]+\s+\d{1,2},\s+\d{4}/)) {
              console.warn(
                `[${scraperId}] Skipping element index ${index} ("${title}") because extracted dateTimeString ("${dateTimeString}") doesn't look like a date.`
              );
            } else {
              eventsList.push({
                rawTitle: title,
                rawDateTimeString: dateTimeString,
                rawUrl: url,
              });
            }
          } else {
            console.warn(
              `[${scraperId}] Skipping element index ${index} due to missing title or date/time string.`
            );
          }
        });
        return eventsList;
      },
      eventSelector, // Use the selector we waited for
      SCRAPER_ID,
      LOCATION_NAME
    );

    console.log(
      `[${SCRAPER_ID}] Found ${rawEventsData.length} potential event elements. Processing and filtering...`
    );

    const uniqueEventIds = new Set<string>(); // To prevent duplicates if events span multiple scraped pages (though unlikely here)

    // Process and filter events based on the date range
    for (const rawEvent of rawEventsData) {
      try {
        // Basic info already extracted
        const title = decode(rawEvent.rawTitle);

        // Parse date/time from the string extracted earlier
        const { eventDate, startTimeIso, endTimeIso } = parseDiaDateTimeString(
          rawEvent.rawDateTimeString
        );

        // Also filter if date parsing failed entirely
        if (
          !eventDate ||
          !startTimeIso ||
          eventDate < startDate ||
          eventDate >= endDate
        ) {
          // console.log(`[${SCRAPER_ID}] Filtering out event "${rawEvent.rawTitle}" on ${eventDate ? format(eventDate, 'yyyy-MM-dd') : 'unknown date'} (outside range [${formatDate(startDate)}, ${formatDate(endDate)}))`);
          continue;
        }

        // --- Fetch Description from Event Page --- START
        let description = "(Description not available)"; // Default if fetch fails
        if (rawEvent.rawUrl) {
          try {
            console.log(
              `[${SCRAPER_ID}] Navigating to detail page: ${rawEvent.rawUrl}`
            );
            await page.goto(rawEvent.rawUrl, {
              waitUntil: "networkidle0",
              timeout: 60000,
            });

            // --- Log Detail Page Main Content Area HTML --- START
            try {
              const detailPageHTML = await page.evaluate(() => {
                const mainElement = document.querySelector("main");
                if (mainElement) {
                  return mainElement.outerHTML;
                }
                console.warn(
                  `[${SCRAPER_ID}] Detail page <main> not found, logging body.`
                );
                return document.body.outerHTML;
              });
              console.log(
                `[${SCRAPER_ID}] Detail page HTML snapshot (${
                  rawEvent.rawUrl
                }):\n${detailPageHTML.substring(0, 4000)}...`
              );
            } catch (logError) {
              console.error(
                `[${SCRAPER_ID}] Failed to get detail page HTML for debugging:`,
                logError
              );
            }
            // --- Log Detail Page Main Content Area HTML --- END

            // Wait for the main content area to likely contain the description
            const descriptionContainerSelector = "div.right.fadeInt";
            await page.waitForSelector(descriptionContainerSelector, {
              timeout: 30000,
            });

            // Extract description HTML from paragraphs within the container
            const descriptionHtml = await page.evaluate((selector) => {
              const container = document.querySelector(selector);
              if (!container) return "";
              // Select all paragraphs within the container
              const paragraphs = container.querySelectorAll("p");
              // Filter out potential empty paragraphs or those with just &nbsp;
              const relevantParagraphs = Array.from(paragraphs).filter(
                (p) =>
                  p.textContent?.trim() && p.textContent.trim() !== "&nbsp;"
              );
              // Get innerHTML of relevant paragraphs
              return relevantParagraphs.map((p) => p.innerHTML).join("\n\n"); // Join paragraphs with double newline
            }, descriptionContainerSelector);

            if (descriptionHtml) {
              description = convertHtmlToMarkdown(descriptionHtml);
            } else {
              console.warn(
                `[${SCRAPER_ID}] Could not find description paragraphs on detail page: ${rawEvent.rawUrl}`
              );
            }
          } catch (detailError) {
            console.error(
              `[${SCRAPER_ID}] Error fetching description from ${rawEvent.rawUrl}:`,
              detailError
            );
          }
        }
        // --- Fetch Description from Event Page --- END

        // --- Generate unique ID using slug from URL --- START
        let external_id = "";
        if (rawEvent.rawUrl) {
          try {
            const urlParts = rawEvent.rawUrl
              .split("/")
              .filter((part) => part.length > 0);
            // The slug is expected to be the last part before '/period/'
            // Find the index of 'calendar'
            const calendarIndex = urlParts.indexOf("calendar");
            if (calendarIndex !== -1 && calendarIndex + 1 < urlParts.length) {
              // The slug is the part after 'calendar'
              const slug = urlParts[calendarIndex + 1];
              // Check if the next part is 'period' to confirm structure
              if (
                urlParts.length > calendarIndex + 2 &&
                urlParts[calendarIndex + 2] === "period"
              ) {
                external_id = `${SCRAPER_ID}-${slug}`;
              } else {
                console.warn(
                  `[${SCRAPER_ID}] Unexpected URL structure after slug for ${rawEvent.rawUrl}. Falling back to title/date ID.`
                );
              }
            }
          } catch (e) {
            console.error(
              `[${SCRAPER_ID}] Error extracting slug from URL ${rawEvent.rawUrl}:`,
              e
            );
          }
        }

        // Fallback ID generation if URL slug extraction fails
        if (!external_id) {
          console.warn(
            `[${SCRAPER_ID}] Could not extract slug from URL "${rawEvent.rawUrl}" for title "${title}". Generating fallback ID.`
          );
          const dateSlug = format(eventDate, "yyyyMMdd");
          // Basic fallback slug from title (lowercase, alphanumeric, hyphen)
          const fallbackTitleSlug = title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .substring(0, 50);
          external_id = `${SCRAPER_ID}-${dateSlug}-${fallbackTitleSlug}`;
        }
        // --- Generate unique ID using slug from URL --- END

        // Avoid adding duplicates if somehow processed twice
        if (uniqueEventIds.has(external_id)) {
          console.warn(
            `[${SCRAPER_ID}] Duplicate external_id detected: ${external_id} for title "${title}". Skipping.`
          );
          continue;
        }
        uniqueEventIds.add(external_id);

        const event: Event = {
          title: title,
          description: description,
          start_at: startTimeIso, // Already in ISO format
          end_at: endTimeIso ?? undefined, // Use parsed end time or undefined
          url: rawEvent.rawUrl || calendarUrl, // Fallback to calendar URL if specific event URL isn't found
          location: LOCATION_NAME,
          external_id: external_id,
        };

        allEvents.push(event);
      } catch (processingError) {
        console.error(
          `[${SCRAPER_ID}] Error processing event data for "${rawEvent.rawTitle}":`,
          processingError
        );
      }
    }

    console.log(
      `[${SCRAPER_ID}] Finished processing. Found ${allEvents.length} valid events within the date range.`
    );

    // Validate all collected events
    try {
      // Use safeParse to get detailed error info if validation fails
      const validationResult = EventsArraySchema.safeParse(allEvents);
      if (!validationResult.success) {
        // Log the specific validation errors
        console.error(
          `[${SCRAPER_ID}] Zod validation error: \n${JSON.stringify(
            validationResult.error.flatten(),
            null,
            2
          )}`
        );
        // Log the events that failed validation for easier debugging
        console.error(
          `[${SCRAPER_ID}] Failing events data: \n${JSON.stringify(
            allEvents,
            null,
            2
          )}`
        );
        throw new Error(
          `[${SCRAPER_ID}] Event validation failed. See logs for details.`
        );
      }
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.data.length} events.`
      );
      return validationResult.data; // Return the validated data
    } catch (validationError) {
      console.error(`[${SCRAPER_ID}] Validation failed:`, validationError);
      // Rethrow or return empty based on desired error handling
      throw validationError; // Re-throw the error to indicate failure
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] An unexpected error occurred:`, error);
    return []; // Return empty array on major failure
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
    // Runner manages closing the browser instance
  }
};

// Export the scraper object conforming to the Scraper interface
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeDiaBeaconEvents,
};

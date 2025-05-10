import type { Scraper, Event, ScrapeOptions } from "../types.js";
import {
  parse,
  format,
  isValid,
  isWithinInterval,
  startOfDay,
  endOfDay,
  formatISO,
  parseISO,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { EventsArraySchema } from "../utils/validation.js";
import { formatDate } from "../utils/date.js"; // Assuming a helper like this exists
import { convertHtmlToMarkdown } from "../utils/markdown.js";

// Define the timezone for Beacon, NY - Used for context, not direct date-fns-tz usage
const TIMEZONE = "America/New_York";

// Interface for raw data extracted within page.evaluate
interface RawEventData {
  title: string;
  url: string;
  location: string;
  description: string;
  rawDateTime: string;
  external_id: string;
}

// Helper to parse date/time strings like "Saturday, April 5, 2025 | 8:30 pm"
function parseEventDateTime(dateTimeString: string): {
  datePart?: string;
  timePart?: string;
} {
  const parts = dateTimeString.split("|").map((s) => s.trim());
  if (parts.length >= 2) {
    return { datePart: parts[0], timePart: parts[1] };
  }
  if (parts.length === 1) {
    // Assume it's just the date part if time is missing
    return { datePart: parts[0], timePart: undefined };
  }
  return {};
}

// Helper function to zero-pad numbers
function pad(num: number): string {
  return num.toString().padStart(2, "0");
}

// Helper to convert parsed date/time parts to an ISO string in UTC
function convertToISO(
  datePart?: string,
  timePart?: string
): string | undefined {
  const cleanDatePart = datePart?.replace(/^[A-Za-z]+,\s*/, "").trim();
  const standardTimePart = timePart
    ?.replace(/\s*(am|pm)/i, (match) => match.toUpperCase())
    .trim();
  const formatString = standardTimePart
    ? "MMMM d, yyyy h:mm a"
    : "MMMM d, yyyy";
  const combinedString = standardTimePart
    ? `${cleanDatePart} ${standardTimePart}`
    : cleanDatePart;

  if (!combinedString) return undefined;

  try {
    const referenceDate = new Date();
    // 1. Parse the original string
    const parsedDate = parse(combinedString, formatString, referenceDate);

    if (!isValid(parsedDate)) {
      return undefined;
    }

    // 2. Format using NY timezone to get ISO string with correct offset
    const nyIsoWithOffset = formatInTimeZone(
      parsedDate,
      TIMEZONE,
      "yyyy-MM-dd'T'HH:mm:ssXXX" // Format includes offset
    );

    // 3. Parse *that* string to get the correct UTC Date object
    const utcDate = parseISO(nyIsoWithOffset);

    if (!isValid(utcDate)) {
      return undefined;
    }

    // 4. Manually construct the final ISO string with '.000Z' from the UTC Date object
    //    to match the validation regex requirement.
    const year = utcDate.getUTCFullYear();
    const month = pad(utcDate.getUTCMonth() + 1); // Months are 0-indexed
    const day = pad(utcDate.getUTCDate());
    const hours = pad(utcDate.getUTCHours());
    const minutes = pad(utcDate.getUTCMinutes());
    const seconds = pad(utcDate.getUTCSeconds());
    const milliseconds = "000"; // Add milliseconds

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}Z`;
  } catch (e) {
    console.error(
      `[${SCRAPER_ID}] Error converting date string to UTC: "${combinedString}"`,
      e
    );
    return undefined;
  }
}

async function scrapeTowneCrierStage(options: ScrapeOptions, stagePath: string, scraperId: string, locationName: string): Promise<Event[]> {
  const { startDate, endDate, browser } = options;
  const url = "https://townecrier.com" + stagePath;
  const events: Event[] = [];
  const endDateOrStartDate = endDate ?? startDate;
  // Define the interval once before the loop
  const interval = {
    start: startOfDay(startDate),
    end: endOfDay(endDateOrStartDate),
  };

  console.log(
    `[${scraperId}] Scraping Towne Crier from ${formatDate(
      startDate
    )} to ${formatDate(endDateOrStartDate)}`
  );

  let page: import("puppeteer").Page | undefined;

  try {
    if (!browser) {
      throw new Error("Browser instance is required for this scraper.");
    }
    page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    console.log(`[${SCRAPER_ID}] Main page loaded. Extracting event list...`);

    const eventElementsData = await page.evaluate(
      (scraperId, locationName): RawEventData[] => {
        const rawEvents: RawEventData[] = [];
        // Corrected selector for individual event items
        const eventNodes = document.querySelectorAll("a.event-item");

        eventNodes.forEach((node, index) => {
          // Cast node to HTMLAnchorElement to easily access href
          const eventNode = node as HTMLAnchorElement;

          // Updated selectors based on HTML analysis
          const titleElement = eventNode.querySelector("h3");
          const dateTimeElement = eventNode.querySelector("span");
          const descriptionElement = eventNode.querySelector("p");

          const title = titleElement?.textContent?.trim();
          const eventUrl = eventNode?.href; // Get href from the <a> tag itself
          const dateTimeString = dateTimeElement?.textContent?.trim();
          const description = descriptionElement?.textContent
            ?.trim()
            // Remove trailing [...] and also leading/trailing whitespace again
            ?.replace(/\[\.\.\.\]$/, "")
            .trim();

          if (title && eventUrl && dateTimeString && description) {
            const rawEvent: RawEventData = {
              title,
              url: eventUrl,
              location: locationName,
              description,
              rawDateTime: dateTimeString,
              external_id: `${scraperId}-${eventUrl}`, // Use URL for uniqueness
            };
            rawEvents.push(rawEvent);
          } else {
            // Improved logging for debugging missing fields
            // Using template literal to fix linter warning
            const missingFields = [
              !title ? "title" : null,
              !eventUrl ? "url" : null,
              !dateTimeString ? "dateTime" : null,
              !description ? "description" : null,
            ]
              .filter(Boolean)
              .join(", ");

            console.warn(
              `[${scraperId}] Skipping event index ${index} at URL ${
                eventUrl || "N/A"
              } ` + `due to missing data: ${missingFields}`
            );
          }
        });

        return rawEvents;
      },
      scraperId,
      locationName
    );

    console.log(
      `[${SCRAPER_ID}] Found ${eventElementsData.length} raw event elements. Processing and filtering...`
    );

    // Process raw event data outside the browser context
    for (const rawEvent of eventElementsData) {
      // 1. Parse Date/Time first
      const { datePart, timePart } = parseEventDateTime(rawEvent.rawDateTime);
      const start_at = convertToISO(datePart, timePart);

      if (!start_at) {
        console.warn(
          `[${SCRAPER_ID}] Skipping event (invalid date format): ${rawEvent.title}`
        );
        continue;
      }

      // 2. Check if date is within range BEFORE fetching details
      let eventStartDate: Date;
      try {
        eventStartDate = parseISO(start_at);
        if (!isValid(eventStartDate)) {
          console.warn(
            `[${SCRAPER_ID}] Skipping event (invalid parsed date): ${rawEvent.title} - ${start_at}`
          );
          continue;
        }
      } catch (dateError) {
        console.error(
          `[${SCRAPER_ID}] Error parsing date for ${rawEvent.title}:`,
          dateError
        );
        continue;
      }

      if (!isWithinInterval(eventStartDate, interval)) {
        // Optional logging for skipped events outside the date range
        // console.log(`[${SCRAPER_ID}] Skipping event outside date range: ${rawEvent.title} (${formatDate(eventStartDate)})`);
        continue; // Skip this event entirely, no need to fetch details
      }

      // 3. Date is valid and within range, NOW fetch full description
      console.log(
        `[${SCRAPER_ID}] Event within range, fetching details: ${rawEvent.title}`
      );
      let fullDescription = rawEvent.description; // Default to truncated description

      if (rawEvent.url) {
        try {
          console.log(
            `[${SCRAPER_ID}] Navigating to detail page: ${rawEvent.url}`
          );
          await page.goto(rawEvent.url, {
            waitUntil: "networkidle0",
            timeout: 60000,
          });

          // Selector suggested by user for the description content
          const descriptionContainerSelector = ".em-event-content";
          await page.waitForSelector(descriptionContainerSelector, {
            timeout: 30000,
          });

          // Get HTML using the new selector
          const descriptionContainerHtml = await page.$eval(
            descriptionContainerSelector,
            (el) => el.innerHTML
          );

          if (descriptionContainerHtml) {
            // Convert the HTML from the new container
            fullDescription = convertHtmlToMarkdown(descriptionContainerHtml);
            // --- DEBUG: Log the converted Markdown ---
            console.log(
              `[${SCRAPER_ID} DEBUG] Converted Markdown (length ${
                fullDescription?.length
              }):\n${fullDescription?.substring(
                0,
                500
              )}...\n--- END MARKDOWN ---`
            );
            // --- END DEBUG ---
            console.log(
              `[${SCRAPER_ID}] Extracted and converted HTML from (${descriptionContainerSelector}) container.`
            );
          } else {
            console.warn(
              `[${SCRAPER_ID}] Description element (${descriptionContainerSelector}) found but innerHTML was empty for ${rawEvent.title}.`
            );
          }
        } catch (detailError) {
          console.error(
            `[${SCRAPER_ID}] Error fetching/parsing details for ${rawEvent.title} at ${rawEvent.url}:`,
            detailError
          );
          // Keep the truncated description if detail fetching fails
        }
      } else {
        console.warn(
          `[${SCRAPER_ID}] Event ${rawEvent.title} has no URL, cannot fetch full description.`
        );
      }

      // 4. Construct final event object
      const event: Event = {
        title: rawEvent.title,
        start_at: start_at,
        end_at: undefined,
        url: rawEvent.url,
        location: rawEvent.location,
        description: fullDescription,
        external_id: rawEvent.external_id,
      };
      events.push(event);
    } // End for loop

    // Validate the final list of events against the schema
    const validationResult = EventsArraySchema.safeParse(events);
    if (!validationResult.success) {
      // Log detailed validation errors if parsing fails
      console.error(
        `[${SCRAPER_ID}] Zod validation error:`,
        validationResult.error.errors
      );
      // Throw an error to indicate that the scraper produced invalid data
      throw new Error(
        `[${SCRAPER_ID}] Event validation failed: ${JSON.stringify(
          validationResult.error
        )}`
      );
    }

    console.log(
      `[${SCRAPER_ID}] Finished processing. Found ${validationResult.data.length} valid events within the date range.`
    );
    return validationResult.data;
  } catch (error) {
    console.error(`[${SCRAPER_ID}] Error scraping Towne Crier:`, error);
    return []; // Return empty array on major error during scraping
  } finally {
    // Ensure the Puppeteer page is closed even if errors occurred
    if (page && !page.isClosed()) {
      await page.close();
      console.log(`[${SCRAPER_ID}] Browser page closed.`);
    }
  }
}

export const scraper: Scraper = {
  id: "towne-crier-main",
  name: "Towne Crier (Main Stage)",
  scrape: (options) => scrapeTowneCrierStage(options, "/main-stage/", "towne-crier-main", "Towne Crier"),
};

export const salonScraper: Scraper = {
  id: "towne-crier-salon",
  name: "Towne Crier (Salon Stage)",
  scrape: (options) => scrapeTowneCrierStage(options, "/salon-stage/", "towne-crier-salon", "Towne Crier"),
};

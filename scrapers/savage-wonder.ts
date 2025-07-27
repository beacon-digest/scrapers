import { isWithinInterval } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import ical from "ical";
import slugify from "slugify";

import type { Event, ScrapeOptions, Scraper } from "../types.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "savage-wonder";
const LOCATION_NAME = "Savage Wonder";
const TIME_ZONE = "America/New_York";
// Use https instead of webcal protocol for compatibility with node-fetch
const ICAL_URL =
  "https://savagewonder.org/?post_type=tribe_events&ical=1&eventDisplay=list";

/**
 * Scrapes events from the Savage Wonder iCal feed.
 */
const scrapeSavageWonderEvents = async (
  options: ScrapeOptions,
): Promise<Event[]> => {
  const { startDate, endDate = startDate } = options;

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatInTimeZone(
      startDate,
      TIME_ZONE,
      "yyyy-MM-dd",
    )} to ${formatInTimeZone(endDate, TIME_ZONE, "yyyy-MM-dd")}...`,
  );

  try {
    // Fetch the iCal feed
    console.log(`[${SCRAPER_ID}] Fetching iCal feed from ${ICAL_URL}...`);
    const response = await fetch(ICAL_URL);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch iCal feed: ${response.status} ${response.statusText}`,
      );
    }

    const icalData = await response.text();
    console.log(`[${SCRAPER_ID}] Fetched iCal data, parsing...`);

    // Parse the iCal data
    const events = ical.parseICS(icalData);
    console.log(
      `[${SCRAPER_ID}] Found ${Object.keys(events).length} events in iCal feed.`,
    );

    // Filter and transform events
    const allEvents: Event[] = [];

    for (const [uid, event] of Object.entries(events)) {
      // Skip non-VEVENT items
      if (event.type !== "VEVENT") continue;

      // Skip events without summary, start, or end
      if (!event.summary || !event.start || !event.end) {
        console.warn(
          `[${SCRAPER_ID}] Skipping event with missing required data: ${event.summary || "Unnamed event"}`,
        );
        continue;
      }

      // Get start and end dates
      const eventStart = event.start;
      const eventEnd = event.end;

      // Skip events outside our date range
      if (
        !isWithinInterval(eventStart, { start: startDate, end: endDate }) &&
        !isWithinInterval(eventEnd, { start: startDate, end: endDate }) &&
        !(startDate >= eventStart && endDate <= eventEnd) // Event spans our entire range
      ) {
        continue;
      }

      // Create a slug from the event summary for the external_id
      const titleSlug = slugify(event.summary || "event", {
        lower: true,
        strict: true,
      });
      const dateStr = formatInTimeZone(eventStart, TIME_ZONE, "yyyy-MM-dd");
      const externalId = `${SCRAPER_ID}-${dateStr}-${titleSlug}`;

      // Get the description
      const description = event.description || "";

      // Get location details
      const location = event.location || "";
      let eventDescription = description;

      // Add location details to description if available
      if (location) {
        eventDescription += `\n\n**Location Details:** ${location}`;
      }

      // Create the event object
      const scrapedEvent: Event = {
        title: event.summary,
        description: eventDescription,
        location: LOCATION_NAME,
        start_at: eventStart.toISOString(),
        end_at: eventEnd.toISOString(),
        url: event.url || undefined,
        external_id: externalId,
      };

      allEvents.push(scrapedEvent);
    }

    console.log(
      `[${SCRAPER_ID}] Found ${allEvents.length} events within specified date range.`,
    );

    // Validate events before returning
    try {
      const validatedEvents = EventsArraySchema.parse(allEvents);
      console.log(
        `[${SCRAPER_ID}] Validation successful for ${validatedEvents.length} events.`,
      );
      return validatedEvents;
    } catch (validationError) {
      console.error(`[${SCRAPER_ID}] Validation error:`, validationError);
      throw new Error(
        `[${SCRAPER_ID}] Event validation failed: ${JSON.stringify(validationError)}`,
      );
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] Error scraping events:`, error);
    return []; // Return empty array on failure
  }
};

// Export the scraper object conforming to the Scraper interface
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeSavageWonderEvents,
};

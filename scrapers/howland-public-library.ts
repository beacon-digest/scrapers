import puppeteer from "puppeteer";
import { format } from "date-fns";
import type { Event } from "../types.js";
import TurndownService from "turndown";
import { z } from "zod";
import { decode } from "html-entities";

const BASE_URL = "https://beaconlibrary.assabetinteractive.com/calendar";

// Initialize turndown service
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  bulletListMarker: "-",
  strongDelimiter: "**",
  linkStyle: "inlined",
  linkReferenceStyle: "full",
  br: "",
  blankReplacement: (content) => "\n\n",
});

// Define Zod schema for event validation
const EventSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  start_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:.\d{3}Z)?$/,
      "start_at must be in ISO format YYYY-MM-DDThh:mm:ss or YYYY-MM-DDThh:mm:ss.sssZ"
    ),
  end_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:.\d{3}Z)?$/,
      "end_at must be in ISO format YYYY-MM-DDThh:mm:ss or YYYY-MM-DDThh:mm:ss.sssZ"
    )
    .optional(),
  url: z.string().url("URL must be a valid URL"),
  location: z.string().min(1, "Location is required"),
  external_id: z.string().min(1, "External ID is required"),
});

// Define Zod schema for events array
const EventsArraySchema = z.array(EventSchema);

// Type for validated events
type ValidatedEvent = z.infer<typeof EventSchema>;

export async function scrape(
  targetDate: Date,
  externalBrowser?: puppeteer.Browser
): Promise<Event[]> {
  // Use provided browser or create a new one if not provided
  const browser =
    externalBrowser ||
    (await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 60000, // Increase timeout to 60 seconds
      // Use the installed browser instead of downloading a new one
      executablePath:
        process.platform === "darwin" && process.arch === "arm64"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : undefined,
    }));

  // Set a flag to determine if we should close the browser at the end
  const shouldCloseBrowser = !externalBrowser;

  try {
    const page = await browser.newPage();

    // Format date for URL
    const formattedDate = format(targetDate, "yyyy-MMMM").toLowerCase();
    const url = `${BASE_URL}/${formattedDate}`;

    console.log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });

    // Wait for calendar to load
    await page.waitForSelector("script[type='application/ld+json']", {
      timeout: 60000,
    });

    console.log("Calendar loaded, extracting events...");

    // Extract all JSON-LD scripts which contain event data
    const events = await page.evaluate((targetDateStr) => {
      const scripts = Array.from(
        document.querySelectorAll("script[type='application/ld+json']")
      );
      const targetDate = new Date(targetDateStr);
      const targetDateString = targetDate.toISOString().split("T")[0];

      console.log(`Looking for events on: ${targetDateString}`);

      const eventsList: Event[] = [];

      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent || "");
          if (
            data["@type"] === "Event" &&
            data.startDate === targetDateString
          ) {
            console.log(`Found event: ${data.name}`);

            // Extract external_id from URL - get the last segment before any trailing slash
            const external_id = data.url
              ? data.url.split("/").filter(Boolean).pop() || ""
              : "";

            const event: Event = {
              title: data.name,
              description: data.description || "",
              start_at: `${data.startDate}T00:00:00`, // Placeholder, will be updated
              end_at: `${data.endDate}T23:59:59`, // Placeholder, will be updated
              url: data.url || "",
              location: "Howland Public Library",
              external_id,
            };

            eventsList.push(event);
          }
        } catch (e) {
          console.error("Error parsing event data:", e);
        }
      }

      return eventsList;
    }, targetDate.toISOString());

    // For each event, navigate to its page and get the full description and times
    for (const event of events) {
      if (event.url) {
        console.log(`Navigating to event page: ${event.url}`);
        await page.goto(event.url, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });

        // Wait for the description to load
        await page.waitForSelector(".event-description", { timeout: 60000 });

        // Get the full event date and time text from the header
        let headerText = "";
        try {
          headerText = await page.$eval(
            "h3.event-meta",
            (el) => el.textContent || ""
          );
          console.log("Event header text:", headerText);
        } catch (error) {
          console.warn("Could not find h3.event-meta");
        }

        // Extract date information from header or parent of time span
        let eventDate = "";

        // Try to extract from header first (format: "Wednesday, April 16...")
        const headerDateMatch = headerText.match(
          /([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})/
        );

        if (headerDateMatch) {
          const [, dayOfWeek, month, day] = headerDateMatch;
          // Extract year from the original start date
          const year = event.start_at.split("-")[0];
          eventDate = `${year}-${getMonthNumber(month)}-${day.padStart(
            2,
            "0"
          )}`;
          console.log(`Extracted date from header: ${eventDate}`);
        } else {
          // If no header match, use the original date from JSON-LD
          eventDate = event.start_at.split("T")[0];
          console.log(`Using original date: ${eventDate}`);
        }

        // Get the time text
        const timeText = await page.$eval(
          "span.event-time",
          (el) => el.textContent || ""
        );
        console.log("Found time text:", timeText);

        // Helper function to get month number from name
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
          };
          return months[monthName.toLowerCase()] || "01";
        }

        // Extract times using regex, handling formats like "12:00—2:30 PM"
        let startTime: string | undefined;
        let endTime: string | undefined;

        const timeMatch = timeText.match(
          /(\d{1,2}):(\d{2})(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i
        );

        if (timeMatch) {
          const [, startHour, startMin, endHour, endMin, period] = timeMatch;

          // Convert 12-hour format to 24-hour format
          const convert12to24 = (
            hour: string,
            min: string,
            isPM: boolean
          ): string => {
            let h = Number.parseInt(hour, 10);
            if (isPM && h !== 12) h += 12;
            if (!isPM && h === 12) h = 0;
            return `${h.toString().padStart(2, "0")}:${min}:00`;
          };

          const isPM = period.toUpperCase() === "PM";
          startTime = convert12to24(startHour, startMin, isPM);
          endTime = convert12to24(endHour, endMin, isPM);
        } else {
          // Try alternate format with single period, like "7-8 PM"
          const simplifiedMatch = timeText.match(
            /(\d{1,2})(?:—|-|\s+to\s+)(\d{1,2})\s*(AM|PM)/i
          );

          if (simplifiedMatch) {
            const [, startHour, endHour, period] = simplifiedMatch;

            // Convert 12-hour format to 24-hour format
            const convert12to24 = (hour: string, isPM: boolean): string => {
              let h = Number.parseInt(hour, 10);
              if (isPM && h !== 12) h += 12;
              if (!isPM && h === 12) h = 0;
              return `${h.toString().padStart(2, "0")}:00:00`;
            };

            const isPM = period.toUpperCase() === "PM";
            startTime = convert12to24(startHour, isPM);
            endTime = convert12to24(endHour, isPM);
          } else {
            // Try format like "10:00 AM—1:00 PM" (separate AM/PM for each time)
            const mixedMatch = timeText.match(
              /(\d{1,2}):(\d{2})\s*(AM|PM)(?:—|-|\s+to\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i
            );

            if (mixedMatch) {
              const [
                ,
                startHour,
                startMin,
                startPeriod,
                endHour,
                endMin,
                endPeriod,
              ] = mixedMatch;

              // Convert 12-hour format to 24-hour format
              const convert12to24 = (
                hour: string,
                min: string,
                period: string
              ): string => {
                let h = Number.parseInt(hour, 10);
                const isPM = period.toUpperCase() === "PM";
                if (isPM && h !== 12) h += 12;
                if (!isPM && h === 12) h = 0;
                return `${h.toString().padStart(2, "0")}:${min}:00`;
              };

              startTime = convert12to24(startHour, startMin, startPeriod);
              endTime = convert12to24(endHour, endMin, endPeriod);
              console.log(
                `Parsed mixed time format: ${startTime} to ${endTime}`
              );
            }
          }
        }

        // Get the description
        const description = await page.$eval(
          ".event-description",
          (el) => el.innerHTML
        );

        // Decode HTML entities in the title and description
        event.title = decode(event.title);

        // First decode HTML entities
        const decodedDescription = decode(description);

        // Then convert to Markdown
        event.description = turndownService.turndown(decodedDescription);

        // Update times with the correct date from the event page
        if (startTime) {
          // Format the date and time as ISO 8601 with timezone offset
          const startDate = new Date(`${eventDate}T${startTime}`);
          event.start_at = startDate.toISOString();
          console.log(`Parsed start time: ${startTime} -> ${event.start_at}`);
        }

        if (endTime) {
          // Format the date and time as ISO 8601 with timezone offset
          const endDate = new Date(`${eventDate}T${endTime}`);
          event.end_at = endDate.toISOString();
          console.log(`Parsed end time: ${endTime} -> ${event.end_at}`);
        }
      }
    }

    console.log(
      `Found ${events.length} events for ${format(targetDate, "yyyy-MM-dd")}`
    );

    // Validate events using Zod schema
    try {
      const validationResult = EventsArraySchema.parse(events);
      return validationResult as Event[];
    } catch (error) {
      console.error("Validation error:", error);
      throw new Error(`Event validation failed: ${JSON.stringify(error)}`);
    }
  } catch (error) {
    console.error("Error scraping events:", error);
    return [];
  } finally {
    // Only close the browser if we created it
    if (shouldCloseBrowser) {
      await browser.close();
    }
  }
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  // Parse date from command line argument if provided
  let targetDate: Date;

  if (process.argv[2]) {
    // Use the provided date string (format: YYYY-MM-DD)
    const dateArg = process.argv[2];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      console.error("Invalid date format. Please use YYYY-MM-DD");
      process.exit(1);
    }
    targetDate = new Date(dateArg);
  } else {
    // Default to today if no date provided
    targetDate = new Date();
  }

  console.log("Target date:", targetDate.toISOString());
  console.log("Formatted month:", format(targetDate, "MMMM").toLowerCase());
  scrape(targetDate)
    .then((events: Event[]) => {
      console.log(JSON.stringify(events, null, 2));
    })
    .catch((error: Error) => {
      console.error("Scraping failed:", error);
      process.exit(1);
    });
}

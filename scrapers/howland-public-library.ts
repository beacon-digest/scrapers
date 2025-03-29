import puppeteer from "puppeteer";
import { format } from "date-fns";
import type { Event } from "../types.js";
import TurndownService from "turndown";
import { z } from "zod";

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
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
      "start_at must be in ISO format YYYY-MM-DDThh:mm:ss"
    ),
  end_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
      "end_at must be in ISO format YYYY-MM-DDThh:mm:ss"
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

export async function scrape(targetDate: Date): Promise<Event[]> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
    timeout: 30000,
  });

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

        // Get the time text separately
        const timeText = await page.$eval(
          "span.event-time",
          (el) => el.textContent || ""
        );
        console.log("Found time text:", timeText);

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
        }

        // Get the description
        const description = await page.$eval(
          ".event-description",
          (el) => el.innerHTML
        );

        // First decode HTML entities
        const decodedDescription = description
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'");

        // Then convert to Markdown
        event.description = turndownService.turndown(decodedDescription);

        // Update times only if they exist
        const [datePart] = event.start_at.split("T");
        event.start_at = startTime
          ? `${datePart}T${startTime}`
          : event.start_at;
        event.end_at = endTime ? `${datePart}T${endTime}` : event.end_at;
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
    await browser.close();
  }
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  // Create date in local timezone
  const targetDate = new Date(2025, 2, 1); // March 1, 2025
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

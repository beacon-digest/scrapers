import { scrape } from "../scrapers/howland-public-library.js";
import { postEventsToNotion } from "../api/notion-poster.js";
import type { Event } from "../types.js";
import dotenv from "dotenv";
import puppeteer from "puppeteer";

// Load environment variables
dotenv.config();

/**
 * Add days to a date
 * @param date Base date
 * @param days Number of days to add
 * @returns New date with days added
 */
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Format date as YYYY-MM-DD
 * @param date Date to format
 * @returns Formatted date string
 */
function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Generate an array of dates between start and end (inclusive)
 * @param startDate Start date
 * @param endDate End date
 * @returns Array of dates
 */
function getDatesInRange(startDate: Date, endDate: Date): Date[] {
  const dates: Date[] = [];
  let currentDate = new Date(startDate);

  // Add each date until we reach the end date
  while (currentDate <= endDate) {
    dates.push(new Date(currentDate));
    currentDate = addDays(currentDate, 1);
  }

  return dates;
}

/**
 * Process multiple dates with a single shared browser instance
 * @param dates Array of dates to process
 * @returns Array of all events found across all dates
 */
async function scrapeWithSharedBrowser(dates: Date[]): Promise<Event[]> {
  // Launch browser once with increased timeout and appropriate options for Apple Silicon
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    timeout: 60000, // Increase timeout to 60 seconds
    // Use the installed browser instead of downloading a new one
    executablePath:
      process.platform === "darwin" && process.arch === "arm64"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined,
  });

  const allEvents: Event[] = [];

  try {
    // Process each date with the same browser instance
    for (const date of dates) {
      console.log(`\nProcessing date: ${formatDate(date)}`);
      try {
        const events = await scrape(date, browser);
        console.log(`Found ${events.length} events for ${formatDate(date)}`);
        allEvents.push(...events);
      } catch (error) {
        console.error(`Error scraping events for ${formatDate(date)}:`, error);
      }
    }
  } finally {
    // Close browser when done with all dates
    await browser.close();
  }

  return allEvents;
}

/**
 * Scrape events for a date range and post them to Notion
 * @param startDate Start date of range
 * @param endDate End date of range (optional, defaults to startDate)
 */
async function scrapeAndPostDateRange(
  startDate: Date,
  endDate?: Date
): Promise<void> {
  // If no end date provided, use start date
  const finalEndDate = endDate || startDate;

  // Get all dates in the range
  const dates = getDatesInRange(startDate, finalEndDate);

  console.log(
    `Scraping events for ${dates.length} day(s) from ${formatDate(
      startDate
    )} to ${formatDate(finalEndDate)}`
  );

  // Use the shared browser to process all dates
  const allEvents = await scrapeWithSharedBrowser(dates);

  if (allEvents.length === 0) {
    console.log("No events found in the date range");
    return;
  }

  console.log(`\nTotal events found: ${allEvents.length}`);

  // Post events to Notion
  console.log("Posting events to Notion...");
  try {
    const pageIds = await postEventsToNotion(allEvents);
    console.log(`Successfully posted ${pageIds.length} events to Notion`);
  } catch (error) {
    console.error("Error posting events to Notion:", error);
  }
}

// Example usage when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check for required environment variables
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    console.error("Required environment variables are not set!");
    console.error("Make sure you have a .env file with:");
    console.error("  NOTION_API_KEY=your_notion_api_key");
    console.error("  NOTION_DATABASE_ID=your_notion_database_id");
    process.exit(1);
  }

  // Parse command line arguments
  const startDateArg = process.argv[2];
  const endDateArg = process.argv[3];

  if (!startDateArg) {
    console.error("Please provide a start date in YYYY-MM-DD format");
    console.error(
      "Usage: pnpm exec tsx runners/library.ts <start-date> [end-date]"
    );
    process.exit(1);
  }

  // Validate date format
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (
    !datePattern.test(startDateArg) ||
    (endDateArg && !datePattern.test(endDateArg))
  ) {
    console.error("Dates must be in YYYY-MM-DD format");
    process.exit(1);
  }

  // Parse dates
  const startDate = new Date(startDateArg);
  let endDate: Date | undefined;

  if (endDateArg) {
    endDate = new Date(endDateArg);
    // Check if end date is before start date
    if (endDate < startDate) {
      console.error("End date cannot be before start date");
      process.exit(1);
    }
  }

  // Run the scrape and post process
  scrapeAndPostDateRange(startDate, endDate)
    .then(() => {
      console.log("Process completed");
    })
    .catch((error) => {
      console.error("Process failed:", error);
      process.exit(1);
    });
}

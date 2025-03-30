import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { parse as parseDate, isValid as isValidDate } from "date-fns";
import dotenv from "dotenv";
import type { ScrapeOptions } from "../types.js";
import type { Browser } from "puppeteer";

import { findScraperById, scrapers } from "../scrapers/index.js";
import { postEventsToNotion } from "../api/notion-poster.js";
import { getBrowserInstance, closeBrowserInstance } from "../utils/browser.js";
import { formatDate } from "../utils/date.js"; // Only need formatDate here

// Load environment variables from .env file
dotenv.config();

// --- Main Function ---
async function main() {
  // --- Argument Parsing ---
  const argv = await yargs(hideBin(process.argv))
    .scriptName("scrape-and-post")
    .usage(
      "$0 --scraper <id> --start-date <yyyy-mm-dd> [--end-date <yyyy-mm-dd>]"
    )
    .option("scraper", {
      alias: "s",
      description: "The ID of the scraper to run",
      type: "string",
      demandOption: true, // Make scraper ID required
      choices: scrapers.map((s) => s.id), // Provide available choices
    })
    .option("start-date", {
      alias: "d",
      description: "Start date for scraping (YYYY-MM-DD)",
      type: "string",
      demandOption: true,
    })
    .option("end-date", {
      alias: "e",
      description: "End date for scraping (YYYY-MM-DD, defaults to start-date)",
      type: "string",
    })
    .option("dry-run", {
      alias: "n",
      description:
        "Perform scraping but do not post to Notion, just log results",
      type: "boolean",
      default: false,
    })
    .check((argv) => {
      // Validate date formats
      const dateFormat = "yyyy-MM-dd";
      // Explicitly treat as string for parsing
      const startStr = argv.startDate as string;
      const startDate = parseDate(startStr, dateFormat, new Date());
      if (!isValidDate(startDate)) {
        throw new Error(
          `Invalid start-date format: ${startStr}. Please use YYYY-MM-DD.`
        );
      }
      if (argv.endDate) {
        const endStr = argv.endDate as string;
        const endDate = parseDate(endStr, dateFormat, new Date());
        if (!isValidDate(endDate)) {
          throw new Error(
            `Invalid end-date format: ${endStr}. Please use YYYY-MM-DD.`
          );
        }
        if (endDate < startDate) {
          throw new Error(
            `End date (${endStr}) cannot be before start date (${startStr}).`
          );
        }
      }
      // Scraper ID validity is implicitly checked by `choices` above
      return true;
    })
    .help()
    .alias("help", "h")
    .strict().argv; // Report errors for unknown options

  // --- Environment Variable Check ---
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    console.error(
      "❌ Error: Required environment variables NOTION_API_KEY or NOTION_DATABASE_ID are not set."
    );
    console.error("   Please ensure you have a .env file with these values.");
    process.exit(1);
  }

  console.log("✅ Environment variables loaded.");

  // --- Scraper Selection and Date Parsing ---
  const scraperId = argv.scraper;
  const scraper = findScraperById(scraperId);

  if (!scraper) {
    // This should technically not happen due to yargs 'choices', but good practice
    console.error(`❌ Error: Scraper with ID "${scraperId}" not found.`);
    process.exit(1);
  }

  const dateFormat = "yyyy-MM-dd";
  const startDate = parseDate(argv.startDate, dateFormat, new Date());
  const endDate = argv.endDate
    ? parseDate(argv.endDate, dateFormat, new Date())
    : startDate; // Default end date to start date

  console.log(`▶️ Running scraper: ${scraper.name} (${scraper.id})`);
  console.log(
    `🗓️ Date range: ${formatDate(startDate)} to ${formatDate(endDate)}`
  );

  // --- Execution Logic ---
  let browser: Browser | null = null;
  try {
    // 1. Get Browser Instance
    console.log("🌍 Initializing browser...");
    browser = await getBrowserInstance();
    console.log("✅ Browser initialized.");

    // 2. Prepare Scrape Options
    const scrapeOptions: ScrapeOptions = {
      startDate,
      endDate,
      browser,
    };

    // 3. Run the Scraper
    console.log("🚀 Scraping events...");
    const events = await scraper.scrape(scrapeOptions);

    if (events.length === 0) {
      console.log("⏹️ No events found for the specified date range.");
    } else {
      console.log(`✅ Found ${events.length} events.`);

      // 4. Post to Notion or Log for Dry Run
      if (argv.dryRun) {
        console.log("\n🌵 Dry Run Mode: Events found but not posted:");
        console.log(JSON.stringify(events, null, 2)); // Pretty print the events
      } else {
        console.log("📤 Posting events to Notion...");
        await postEventsToNotion(events); // Assuming postEventsToNotion handles its own logging
      }
    }

    console.log("✨ Process completed successfully!");
  } catch (error) {
    console.error("❌ An error occurred during the scrape-and-post process:");
    console.error(error);
    process.exitCode = 1; // Indicate failure
  } finally {
    // 5. Close Browser Instance (always attempt this)
    if (browser) {
      console.log("🚪 Closing browser...");
      await closeBrowserInstance();
      console.log("✅ Browser closed.");
    }
  }
}

// --- Run Main Function ---
main().catch((error) => {
  // Catch any top-level unhandled promise rejections
  console.error("❌ Unhandled error in main execution:", error);
  process.exit(1);
});

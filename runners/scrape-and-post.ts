import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  isValid as isValidDate,
  format,
  addDays,
} from "date-fns";
import { toDate, formatInTimeZone } from "date-fns-tz";
import dotenv from "dotenv";
import inquirer from "inquirer";
import type { ScrapeOptions, Scraper, ScraperRunResult } from "../types.js";
import type { Browser } from "puppeteer";

import { findScraperById, scrapers } from "../scrapers/index.js";
import { postEventsToNotion } from "../api/notion-poster.js";
import { getBrowserInstance, closeBrowserInstance } from "../utils/browser.js";

// Load environment variables from .env file
dotenv.config();

// Define the target timezone consistently
const TIME_ZONE = "America/New_York";

/**
 * Prints a formatted digest table showing the results of all scraper runs
 */
function printDigest(results: ScraperRunResult[], isDryRun: boolean): void {
  console.log("\n" + "=".repeat(60));
  console.log("                    SCRAPER RUN DIGEST".padStart(50));
  console.log("=".repeat(60));

  // Header
  const header = "Scraper".padEnd(26) + 
    "Found".padStart(6) + 
    "Created".padStart(8) + 
    "Skipped".padStart(8) + 
    "Failed".padStart(7) + 
    "Status".padStart(11);
  console.log(header);
  console.log("-".repeat(60));

  // Rows
  for (const result of results) {
    const name = result.scraperName.length > 25 
      ? result.scraperName.substring(0, 22) + "..." 
      : result.scraperName;
    
    const found = result.status === "error" ? "-" : result.eventsFound.toString();
    const created = isDryRun || result.status === "error" 
      ? "--" 
      : result.eventsCreated.toString();
    const skipped = isDryRun || result.status === "error" 
      ? "--" 
      : result.eventsSkipped.toString();
    const failed = isDryRun || result.status === "error" 
      ? "--" 
      : result.eventsFailed.toString();
    
    const statusText = result.status === "error" 
      ? `ERROR (${(result.durationMs / 1000).toFixed(1)}s)`
      : `OK (${(result.durationMs / 1000).toFixed(1)}s)`;
    
    const row = name.padEnd(26) + 
      found.padStart(6) + 
      created.padStart(8) + 
      skipped.padStart(8) + 
      failed.padStart(7) + 
      statusText.padStart(11);
    console.log(row);

    // Print error message if there was an error
    if (result.status === "error" && result.error) {
      const errorMsg = result.error.message || String(result.error);
      const errorName = result.error.name || "Error";
      console.log(`  -> ${errorName}: ${errorMsg}`);
    }
  }

  // Totals
  console.log("-".repeat(60));
  const totalFound = results
    .filter((r) => r.status === "success")
    .reduce((sum, r) => sum + r.eventsFound, 0);
  const totalCreated = isDryRun 
    ? "--" 
    : results
        .filter((r) => r.status === "success")
        .reduce((sum, r) => sum + r.eventsCreated, 0)
        .toString();
  const totalSkipped = isDryRun 
    ? "--" 
    : results
        .filter((r) => r.status === "success")
        .reduce((sum, r) => sum + r.eventsSkipped, 0)
        .toString();
  const totalFailed = isDryRun 
    ? "--" 
    : results
        .filter((r) => r.status === "success")
        .reduce((sum, r) => sum + r.eventsFailed, 0)
        .toString();
  
  const totalRow = "TOTAL".padEnd(26) + 
    totalFound.toString().padStart(6) + 
    totalCreated.padStart(8) + 
    totalSkipped.padStart(8) + 
    totalFailed.padStart(7);
  console.log(totalRow);
  console.log("=".repeat(60) + "\n");
}

// --- Main Function ---
async function main() {
  // --- Argument Parsing ---
  const argv = await yargs(hideBin(process.argv))
    .scriptName("scrape-and-post")
    .usage(
      "$0 [--scraper <id>] --start-date <yyyy-mm-dd> [--end-date <yyyy-mm-dd>]"
    )
    .option("scraper", {
      alias: "s",
      description:
        "The ID of the scraper to run (optional, prompts if omitted)",
      type: "string",
      choices: scrapers.map((s) => s.id), // Still provide available choices for validation/help
    })
    .option("start-date", {
      alias: "d",
      description: "Start date for scraping (YYYY-MM-DD, defaults to today)",
      type: "string",
    })
    .option("end-date", {
      alias: "e",
      description:
        "End date for scraping (YYYY-MM-DD, defaults to 30 days after start date)",
      type: "string",
    })
    .option("dry-run", {
      alias: "n",
      description:
        "Perform scraping but do not post to Notion, just log results",
      type: "boolean",
      default: false,
    })
    .option("all", {
      alias: "a",
      description: "Run all scrapers in sequence",
      type: "boolean",
      default: false,
    })
    .option("verbose", {
      alias: "v",
      description: "Show verbose progress logs during scraping",
      type: "boolean",
      default: false,
    })
    .check((argv) => {
      // Validate date formats using the target timezone

      // --- Date Validation (only if dates are provided) ---
      let parsedStartDateForCheck: Date | null = null;
      if (typeof argv.startDate === "string") {
        const startStr = argv.startDate;
        parsedStartDateForCheck = toDate(`${startStr}T00:00:00`, {
          timeZone: TIME_ZONE,
        });
        if (!isValidDate(parsedStartDateForCheck)) {
          throw new Error(
            `Invalid start-date format: ${startStr}. Please use YYYY-MM-DD.`
          );
        }
      }

      // Validate end-date only if provided
      if (typeof argv.endDate === "string") {
        const endStr = argv.endDate;
        const parsedEndDate = toDate(`${endStr}T23:59:59.999`, {
          timeZone: TIME_ZONE,
        });
        if (!isValidDate(parsedEndDate)) {
          throw new Error(
            `Invalid end-date format: ${endStr}. Please use YYYY-MM-DD.`
          );
        }

        // Check if end date is before start date *only if both were provided*
        if (
          parsedStartDateForCheck &&
          parsedEndDate < parsedStartDateForCheck
        ) {
          throw new Error(
            `End date (${endStr}) cannot be before start date (${argv.startDate}).`
          );
        }

        // Check if end-date was provided without start-date
        if (!argv.startDate) {
          throw new Error("Cannot specify --end-date without --start-date.");
        }
      }
      // --- End Date Validation ---

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
  let selectedScrapers: Scraper[];
  if (argv.all) {
    console.log("🚀 Running all scrapers...");
    selectedScrapers = scrapers;
  } else {
    let scraperId = argv.scraper as string | undefined;
    // If scraper ID was not provided via args, prompt the user
    if (!scraperId) {
      const scraperChoices = scrapers.map((s) => ({
        name: `${s.name} (${s.id})`,
        value: s.id,
      }));
      const answers = await inquirer.prompt([
        {
          type: "list",
          name: "selectedScraper",
          message: "Which scraper would you like to run?",
          choices: scraperChoices,
        },
      ]);
      scraperId = answers.selectedScraper;
      if (!scraperId) {
        console.error("❌ Error: No scraper selected.");
        process.exit(1);
      }
    }
    const scraper = findScraperById(scraperId);
    if (!scraper) {
      console.error(`❌ Error: Scraper with ID "${scraperId}" not found.`);
      process.exit(1);
    }
    selectedScrapers = [scraper];
  }

  // --- Determine Date Range --- START
  const dateFormat = "yyyy-MM-dd";
  let startDate: Date;
  let endDate: Date;
  let startDateString: string;
  let endDateString: string;

  const nowInNY = new Date(); // Current instant
  // Get the start of today in NY timezone
  const todayStartNY = toDate(
    `${formatInTimeZone(nowInNY, TIME_ZONE, "yyyy-MM-dd")}T00:00:00`,
    { timeZone: TIME_ZONE }
  );

  if (argv.startDate) {
    startDateString = argv.startDate as string;
    startDate = toDate(`${startDateString}T00:00:00`, { timeZone: TIME_ZONE });
    console.log(`Using provided start date: ${startDateString}`);
  } else {
    startDate = todayStartNY;
    startDateString = format(startDate, dateFormat);
    console.log(
      `Start date not provided, defaulting to today: ${startDateString}`
    );
  }

  if (argv.endDate) {
    endDateString = argv.endDate as string;
    // Ensure end date represents the *end* of the specified day
    endDate = toDate(`${endDateString}T23:59:59.999`, { timeZone: TIME_ZONE });
    console.log(`Using provided end date: ${endDateString}`);
  } else {
    // Default end date is 30 days after the *start* date
    endDate = addDays(startDate, 30);
    // Ensure this also represents the *end* of that 30th day
    const endDateStrTemp = format(endDate, dateFormat);
    endDate = toDate(`${endDateStrTemp}T23:59:59.999`, { timeZone: TIME_ZONE });
    endDateString = format(endDate, dateFormat); // Format the final end date
    console.log(
      `End date not provided, defaulting to 30 days after start date: ${endDateString}`
    );
  }

  // Final validation check (should have been caught by yargs check if both provided)
  if (endDate < startDate) {
    console.error(
      `Error: Calculated end date (${endDateString}) is before start date (${startDateString}).`
    );
    process.exit(1);
  }

  // --- Determine Date Range --- END

  console.log(
    `🗓️ Date range (New York Time): ${startDateString} to ${endDateString}`
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
      startDate, // Use the final determined startDate Date object
      endDate, // Use the final determined endDate Date object
      browser,
      verbose: argv.verbose as boolean,
    };

    // 3. Run the Scrapers with per-scraper error isolation
    const results: ScraperRunResult[] = [];
    for (const s of selectedScrapers) {
      const startTime = Date.now();
      const result: ScraperRunResult = {
        scraperId: s.id,
        scraperName: s.name,
        status: "success",
        eventsFound: 0,
        eventsCreated: 0,
        eventsSkipped: 0,
        eventsFailed: 0,
        durationMs: 0,
      };

      try {
        console.log(`▶️ Running scraper: ${s.name} (${s.id})`);
        const events = await s.scrape(scrapeOptions);
        result.eventsFound = events.length;
        console.log(`✅ ${s.name} returned ${events.length} events.`);

        if (events.length > 0) {
          if (argv.dryRun) {
            console.log(
              `🌵 Dry Run Mode: ${events.length} events found but not posted for ${s.name}`
            );
          } else {
            console.log(`📤 Posting ${events.length} events to Notion for ${s.name}...`);
            const postResult = await postEventsToNotion(events);
            result.eventsCreated = postResult.created;
            result.eventsSkipped = postResult.skipped;
            result.eventsFailed = postResult.failed;
          }
        }
      } catch (error) {
        result.status = "error";
        result.error = error as Error;
        console.error(`❌ Error running scraper ${s.name} (${s.id}):`, error);
      } finally {
        result.durationMs = Date.now() - startTime;
        results.push(result);
      }
    }

    // 4. Print digest
    printDigest(results, argv.dryRun);

    // Determine overall success
    const hasErrors = results.some((r) => r.status === "error");
    if (hasErrors) {
      process.exitCode = 1;
    } else {
      console.log("✨ Process completed successfully!");
    }
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

# Creating a New Scraper

This document outlines the steps required to add a new event scraper to the `community-calendar-scrapers` project.

## 1. Understand the Core Interfaces

Before creating a scraper, familiarize yourself with the core data structures defined in `types.ts`:

-   **`Event`**: Represents a single scraped event. It includes fields like `title`, `description`, `start_at`, `end_at` (optional), `url`, `location`, and `external_id`. The `external_id` should be a unique identifier derived from the source event (e.g., `source_id@venue_id`) to help with deduplication. Dates should be in ISO 8601 format (`YYYY-MM-DDTHH:mm:ssZ` or similar).
-   **`Scraper`**: The interface that every scraper must implement. It requires:
    -   `id`: A unique, kebab-case string identifying the scraper (e.g., `my-cool-venue`). This ID is used in the command-line interface.
    -   `name`: A human-readable name for the scraper (e.g., "My Cool Venue Events").
    -   `scrape`: An asynchronous function (`async (options: ScrapeOptions): Promise<Event[]>`) that performs the actual scraping logic.
-   **`ScrapeOptions`**: An object passed to the `scrape` function, containing:
    -   `startDate`: A `Date` object indicating the earliest start date for events to scrape.
    -   `endDate`: An optional `Date` object indicating the latest start date for events to scrape. If omitted, it defaults to the `startDate`.
    -   `browser`: An optional Puppeteer `Browser` instance. If your scraper needs browser automation (recommended for complex sites or SPAs), you should use this shared instance provided by the runner instead of launching your own.

## 2. Create the Scraper File

1.  Create a new TypeScript file in the `scrapers/` directory. Name it descriptively using kebab-case (e.g., `my-cool-venue.ts`).
2.  Inside this file, import the necessary types (`Scraper`, `Event`, `ScrapeOptions` from `../types.js`) and potentially Puppeteer (`import type { Browser, Page } from "puppeteer";`).
3.  Implement the `scrape` function. This is where the core logic resides:
    -   Navigate to the target website(s). Use the provided `browser` instance if needed (`options.browser`).
    -   Locate the event data on the page(s).
    -   Extract the relevant information for each event within the specified `startDate` and `endDate` range.
    -   Format the extracted data into `Event` objects. Pay close attention to date/time parsing and formatting (use ISO 8601). Generate a robust `external_id`.
    -   Handle potential errors gracefully (e.g., network issues, changes in website structure).
    -   Return an array of `Event` objects (`Promise<Event[]>`).
4.  Define and export the `scraper` object, implementing the `Scraper` interface:

```typescript
import type { Scraper, Event, ScrapeOptions } from "../types.js";
// Add other necessary imports (puppeteer, date-fns, etc.)

async function scrapeMyCoolVenue(options: ScrapeOptions): Promise<Event[]> {
  const { startDate, endDate, browser } = options;
  const events: Event[] = [];

  console.log(`Scraping My Cool Venue from ${startDate.toISOString()} to ${endDate?.toISOString() ?? startDate.toISOString()}`);

  // --- Your scraping logic goes here ---
  // Example using browser:
  // if (!browser) {
  //   throw new Error("Browser instance is required for this scraper.");
  // }
  // const page = await browser.newPage();
  // await page.goto("https://example.com/events");
  // ... find elements, extract data ...
  // Remember to filter by startDate and endDate
  // Construct Event objects and push them to the events array
  // await page.close();
  // --- End of scraping logic ---


  console.log(`Found ${events.length} events for My Cool Venue.`);
  return events;
}

export const scraper: Scraper = {
  id: "my-cool-venue", // Use a unique kebab-case ID
  name: "My Cool Venue", // Human-readable name
  scrape: scrapeMyCoolVenue,
};
```

## 3. Register the Scraper

1.  Open `scrapers/index.ts`.
2.  Import your newly created scraper object at the top:

    ```typescript
    import { scraper as myCoolVenueScraper } from "./my-cool-venue.js";
    ```

3.  Add the imported scraper object to the `scrapers` array:

    ```typescript
    export const scrapers: Scraper[] = [
      // ... existing scrapers
      myCoolVenueScraper,
    ];
    ```

## 4. Test the Scraper

1.  Run the main runner script from the project root, specifying your scraper's ID and a date range. Use the `--dry-run` flag initially to check the output without posting to Notion:

    ```bash
    npm run scrape -- --scraper my-cool-venue --start-date YYYY-MM-DD [--end-date YYYY-MM-DD] --dry-run
    ```

    *(Or `yarn scrape ...` or `pnpm scrape ...` depending on your package manager)*

2.  Examine the console output. Ensure the correct events are found and the data is formatted as expected (especially dates and the `external_id`).
3.  Debug and refine your `scrape` function as needed.
4.  Once satisfied, you can run without `--dry-run` (ensure your Notion API keys are set in `.env`) to test the full workflow.

## Best Practices

-   **Error Handling**: Anticipate website changes and network errors. Use `try...catch` blocks appropriately.
-   **Logging**: Add `console.log` statements within your `scrape` function to aid debugging, especially during development. Indicate which scraper is running.
-   **Date Handling**: Be robust with date parsing. Check existing scrapers (e.g., in the `scrapers/` directory) for established patterns for handling dates, times, and timezones. Ensure output dates are ISO 8601. Use utility functions from `utils/date.js` if applicable.
-   **Efficiency**: Avoid unnecessary requests or computations. If using Puppeteer, close pages (`page.close()`) when done. Check existing scrapers for established patterns for DOM manipulation (e.g., using `page.evaluate` vs. adding external parsing libraries like Cheerio).
-   **Dependencies**: Avoid adding new external dependencies (npm packages) unless strictly necessary and significantly simplifying the code. Prioritize using built-in browser functionality (via Puppeteer) and existing utility functions.
-   **Respect `robots.txt`**: Check the target website's `robots.txt` file for scraping guidelines.
-   **Rate Limiting**: Be mindful of the target server's resources. Avoid overly frequent requests. Implement delays if necessary.
-   **Use the Shared Browser**: Leverage the `options.browser` instance for performance and resource management.
-   **Unique `external_id`**: Create a stable and unique `external_id` based on source data to prevent duplicate Notion entries. A good pattern is `<event_id_from_source>@<scraper_id>`. 
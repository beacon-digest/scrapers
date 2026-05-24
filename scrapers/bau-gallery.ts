import type { Browser, Page } from "puppeteer";
import {
  parse as parseDate,
  isWithinInterval,
  formatISO,
  isValid as isValidDate,
  startOfDay,
  endOfDay,
  format as formatDateFn,
} from "date-fns";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { logEventFound } from "../utils/logging.js";
import { formatDate } from "../utils/date.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";

const SCRAPER_ID = "bau-gallery";
const BASE_URL = "https://www.baugallery.org";
const EVENTS_URL = `${BASE_URL}/eventscurrent`;
const DEFAULT_LOCATION = "BAU Gallery";
const TIME_ZONE = "America/New_York";

function convert12to24(hour: string, min: string, period: string): string {
  let h = Number.parseInt(hour, 10);
  const isPM = period?.toUpperCase() === "PM";
  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0; // Midnight case
  return `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
}

function parseTime(timeStr: string | null | undefined): {
  start?: string;
  end?: string;
} {
  if (!timeStr) return {};
  const times = timeStr.split(/–|-|to/i).map((t) => t.trim());
  const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;

  const startTimeMatch = times[0]?.match(timeRegex);
  if (!startTimeMatch) return {};

  const start = convert12to24(
    startTimeMatch[1],
    startTimeMatch[2],
    startTimeMatch[3]
  );
  let end: string | undefined = undefined;

  if (times.length > 1) {
    const endTimeMatch = times[1]?.match(timeRegex);
    if (endTimeMatch) {
      end = convert12to24(
        endTimeMatch[1],
        endTimeMatch[2],
        endTimeMatch[3]
      );
    }
  }
  return { start, end };
}

function parseBauDate(dateStr: string, year: number): Date[] {
  const dates: Date[] = [];
  
  // Clean up the date string - remove extra whitespace and normalize
  const cleanDateStr = dateStr.replace(/\s+/g, ' ').trim();
  
  // Handle ranges like "May 9 to Jun 8" or single dates like "Jun 8"
  if (cleanDateStr.includes(" to ")) {
    const [startStr, endStr] = cleanDateStr.split(" to ").map(s => s.trim());
    
    // Parse start date
    try {
      const startDate = parseDate(`${startStr} ${year}`, "MMM d yyyy", new Date());
      if (isValidDate(startDate)) {
        dates.push(startDate);
      }
    } catch (e) {
      console.warn(`[${SCRAPER_ID}] Failed to parse start date: ${startStr}`);
    }
    
    // Parse end date
    try {
      const endDate = parseDate(`${endStr} ${year}`, "MMM d yyyy", new Date());
      if (isValidDate(endDate)) {
        dates.push(endDate);
      }
    } catch (e) {
      console.warn(`[${SCRAPER_ID}] Failed to parse end date: ${endStr}`);
    }
  } else {
    // Single date
    try {
      const singleDate = parseDate(`${cleanDateStr} ${year}`, "MMM d yyyy", new Date());
      if (isValidDate(singleDate)) {
        dates.push(singleDate);
      }
    } catch (e) {
      console.warn(`[${SCRAPER_ID}] Failed to parse single date: ${cleanDateStr}`);
    }
  }
  
  return dates;
}

const scrapeBauGalleryEvents = async (
  options: ScrapeOptions
): Promise<Event[]> => {
  const { startDate, endDate: inputEndDate, browser } = options;
  const endDate = inputEndDate || startDate;

  if (!browser) {
    throw new Error("A Puppeteer browser instance must be provided.");
  }

  const allFoundEvents: Event[] = [];
  let page: Page | undefined;

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatDate(
      startDate
    )} to ${formatDate(endDate)}...`
  );

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );
    
    if (options.verbose) {
      console.log(`[${SCRAPER_ID}] Navigating to ${EVENTS_URL}...`);
    }
    await page.goto(EVENTS_URL, { waitUntil: "networkidle0", timeout: 60000 });

    // Extract all event blocks from the page
    const eventBlocks = await page.$$eval('article', (articles) => {
      return articles.map(article => {
        const titleElement = article.querySelector('h1');
        const title = titleElement?.textContent?.trim() || '';
        
        // Look for date information - target specific patterns in the article text
        const fullText = article.textContent || '';
        let dateText = '';
        let timeText = '';
        
        // Extract date from patterns like "May 9", "Jun 8", "Jul 11 to Aug 3"
        const dateMatch = fullText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+(?:\s+to\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+)?/);
        if (dateMatch) {
          dateText = dateMatch[0].trim();
        }
        
        // Look for time information with more specific patterns
        const timeMatch = fullText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))(?:\s*(?:to|–|-)\s*(\d{1,2}:\d{2}\s*(?:AM|PM)))?/i);
        if (timeMatch) {
          timeText = timeMatch[0].trim();
        }
        
        // Get description from the main content - look for meaningful paragraphs
        const contentElements = article.querySelectorAll('p, div');
        let description = '';
        for (const el of Array.from(contentElements)) {
          const text = el.textContent?.trim() || '';
          // Skip short text, view event links, dates, and navigation elements
          if (text && 
              text.length > 80 && 
              !text.includes('View Event') &&
              !text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/) &&
              !text.match(/^\d{1,2}:\d{2}\s*(AM|PM)/i) &&
              !text.includes('Google Calendar') &&
              !text.includes('ICS') &&
              !text.includes('(map)')) {
            description = text;
            break;
          }
        }
        
        // Clean up description
        if (description) {
          description = description
            .replace(/\s+/g, ' ')  // Replace multiple whitespace with single space
            .replace(/\n+/g, ' ')  // Replace newlines with spaces
            .trim();
        }
        
        // Find the "View Event →" link
        const viewEventLink = article.querySelector('a[href*="events"]');
        let eventUrl = '';
        if (viewEventLink) {
          const href = viewEventLink.getAttribute('href');
          if (href) {
            eventUrl = href.startsWith('http') ? href : `https://www.baugallery.org${href}`;
          }
        }
        
        return {
          title,
          dateText,
          timeText,
          description,
          eventUrl,
          fullText: article.textContent?.trim() || ''
        };
      });
    });

    console.log(`[${SCRAPER_ID}] Found ${eventBlocks.length} potential event blocks`);

    const currentYear = new Date().getFullYear();
    
    for (const block of eventBlocks) {
      try {
        if (!block.title || !block.dateText) {
          console.log(`[${SCRAPER_ID}] Skipping block with missing title or date`);
          continue;
        }

        // Parse dates
        const eventDates = parseBauDate(block.dateText, currentYear);
        if (eventDates.length === 0) {
          console.warn(`[${SCRAPER_ID}] Could not parse date "${block.dateText}" for event: ${block.title}`);
          continue;
        }

        console.log(`[${SCRAPER_ID}] Parsed date "${block.dateText}" -> ${eventDates.map(d => formatDateFn(d, "yyyy-MM-dd")).join(", ")} for event: ${block.title}`);

        // Use the first date as the start date
        const eventStartDate = eventDates[0];
        const eventEndDate = eventDates.length > 1 ? eventDates[1] : eventStartDate;

        // Parse time if available
        const { start: startTime, end: endTime } = parseTime(block.timeText);
        
        // Default times if not specified (typical gallery hours)
        const defaultStartTime = "12:00:00";
        const defaultEndTime = "18:00:00";
        
        const finalStartTime = startTime || defaultStartTime;
        const finalEndTime = endTime || defaultEndTime;

        // Create ISO date strings
        const startAt = formatISO(
          parseDate(
            `${formatDateFn(eventStartDate, "yyyy-MM-dd")}T${finalStartTime}`,
            "yyyy-MM-dd'T'HH:mm:ss",
            new Date()
          )
        );

        const endAt = formatISO(
          parseDate(
            `${formatDateFn(eventEndDate, "yyyy-MM-dd")}T${finalEndTime}`,
            "yyyy-MM-dd'T'HH:mm:ss",
            new Date()
          )
        );

        // Create external ID from title
        const titleSlug = block.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');

        const eventData: Event = {
          title: block.title,
          description: convertHtmlToMarkdown(block.description || ""),
          start_at: startAt,
          end_at: endAt,
          url: block.eventUrl || EVENTS_URL,
          location: DEFAULT_LOCATION,
          external_id: `${SCRAPER_ID}-${formatDateFn(eventStartDate, "yyyy-MM-dd")}-${titleSlug}`,
        };

        allFoundEvents.push(eventData);
        logEventFound(SCRAPER_ID, eventData);

      } catch (eventError) {
        console.error(`[${SCRAPER_ID}] Error processing event block:`, eventError);
      }
    }

    console.log(
      `[${SCRAPER_ID}] Successfully scraped ${allFoundEvents.length} events.`
    );

    // Filter events by date range
    const dateInterval = {
      start: startOfDay(startDate),
      end: endOfDay(endDate),
    };

    const filteredEvents = allFoundEvents.filter((event) => {
      try {
        const eventStartDate = new Date(event.start_at);
        return (
          isValidDate(eventStartDate) &&
          isWithinInterval(eventStartDate, dateInterval)
        );
      } catch (filterError) {
        console.error(
          `[${SCRAPER_ID}] Error parsing date for filtering event "${event.title}":`,
          filterError
        );
        return false;
      }
    });

    console.log(
      `[${SCRAPER_ID}] Found ${
        filteredEvents.length
      } events within the date range ${formatDate(startDate)} to ${formatDate(
        endDate
      )}.`
    );

    // Validate final filtered list
    try {
      const validationResult = EventsArraySchema.parse(filteredEvents);
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.length} events.`
      );
      return validationResult as Event[];
    } catch (validationError) {
      console.error(
        `[${SCRAPER_ID}] Zod validation failed for final event list:`,
        validationError
      );
      throw new Error(`[${SCRAPER_ID}] Event validation failed.`);
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] An unexpected error occurred:`, error);
    return [];
  } finally {
    if (page?.isClosed() === false) {
      await page.close();
    }
  }
};

export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: DEFAULT_LOCATION,
  scrape: scrapeBauGalleryEvents,
};
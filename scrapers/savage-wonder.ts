import type { Browser, Page } from "puppeteer";
import {
  format,
  parse as parseDate,
  isValid as isValidDate,
  isWithinInterval,
  startOfDay,
  endOfDay,
  formatISO,
} from "date-fns";
import { toDate } from "date-fns-tz";
import { decode } from "html-entities";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { convertHtmlToMarkdown } from "../utils/markdown.js";
import { EventsArraySchema } from "../utils/validation.js";
import { formatDate } from "../utils/date.js";

const SCRAPER_ID = "savage-wonder";
const LOCATION_NAME = "Savage Wonder";
const BASE_URL = "https://savagewonder.org";
const CALENDAR_URL = `${BASE_URL}/calendar/`;
const TIME_ZONE = "America/New_York";

interface RawEventData {
  title: string;
  dateTimeString: string;
  description: string;
  url: string;
  external_id: string;
}

/**
 * Helper function to parse Savage Wonder date/time strings
 * Example formats: "May 30 @ 8:00 pm - 9:30 pm", "June 7 @ 7:00 pm - 9:00 pm"
 */
function parseSavageWonderDateTime(dateTimeString: string): {
  date?: string;
  startTime?: string;
  endTime?: string;
} {
  if (!dateTimeString) return {};

  // Clean up the string - remove extra whitespace and normalize
  const cleanedString = dateTimeString.replace(/\s+/g, ' ').trim();

  // Pattern for "Month Day @ Time - Time"
  const mainPattern = /([A-Za-z]+)\s+(\d{1,2})\s+@\s+(\d{1,2}):(\d{2})\s+([ap]m)(?:\s*-\s*(\d{1,2}):(\d{2})\s+([ap]m))?/i;
  
  let match = cleanedString.match(mainPattern);
  
  // Try alternative patterns if main pattern fails
  if (!match) {
    // Try pattern with different separators or spacing
    const altPattern = /([A-Za-z]+)\s+(\d{1,2}).*?(\d{1,2}):(\d{2})\s*([ap]m)(?:.*?(\d{1,2}):(\d{2})\s*([ap]m))?/i;
    match = cleanedString.match(altPattern);
  }

  if (!match) {
    console.warn(`[${SCRAPER_ID}] Could not parse date/time: "${dateTimeString}"`);
    return {};
  }

  const [, month, day, startHour, startMin, startPeriod, endHour, endMin, endPeriod] = match;

  // Construct date (assume current year, but handle year transitions)
  const now = new Date();
  let year = now.getFullYear();
  const monthNumber = getMonthNumber(month);
  const eventMonth = parseInt(monthNumber, 10);
  const currentMonth = now.getMonth() + 1;
  
  // If event month is significantly before current month, assume next year
  if (eventMonth < currentMonth - 6) {
    year += 1;
  }

  const date = `${year}-${monthNumber}-${day.padStart(2, "0")}`;

  let startTime: string | undefined;
  let endTime: string | undefined;

  if (startHour && startMin && startPeriod) {
    startTime = convert12to24(startHour, startMin, startPeriod);
  }

  if (endHour && endMin && endPeriod) {
    endTime = convert12to24(endHour, endMin, endPeriod);
  }

  return { date, startTime, endTime };
}

/**
 * Helper to convert month name to number
 */
function getMonthNumber(monthName: string): string {
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04",
    jun: "06", jul: "07", aug: "08", sep: "09",
    oct: "10", nov: "11", dec: "12"
  };
  
  const lowerMonth = monthName?.toLowerCase();
  return lowerMonth ? months[lowerMonth] || "01" : "01";
}

/**
 * Helper to convert 12-hour time to 24-hour format
 */
function convert12to24(hour: string, min: string, period: string): string {
  let h = Number.parseInt(hour, 10);
  if (Number.isNaN(h)) {
    console.warn(`[${SCRAPER_ID}] Invalid hour value: ${hour}`);
    h = 12;
  }

  const isPM = period?.toLowerCase() === "pm";
  
  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0; // Midnight case

  return `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
}

/**
 * Helper to combine date and time into ISO string
 */
function combineToISOString(date?: string, time?: string): string | undefined {
  if (!date || !time) return undefined;

  try {
    const dateTimeString = `${date}T${time}`;
    const dateObj = toDate(dateTimeString, { timeZone: TIME_ZONE });
    if (!isValidDate(dateObj)) {
      console.warn(`[${SCRAPER_ID}] Invalid date constructed from ${dateTimeString}`);
      return undefined;
    }
    return formatISO(dateObj);
  } catch (e) {
    console.error(`[${SCRAPER_ID}] Error creating ISO date:`, e);
    return undefined;
  }
}

/**
 * Scrapes events from the Savage Wonder calendar
 */
async function scrapeSavageWonderEvents(options: ScrapeOptions): Promise<Event[]> {
  const { startDate, endDate = startDate, browser } = options;

  if (!browser) {
    throw new Error("A Puppeteer browser instance must be provided.");
  }

  const events: Event[] = [];
  let page: Page | undefined;

  console.log(
    `[${SCRAPER_ID}] Scraping events from ${formatDate(startDate)} to ${formatDate(endDate)}...`
  );

  try {
    page = await browser.newPage();
    // Set realistic browser settings to avoid detection
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    
    // Set additional headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });

    // Set viewport to common desktop size
    await page.setViewport({ width: 1366, height: 768 });

    console.log(`[${SCRAPER_ID}] Navigating to ${CALENDAR_URL}`);
    await page.goto(CALENDAR_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

    // Check for Cloudflare challenge and wait for it to complete
    console.log(`[${SCRAPER_ID}] Checking for Cloudflare challenge...`);
    const hasCloudflare = await page.evaluate(() => {
      return document.body.innerHTML.includes("Just a moment") || 
             document.body.innerHTML.includes("Verify you are human") ||
             document.body.innerHTML.includes("cf-turnstile") ||
             document.body.innerHTML.includes("Cloudflare");
    });

    if (hasCloudflare) {
      console.log(`[${SCRAPER_ID}] Cloudflare challenge detected, waiting for completion...`);
      
      // Wait for the challenge to complete (look for calendar content to appear)
      try {
        await page.waitForFunction(() => {
          const body = document.body.innerHTML;
          return !body.includes("Just a moment") && 
                 !body.includes("Verify you are human") &&
                 (body.includes("Calendar") || body.includes("event") || body.includes("calendar"));
        }, { timeout: 30000 });
        
        console.log(`[${SCRAPER_ID}] Cloudflare challenge completed, proceeding...`);
        
        // Wait a bit more for the page to fully load
        await page.waitForLoadState?.('networkidle') || 
              new Promise(resolve => setTimeout(resolve, 3000));
        
      } catch (e) {
        console.warn(`[${SCRAPER_ID}] Cloudflare challenge may not have completed, attempting to continue...`);
      }
    } else {
      console.log(`[${SCRAPER_ID}] No Cloudflare challenge detected`);
      // Wait for network to be idle
      await page.waitForLoadState?.('networkidle') || 
            new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Wait for page content to load - try multiple possible selectors
    const possibleSelectors = [
      ".tribe-events-calendar",
      ".calendar",
      "#calendar",
      "[class*='calendar']",
      "[class*='event']",
      "main"
    ];
    
    let foundSelector = null;
    for (const selector of possibleSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        foundSelector = selector;
        console.log(`[${SCRAPER_ID}] Found content with selector: ${selector}`);
        break;
      } catch (e) {
        // Continue to next selector
      }
    }
    
    if (!foundSelector) {
      console.log(`[${SCRAPER_ID}] No standard selectors found, will try to parse entire page`);
    }

    // Check if we're still on the Cloudflare page
    const stillCloudflare = await page.evaluate(() => {
      const body = document.body.innerHTML;
      return body.includes("Just a moment") || body.includes("Verify you are human");
    });

    if (stillCloudflare) {
      console.error(`[${SCRAPER_ID}] Still on Cloudflare challenge page, cannot proceed`);
      return [];
    }

    // Debug: log page HTML to see structure
    const pageHTML = await page.evaluate(() => {
      return document.body.innerHTML.substring(0, 5000); // First 5000 chars
    });
    console.log(`[${SCRAPER_ID}] Page HTML preview:`, pageHTML.substring(0, 500) + "...");
    
    // Debug: log all elements that might contain events
    const debugInfo = await page.evaluate(() => {
      try {
        const allElements = document.querySelectorAll("*");
        const eventRelated = [];
        for (const el of allElements) {
          try {
            const text = el.textContent || "";
            const className = el.className ? String(el.className) : "";
            if ((text.includes("@") && (text.includes("pm") || text.includes("am"))) || 
                className.includes("event") ||
                className.includes("calendar") ||
                text.includes("Purchase Tickets")) {
              eventRelated.push({
                tag: el.tagName,
                class: className,
                text: text.substring(0, 100)
              });
            }
          } catch (innerErr) {
            // Skip problematic elements
          }
        }
        return eventRelated.slice(0, 20); // First 20 matches
      } catch (err) {
        return [{ error: err.message }];
      }
    });
    console.log(`[${SCRAPER_ID}] Event-related elements found:`, debugInfo);

    // Extract events from the calendar by parsing both text patterns and HTML links
    const rawEvents = await page.evaluate((scraperId, locationName) => {
      try {
        const eventsList: RawEventData[] = [];
        
        // Get all event links from the page
        const eventLinks = Array.from(document.querySelectorAll('a[href*="/event/"]'));
        console.log(`[${scraperId}] Found ${eventLinks.length} event links`);
        
        // Create a map of event titles to URLs
        const titleToUrl = new Map();
        eventLinks.forEach(link => {
          const href = link.getAttribute('href');
          const linkText = link.textContent?.trim();
          if (href && linkText && linkText.length > 3) {
            const fullUrl = href.startsWith('http') ? href : new URL(href, window.location.origin).toString();
            titleToUrl.set(linkText, fullUrl);
          }
        });

        // Get the full page text and parse event patterns directly
        const pageText = document.body.textContent || "";

        // Extract all event patterns from the text
        // Look for patterns like "May 30 @ 8:00 pm - 9:30 pm" followed by event titles
        const eventMatches = Array.from(pageText.matchAll(/([A-Za-z]+\s+\d{1,2})\s+@\s+(\d{1,2}:\d{2}\s+[ap]m(?:\s*-\s*\d{1,2}:\d{2}\s+[ap]m)?)/gi));

        console.log(`[${scraperId}] Found ${eventMatches.length} date/time patterns in page text`);

        eventMatches.forEach((match, index) => {
          try {
            const fullMatch = match[0]; // Full pattern like "June 5 @ 7:00 pm - 9:00 pm"
            const datePart = match[1]; // "June 5"
            const timePart = match[2]; // "7:00 pm - 9:00 pm"
            const dateTimeString = `${datePart} @ ${timePart}`;
    
            // Find the event title by looking for text near this pattern
            const matchIndex = match.index || 0;
            const beforeMatch = pageText.substring(Math.max(0, matchIndex - 500), matchIndex);
            const afterMatch = pageText.substring(matchIndex + fullMatch.length, matchIndex + fullMatch.length + 500);
    
            // Look for event titles in the text around the date/time
            // Event titles are usually in the text after the date/time pattern
            let title = "";
    
            // Try to find title after the date/time pattern
            const afterLines = afterMatch.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            for (const line of afterLines) {
              // Skip common non-title patterns
              if (line.match(/^\$\d+|^Purchase|^Buy|^Free$|^Tickets|^\d+\s*events?/i)) {
                continue;
              }
              // Look for substantial text that could be a title
              if (line.length > 5 && line.length < 200 && !line.match(/^@|^\d+:|^[ap]m/i)) {
                title = line;
                break;
              }
            }
    
            // If no title found after, try looking before the date/time
            if (!title) {
              const beforeLines = beforeMatch.split('\n').map(l => l.trim()).filter(l => l.length > 0);
              // Look at the last few lines before the date/time
              for (let i = beforeLines.length - 1; i >= Math.max(0, beforeLines.length - 5); i--) {
                const line = beforeLines[i];
                if (line.match(/^\$\d+|^Purchase|^Buy|^Free$|^Tickets|^\d+\s*events?/i)) {
                  continue;
                }
                if (line.length > 5 && line.length < 200 && !line.match(/^@|^\d+:|^[ap]m/i)) {
                  title = line;
                  break;
                }
              }
            }
    
            // Find the URL for this event by matching the title
            let eventUrl = window.location.href; // Default to calendar URL
            if (title) {
              // Try exact match first
              if (titleToUrl.has(title)) {
                eventUrl = titleToUrl.get(title);
              } else {
                // Try partial matches
                for (const [linkTitle, url] of titleToUrl.entries()) {
                  if (linkTitle.includes(title) || title.includes(linkTitle)) {
                    eventUrl = url;
                    break;
                  }
                }
              }
            }
    
            // Generate a basic external ID
            const dateSlug = datePart.toLowerCase().replace(/\s+/g, '-');
            const titleSlug = title ? title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 30) : 'event';
            const externalId = `${scraperId}-${dateSlug}-${titleSlug}`;
    
            if (title && title.length > 2) {
              console.log(`[${scraperId}] Found event: "${title}" on "${dateTimeString}" URL: ${eventUrl}`);
              eventsList.push({
                title: title,
                dateTimeString: dateTimeString,
                description: "",
                url: eventUrl,
                external_id: externalId,
              });
            } else {
              console.log(`[${scraperId}] Skipping event with no valid title for date: ${dateTimeString}`);
            }
          } catch (err) {
            console.error(`[${scraperId}] Error processing event pattern ${index}:`, err.message);
          }
        });

        return eventsList;
      } catch (err) {
        console.error(`[${scraperId}] Error in page evaluation:`, err.message);
        return [];
      }
    }, SCRAPER_ID, LOCATION_NAME);

    console.log(`[${SCRAPER_ID}] Found ${rawEvents.length} raw events. Processing...`);

    // Define the date range for filtering
    const dateInterval = {
      start: startOfDay(startDate),
      end: endOfDay(endDate),
    };

    // Deduplicate events by external_id
    const uniqueRawEvents = rawEvents.filter((event, index, self) => 
      index === self.findIndex(e => e.external_id === event.external_id)
    );

    console.log(`[${SCRAPER_ID}] After deduplication: ${uniqueRawEvents.length} unique events`);

    // Process each raw event
    for (const rawEvent of uniqueRawEvents) {
      try {
        // Parse the date and time
        const { date, startTime, endTime } = parseSavageWonderDateTime(rawEvent.dateTimeString);

        // Create ISO date strings
        const startAtIso = combineToISOString(date, startTime);
        const endAtIso = combineToISOString(date, endTime);

        if (!startAtIso) {
          console.warn(`[${SCRAPER_ID}] Could not parse date for event: ${rawEvent.title}`);
          continue;
        }

        // Check if the event is within the requested date range
        const eventDate = new Date(startAtIso);
        if (!isValidDate(eventDate) || !isWithinInterval(eventDate, dateInterval)) {
          console.log(
            `[${SCRAPER_ID}] Event outside date range: ${rawEvent.title} on ${format(eventDate, "yyyy-MM-dd")}`
          );
          continue;
        }

        let description = rawEvent.description || "(Description not available)";

        // Fetch detailed description if URL is available and different from calendar URL
        if (rawEvent.url && rawEvent.url !== CALENDAR_URL && !rawEvent.url.includes("calendar")) {
          try {
            console.log(`[${SCRAPER_ID}] Fetching details for: ${rawEvent.title} from ${rawEvent.url}`);
            await page.goto(rawEvent.url, { waitUntil: "networkidle0", timeout: 45000 });

            const fullDescription = await page.evaluate(() => {
              // Look for the specific span with data-sheets-root="1"
              const sheetsSpan = document.querySelector('span[data-sheets-root="1"]');
              if (sheetsSpan) {
                const text = sheetsSpan.textContent?.trim();
                if (text && text.length > 20) {
                  return sheetsSpan.innerHTML;
                }
              }
              
              // Fallback to other common description containers
              const descSelectors = [
                ".fl-rich-text",
                ".entry-content", 
                ".event-content",
                ".content",
                ".post-content"
              ];
              
              for (const selector of descSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                  const text = element.textContent?.trim();
                  if (text && text.length > 20) {
                    return element.innerHTML;
                  }
                }
              }
              
              return "";
            });

            if (fullDescription && fullDescription.trim()) {
              // Clean up HTML to remove invalid URLs before converting to Markdown
              let cleanedHtml = fullDescription
                // Remove links with invalid/empty href attributes
                .replace(/<a[^>]*href\s*=\s*["'][^"']*["'][^>]*>/gi, '')
                .replace(/<\/a>/gi, '')
                // Remove links with no href or malformed href
                .replace(/<a[^>]*>/gi, '')
                // Remove any remaining link artifacts
                .replace(/href\s*=\s*["'][^"']*["']/gi, '');
              
              description = convertHtmlToMarkdown(cleanedHtml);
              console.log(`[${SCRAPER_ID}] Successfully extracted description for: ${rawEvent.title}`);
            } else {
              console.warn(`[${SCRAPER_ID}] No description content found for: ${rawEvent.title}`);
            }
          } catch (detailError) {
            console.error(`[${SCRAPER_ID}] Error fetching details from ${rawEvent.url}:`, detailError);
          }
        }

        // Create the event object
        const event: Event = {
          title: decode(rawEvent.title),
          description: description,
          start_at: startAtIso,
          end_at: endAtIso,
          url: rawEvent.url,
          location: LOCATION_NAME,
          external_id: rawEvent.external_id,
        };

        events.push(event);
      } catch (processingError) {
        console.error(
          `[${SCRAPER_ID}] Error processing event data for "${rawEvent.title}":`,
          processingError
        );
      }
    }

    console.log(
      `[${SCRAPER_ID}] Finished processing. Found ${events.length} valid events within the date range.`
    );

    // Validate the events before returning
    try {
      const validationResult = EventsArraySchema.parse(events);
      console.log(
        `[${SCRAPER_ID}] Event validation successful for ${validationResult.length} events.`
      );
      return validationResult as Event[];
    } catch (validationError) {
      console.error(`[${SCRAPER_ID}] Zod validation failed:`, validationError);
      throw new Error(`[${SCRAPER_ID}] Event validation failed.`);
    }
  } catch (error) {
    console.error(`[${SCRAPER_ID}] An unexpected error occurred:`, error);
    return [];
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
  }
}

// Export the scraper object
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: LOCATION_NAME,
  scrape: scrapeSavageWonderEvents,
};
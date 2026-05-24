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

const SCRAPER_ID = "that-creative-space";
const BASE_URL = "https://www.thatcreativespace.org";
const EVENTS_URL = "https://app.getoccasion.com/p/stacks/7903/15996";
const DEFAULT_LOCATION = "That Creative Space";

function convert12to24(hour: string, min: string, period: string): string {
  let h = Number.parseInt(hour, 10);
  const isPM = period?.toUpperCase() === "PM";
  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0; // Midnight case
  return `${h.toString().padStart(2, "0")}:${min.padStart(2, "0")}:00`;
}

function parseOccasionDateTime(dateTimeStr: string): {
  date?: Date;
  startTime?: string;
  endTime?: string;
} {
  // Format: "Sun, January 04 2:00 PM - 4:00 PM" or "Sun, January 04 2:00 PM"
  // Extract date part: "Sun, January 04"
  const dateMatch = dateTimeStr.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
  if (!dateMatch) return {};

  const monthName = dateMatch[2];
  const day = dateMatch[3];
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-12

  // Map month name to number
  const monthMap: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const monthNum = monthMap[monthName.toLowerCase()];

  // Determine the year: if the month is before current month, assume next year
  // Otherwise, try current year first, then next year if date is in the past
  let eventDate: Date | undefined;
  try {
    let year = currentYear;
    if (monthNum < currentMonth) {
      year = currentYear + 1;
    }

    eventDate = parseDate(`${monthName} ${day}, ${year}`, "MMMM d, yyyy", new Date());
    
    // If the date is in the past, try next year
    if (isValidDate(eventDate) && eventDate < now) {
      eventDate = parseDate(`${monthName} ${day}, ${year + 1}`, "MMMM d, yyyy", new Date());
    }

    if (!isValidDate(eventDate)) {
      console.warn(`[${SCRAPER_ID}] Invalid date parsed from: ${dateTimeStr}`);
      return {};
    }
  } catch (e) {
    console.warn(`[${SCRAPER_ID}] Failed to parse date from: ${dateTimeStr}`, e);
    return {};
  }

  // Extract time part: "2:00 PM - 4:00 PM" or "2:00 PM"
  const timeMatch = dateTimeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
  if (!timeMatch) {
    return { date: eventDate };
  }

  const startHour = timeMatch[1];
  const startMin = timeMatch[2];
  const startPeriod = timeMatch[3];
  const startTime = convert12to24(startHour, startMin, startPeriod);

  let endTime: string | undefined;
  if (timeMatch[4] && timeMatch[5] && timeMatch[6]) {
    endTime = convert12to24(timeMatch[4], timeMatch[5], timeMatch[6]);
  }

  return {
    date: eventDate,
    startTime,
    endTime,
  };
}

const scrapeThatCreativeSpaceEvents = async (
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

    // Wait for event links to load
    await page.waitForSelector('a[href*="/p/n/"]', { timeout: 10000 }).catch(() => {
      console.warn(`[${SCRAPER_ID}] Event links selector not found, continuing anyway...`);
    });

    // Extract all event links from the page
    const eventLinks = await page.$$eval('a[href*="/p/n/"]', (links) => {
      return links.map((link) => {
        const href = link.getAttribute("href") || "";
        
        // Get text from parent container
        const parent = link.closest('div, article, section, li');
        const fullText = parent?.textContent?.trim() || link.textContent?.trim() || "";
        
        // Extract the full URL
        let eventUrl = href;
        if (href.startsWith("/")) {
          eventUrl = `https://app.getoccasion.com${href}`;
        } else if (!href.startsWith("http")) {
          eventUrl = `https://app.getoccasion.com/${href}`;
        }

        return {
          href: eventUrl,
          fullText,
        };
      });
    });

    console.log(`[${SCRAPER_ID}] Found ${eventLinks.length} event links`);

    for (const link of eventLinks) {
      try {
        const fullText = link.fullText;
        
        // Parse the event text structure:
        // "Title (Category) Description … Day, Month DD H:MM AM/PM - H:MM AM/PM Book Now"
        // or "Title (Category) Description … Day, Month DD H:MM AM/PM Book Now"
        
        // Extract date/time string (look for pattern like "Sun, January 04 2:00 PM - 4:00 PM")
        const dateTimeMatch = fullText.match(/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s+\d{1,2}:\d{2}\s*(?:AM|PM)(?:\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM))?)/i);
        if (!dateTimeMatch) {
          console.warn(`[${SCRAPER_ID}] Could not find date/time in: ${fullText.substring(0, 100)}...`);
          continue;
        }

        const dateTimeStr = dateTimeMatch[1];
        const { date: eventDate, startTime, endTime } = parseOccasionDateTime(dateTimeStr);

        if (!eventDate || !startTime) {
          console.warn(`[${SCRAPER_ID}] Could not parse date/time from: ${dateTimeStr}`);
          continue;
        }

        // Extract title - everything before the first opening parenthesis
        // The title is typically the first line before any category or description
        const categoryMatch = fullText.match(/\(([^)]+)\)/);
        let title = "";
        if (categoryMatch && categoryMatch.index !== undefined) {
          // Title is everything before the category
          title = fullText.substring(0, categoryMatch.index).trim();
        } else {
          // If no category, title is everything before the date/time
          const dateTimeIndex = fullText.indexOf(dateTimeStr);
          title = dateTimeIndex > 0 ? fullText.substring(0, dateTimeIndex).trim() : fullText.substring(0, 100).trim();
        }
        
        // Clean up title - remove extra whitespace and newlines
        title = title.replace(/\s+/g, " ").replace(/\n+/g, " ").trim();

        // Navigate to event detail page to get full description
        let description = "";
        try {
          if (options.verbose) {
            console.log(`[${SCRAPER_ID}] Navigating to event page: ${link.href}`);
          }
          await page.goto(link.href, { waitUntil: "networkidle0", timeout: 30000 });
          
          // Wait for and click "Read more" button if it exists
          try {
            const readMoreButton = await page.waitForSelector(
              'button[data-action="read-more#toggle"]',
              { timeout: 5000 }
            );
            if (readMoreButton) {
              await readMoreButton.click();
              // Wait a bit for content to expand
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } catch (e) {
            // "Read more" button might not exist, continue anyway
          }

          // Extract full description from the detail page
          // Use $$eval to get all paragraph texts, then process in Node.js
          let descriptionText = "";
          try {
            const paragraphTexts = await page.$$eval(
              'section[class*="space-y-8"] p, section[class*="space-y"] p, main section p',
              (paragraphs) => {
                return Array.from(paragraphs).map(p => (p.textContent || '').trim());
              }
            ).catch(() => []);

            if (paragraphTexts && paragraphTexts.length > 0) {
              const descriptionParts: string[] = [];
              
              // Helper function to check if texts are similar (in Node.js context, TypeScript works fine)
              const isSimilar = (text1: string, text2: string): boolean => {
                const t1 = text1.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');
                const t2 = text2.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');
                const minLength = Math.min(t1.length, t2.length);
                if (minLength < 50) return false;
                const shorter = t1.length < t2.length ? t1 : t2;
                const longer = t1.length >= t2.length ? t1 : t2;
                const compareLength = Math.floor(shorter.length * 0.8);
                return longer.substring(0, compareLength) === shorter.substring(0, compareLength);
              };
              
              for (const text of paragraphTexts) {
                // Skip empty or very short text
                if (!text || text.length < 10) {
                  continue;
                }
                
                // Skip truncated text (ends with ellipsis)
                if (text.endsWith('…') || /…\s*$/.test(text)) {
                  continue;
                }
                
                // Skip navigation/UI elements
                if (text.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i) ||
                    text.includes('Book Now') ||
                    text.includes('Read more') ||
                    text.includes('Read less') ||
                    text.match(/^\d{1,2}:\d{2}\s*(AM|PM)/i) ||
                    text.match(/^\$\d+/) ||
                    text.match(/^Select/)) {
                  continue;
                }
                
                // Check for duplicates - only skip exact duplicates or clear truncated versions
                let shouldAdd = true;
                let replaceIndex = -1;
                
                for (let i = 0; i < descriptionParts.length; i++) {
                  const existing = descriptionParts[i];
                  
                  // Exact duplicate
                  if (text === existing) {
                    shouldAdd = false;
                    break;
                  }
                  
                  // Check if one is clearly a truncated version of the other
                  const normalizedText = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
                  const normalizedExisting = existing.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
                  
                  // If they start the same way and one is significantly longer, it's likely a duplicate
                  const minStartLength = Math.min(normalizedText.length, normalizedExisting.length, 100);
                  if (minStartLength > 50) {
                    const textStart = normalizedText.substring(0, minStartLength);
                    const existingStart = normalizedExisting.substring(0, minStartLength);
                    
                    if (textStart === existingStart) {
                      // One is a truncated version - prefer the longer one
                      if (text.length > existing.length * 1.2) {
                        // Current text is significantly longer, replace existing
                        replaceIndex = i;
                        break;
                      } else if (existing.length > text.length * 1.2) {
                        // Existing is significantly longer, skip current
                        shouldAdd = false;
                        break;
                      }
                    }
                  }
                  
                  // Check similarity for very similar texts
                  if (isSimilar(text, existing)) {
                    if (text.length > existing.length * 1.1) {
                      replaceIndex = i;
                      break;
                    } else if (existing.length > text.length * 1.1) {
                      shouldAdd = false;
                      break;
                    }
                  }
                }
                
                if (shouldAdd) {
                  if (replaceIndex >= 0) {
                    // Replace shorter version with longer version
                    descriptionParts[replaceIndex] = text;
                  } else {
                    // Add new paragraph
                    descriptionParts.push(text);
                  }
                }
              }
              
              if (descriptionParts.length > 0) {
                descriptionText = descriptionParts.join('\n\n');
              }
            }
          } catch (extractError) {
            console.warn(`[${SCRAPER_ID}] Error extracting description:`, extractError);
            descriptionText = "";
          }

          description = descriptionText || "";
          
          // Only use listing text as fallback if we got nothing from detail page
          if (!description && categoryMatch && categoryMatch.index !== undefined) {
            const descStart = categoryMatch.index + categoryMatch[0].length;
            const descEnd = fullText.indexOf(dateTimeStr);
            if (descEnd > descStart) {
              description = fullText.substring(descStart, descEnd).trim();
              description = description.replace(/…/g, "").replace(/\s+/g, " ").trim();
            }
          }
        } catch (detailError) {
          console.warn(`[${SCRAPER_ID}] Error fetching description from detail page:`, detailError);
          // Fallback to extracting from listing text (only if detail page failed)
          if (categoryMatch && categoryMatch.index !== undefined) {
            const descStart = categoryMatch.index + categoryMatch[0].length;
            const descEnd = fullText.indexOf(dateTimeStr);
            if (descEnd > descStart) {
              description = fullText.substring(descStart, descEnd).trim();
              description = description.replace(/…/g, "").replace(/\s+/g, " ").trim();
            }
          }
        }
        
        // Clean up description - ensure proper newline formatting
        if (description) {
          // Replace multiple newlines with double newlines (paragraph breaks)
          description = description.replace(/\n{3,}/g, '\n\n');
          // Ensure no trailing whitespace
          description = description.trim();
        }

        // Create ISO date strings
        const startAt = formatISO(
          parseDate(
            `${formatDateFn(eventDate, "yyyy-MM-dd")}T${startTime}`,
            "yyyy-MM-dd'T'HH:mm:ss",
            new Date()
          )
        );

        let endAt: string | undefined;
        if (endTime) {
          endAt = formatISO(
            parseDate(
              `${formatDateFn(eventDate, "yyyy-MM-dd")}T${endTime}`,
              "yyyy-MM-dd'T'HH:mm:ss",
              new Date()
            )
          );
        }

        // Create external ID from title and date
        const titleSlug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .substring(0, 50); // Limit length

        const eventData: Event = {
          title: title,
          description: convertHtmlToMarkdown(description || ""),
          start_at: startAt,
          ...(endAt ? { end_at: endAt } : {}),
          url: link.href,
          location: DEFAULT_LOCATION,
          external_id: `${SCRAPER_ID}-${formatDateFn(eventDate, "yyyy-MM-dd")}-${titleSlug}`,
        };

        allFoundEvents.push(eventData);
        logEventFound(SCRAPER_ID, eventData);
      } catch (eventError) {
        console.error(`[${SCRAPER_ID}] Error processing event link:`, eventError);
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
  scrape: scrapeThatCreativeSpaceEvents,
};

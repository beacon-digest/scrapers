import { format } from "date-fns";

/**
 * Logs a single event found by a scraper in a standardized format.
 * @param scraperId The ID of the scraper (e.g., "howland-library")
 * @param event The event object with at minimum title and start_at
 */
export function logEventFound(
  scraperId: string,
  event: { title: string; start_at: string; location?: string }
): void {
  const date = new Date(event.start_at);
  const dateStr = format(date, "yyyy-MM-dd");
  const timeStr = format(date, "h:mm a");
  const location = event.location ? ` @ ${event.location}` : "";
  console.log(`[${scraperId}] ✓ ${event.title} - ${dateStr} ${timeStr}${location}`);
}

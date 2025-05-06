import type * as puppeteer from "puppeteer";
// Import the specific type if possible, otherwise use string and cast later
import type { EmojiRequest } from "@notionhq/client/build/src/api-endpoints";

// Structure matching Notion API's icon object
export type NotionIcon =
  | { type: "emoji"; emoji: EmojiRequest }
  | { type: "external"; external: { url: string } };

export interface Event {
  title: string;
  description: string;
  location: string;
  start_at: string; // ISO 8601 format (e.g., "2024-07-01T18:00:00Z")
  end_at?: string; // ISO 8601 format
  url?: string;
  external_id: string; // Unique identifier for the event instance (e.g., scraper_id-date-title_slug)
  icon?: NotionIcon; // Optional icon for Notion page
}

export interface Scraper {
  id: string;
  name: string;
  scrape(options: ScrapeOptions): Promise<Event[]>;
}

export interface ScrapeOptions {
  /** The start date for the scraping range */
  startDate: Date;
  /** The end date for the scraping range (optional, defaults to startDate if omitted) */
  endDate?: Date;
  /** Optional shared browser instance */
  browser?: puppeteer.Browser;
}

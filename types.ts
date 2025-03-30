import type * as puppeteer from "puppeteer";

export interface Event {
  title: string;
  description: string;
  start_at: string;
  end_at?: string;
  url: string;
  location: string;
  external_id: string;
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

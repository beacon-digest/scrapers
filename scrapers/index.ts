import type { Scraper } from "../types.js";
import { scraper as howlandLibraryScraper } from "./howland-public-library.js";
import { scraper as stanzaBooksScraper } from "./stanza-books.js";
import { scraper as towneCrierScraper } from "./towne-crier.js";
import { scraper as diaBeaconScraper } from "./dia-beacon.js";

/**
 * A list of all available scrapers.
 * Add new scraper objects to this array.
 */
export const scrapers: Scraper[] = [
  howlandLibraryScraper,
  stanzaBooksScraper,
  towneCrierScraper,
  diaBeaconScraper,
];

/**
 * Finds a scraper implementation by its unique ID.
 * @param id The ID of the scraper to find (e.g., 'howland-library').
 * @returns The scraper object if found, otherwise undefined.
 */
export function findScraperById(id: string): Scraper | undefined {
  return scrapers.find((s) => s.id === id);
}

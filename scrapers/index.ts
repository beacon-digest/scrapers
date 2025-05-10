import type { Scraper } from "../types.js";
import { scraper as howlandLibraryScraper } from "./howland-public-library.js";
import { scraper as stanzaBooksScraper } from "./stanza-books.js";
import {
  scraper as towneCrierMainStageScraper,
  salonScraper as towneCrierSalonScraper,
} from "./towne-crier.js";
import { scraper as diaBeaconScraper } from "./dia-beacon.js";
import { scraper as theYardBeaconScraper } from "./the-yard-beacon.js";
import { scraper as repeatingEventsScraper } from "./repeating-events.js";
import { scraper as beahiveBeaconScraper } from "./beahive-beacon.js";

/**
 * A list of all available scrapers.
 * Add new scraper objects to this array.
 */
export const scrapers: Scraper[] = [
  howlandLibraryScraper,
  stanzaBooksScraper,
  towneCrierMainStageScraper,
  towneCrierSalonScraper,
  diaBeaconScraper,
  theYardBeaconScraper,
  repeatingEventsScraper,
  beahiveBeaconScraper,
];

/**
 * Finds a scraper implementation by its unique ID.
 * @param id The ID of the scraper to find (e.g., 'howland-library').
 * @returns The scraper object if found, otherwise undefined.
 */
export function findScraperById(id: string): Scraper | undefined {
  return scrapers.find((s) => s.id === id);
}

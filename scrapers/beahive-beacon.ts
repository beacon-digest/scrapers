import fetch from "node-fetch";
import * as cheerio from "cheerio";
import type { Event, ScrapeOptions, Scraper } from "../types.js";

export const scraper: Scraper = {
  id: "beahive-beacon",
  name: "Beahive Beacon",
  async scrape(options: ScrapeOptions): Promise<Event[]> {
    const listingUrl = "https://beahivebeacon.spaces.nexudus.com/events?&v=latest&page=1";
    const listingRes = await fetch(listingUrl);
    const listingHtml = await listingRes.text();
    const $ = cheerio.load(listingHtml);
    const events: Event[] = [];

    // Assume events are rendered as list items (li) containing an anchor with href starting with "/events/"
    $("li").each((i, el) => {
      const anchor = $(el).find("a[href^='/events/']").first();
      if (anchor.length === 0) return;
      const eventHref = anchor.attr("href");
      if (!eventHref) return;
      const fullUrl = `https://beahivebeacon.spaces.nexudus.com${eventHref}`;
      const idMatch = eventHref.match(/^\/events\/(\d+)/);
      if (!idMatch) return;
      const external_id = idMatch[1];

      // Check if the list item contains the location text "Beahive Beacon"
      const liText = $(el).text();
      if (!liText.includes("Beahive Beacon")) return;

      // Create a preliminary event object; more details will be added after fetching the event's page.
      events.push({
        title: anchor.text().trim(),
        description: "",
        location: "Beahive Beacon",
        start_at: "",
        url: fullUrl,
        external_id,
      });
    });

    // For each event, open its detail page and scrape additional information.
    for (let event of events) {
      try {
        const eventRes = await fetch(event.url);
        const eventHtml = await eventRes.text();
        const $detail = cheerio.load(eventHtml);

        // Heuristics to scrape details:
        // Title: try h1 first.
        const title = $detail("h1").first().text().trim();
        if (title) {
          event.title = title;
        }

        // Description: try a container with class "event-description".
        const descHTML = $detail(".event-description").first().html() || "";
        event.description = descHTML;

        // Date: Look for a date label in the page text matching "Date: <date string>"
        const bodyText = $detail("body").text();
        const dateMatch = bodyText.match(/Date:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/);
        if (dateMatch) {
          const parsedDate = new Date(dateMatch[1]);
          if (!isNaN(parsedDate.getTime())) {
            event.start_at = parsedDate.toISOString();
          }
        }
      } catch (err) {
        console.error(`Error scraping event detail from ${event.url}: ${err}`);
      }
    }
    return events;
  },
};

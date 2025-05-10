import type { Browser, Page } from "puppeteer";
import type { Event, ScrapeOptions, Scraper } from "../types.js";

export const scraper: Scraper = {
  id: "beahive-beacon",
  name: "Beahive Beacon",
  async scrape(options: ScrapeOptions): Promise<Event[]> {
    const { browser } = options;
    if (!browser) {
      throw new Error("A Puppeteer browser instance must be provided.");
    }
    const listingUrl = "https://beahivebeacon.spaces.nexudus.com/events?&v=latest&page=1";
    const page = await browser.newPage();
    await page.goto(listingUrl, { waitUntil: "networkidle0", timeout: 60000 });
    const listingHtml = await page.content();
    const events: Event[] = await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll("li"));
      return lis.map(el => {
        const anchor = el.querySelector("a[href^='/events/']");
        if (!anchor) return null;
        const eventHref = anchor.getAttribute("href");
        if (!eventHref) return null;
        const fullUrl = "https://beahivebeacon.spaces.nexudus.com" + eventHref;
        const idMatch = eventHref.match(/^\/events\/(\d+)/);
        if (!idMatch) return null;
        const external_id = idMatch[1];
        const liText = el.innerText;
        if (!liText.includes("Beahive Beacon")) return null;
        return {
          title: anchor.innerText.trim(),
          description: "",
          location: "Beahive Beacon",
          start_at: "",
          url: fullUrl,
          external_id,
        };
      }).filter(x => x !== null);
    });

    // For each event, open its detail page and scrape additional information.
    for (let event of events) {
      try {
        await page.goto(event.url, { waitUntil: "networkidle0", timeout: 60000 });
        const details = await page.evaluate(() => {
          const result: { title: string; description: string; dateString: string; } = {
            title: "",
            description: "",
            dateString: ""
          };
          const h1 = document.querySelector("h1");
          if (h1) {
            result.title = h1.innerText.trim();
          }
          const descElem = document.querySelector(".event-description");
          if (descElem) {
            result.description = descElem.innerHTML;
          }
          const bodyText = document.body.innerText;
          const dateMatch = bodyText.match(/Date:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/);
          if (dateMatch) {
            result.dateString = dateMatch[1];
          }
          return result;
        });
        if (details.title) {
          event.title = details.title;
        }
        if (details.description) {
          event.description = details.description;
        }
        if (details.dateString) {
          const parsedDate = new Date(details.dateString);
          if (!isNaN(parsedDate.getTime())) {
            event.start_at = parsedDate.toISOString();
          }
        }
      } catch (err) {
        console.error(`Error scraping event detail from ${event.url}: ${err}`);
      }
    }
    await page.close();
    return events;
  },
};

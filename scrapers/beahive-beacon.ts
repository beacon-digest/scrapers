import type { Browser, Page } from "puppeteer";
import type { Event, ScrapeOptions, Scraper } from "../types.js";
import { parse } from "date-fns";

export const scraper: Scraper = {
  id: "beahive-beacon",
  name: "Beahive Beacon",
  async scrape(options: ScrapeOptions): Promise<Event[]> {
    const { browser } = options;
    if (!browser) {
      throw new Error("A Puppeteer browser instance must be provided.");
    }
    const listingUrl = "https://beahivebeacon.spaces.nexudus.com/events";
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36");
    await page.goto(listingUrl, { waitUntil: "networkidle0", timeout: 60000 });
    const listingHtml = await page.content();

    const events: Event[] = await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll("li"));
      console.log({ lis });
      return lis.map(el => {
        const anchor = el.querySelector("a[href^='/events/']");
        console.log({ anchor });
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
          const result: { title: string; description: string; dateString?: string; endDateString?: string; } = {
            title: "",
            description: ""
          };
          const h1 = document.querySelector("h1");
          if (h1) {
            result.title = h1.innerText.trim();
          }
          const descElem = document.querySelector(".event-page-details");
          if (descElem) {
            result.description = descElem.innerHTML;
          }
          const timeContainer = document.querySelector(".card-event__time");
          if (timeContainer) {
            const timeElements = timeContainer.querySelectorAll("time");
            if (timeElements.length >= 2) {
              result.dateString = timeElements[0].innerText.replace(/Start Time\s*/, "").trim();
              result.endDateString = timeElements[1].innerText.replace(/End Time\s*/, "").trim();
            }
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
          const parsedStartDate = parse(details.dateString, "MMM d, yyyy h:mm a", new Date());
          if (!isNaN(parsedStartDate.getTime())) {
            event.start_at = parsedStartDate.toISOString();
          }
        }
        if (details.endDateString) {
          const parsedEndDate = parse(details.endDateString, "MMM d, yyyy h:mm a", new Date());
          if (!isNaN(parsedEndDate.getTime())) {
            event.end_at = parsedEndDate.toISOString();
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

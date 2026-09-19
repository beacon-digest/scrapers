import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";
import slugify from "slugify";
import { addDays } from "date-fns";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import puppeteer, { type Browser } from "puppeteer";
import { Client } from "@notionhq/client";
import { createInterface, type Interface } from "node:readline/promises";

import type { Event } from "../types.js";
import { getBrowserInstance, closeBrowserInstance } from "../utils/browser.js";
import { fetchInstagramPost, parseInstagramUrl, type InstagramPost } from "../utils/instagram.js";
import { extractEventsFromPost, type ExtractedEvent } from "../utils/event-extractor.js";
import { loadRecurringRules, findRecurringConflict, type RecurringRule } from "../utils/recurring-events.js";
import { readLine } from "../utils/interactive.js";
import { resolveLocation } from "../utils/notion-locations.js";
import { EventsArraySchema } from "../utils/validation.js";
import { logEventFound } from "../utils/logging.js";
import { postEventsToNotion } from "../api/notion-poster.js";

dotenv.config();

const SCRAPER_ID = "instagram";
const TIME_ZONE = "America/New_York";

/**
 * Usage:
 *   pnpm instagram <url> [<url> ...] [--dry-run] [--verbose]
 *   pnpm instagram <url> --fetch-only     # print caption/images, no LLM call
 *   pnpm instagram <url> --caption-only   # LLM without images (cheaper)
 *   pnpm instagram                        # no URL given: prompts for one
 *                                          # per line, blank line to finish
 *
 * Paste any Instagram post URL (query params like ?img_index=1 are ignored).
 * The post is loaded in headless Chrome, its caption and carousel images are
 * sent to an OpenAI vision model, and each dated event found is posted to Notion.
 */

/** Wall-clock "YYYY-MM-DD HH:MM" in New York -> ISO instant. */
function toIso(date: string, time: string): string {
  return fromZonedTime(`${date} ${time}:00`, TIME_ZONE).toISOString();
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The model's structured output is schema-valid (right type) but not always
 * semantically valid — e.g. it has been observed putting a stray field name
 * like "price" into `end_time`. Coerce anything that doesn't look like an
 * actual HH:MM into null rather than let it reach date parsing.
 */
function sanitizeTime(value: string | null, field: string, eventTitle: string): string | null {
  if (value === null) return null;
  if (HHMM_RE.test(value)) return value;
  console.warn(`[instagram] "${eventTitle}": ignoring malformed ${field} "${value}" (expected HH:MM)`);
  return null;
}

/**
 * Vision models are prone to "helpfully" fabricating a plausible-looking
 * ticket URL (a real domain, a realistic-looking numeric ID) instead of
 * reporting that none was found. Prompting alone doesn't reliably stop this,
 * so independently verify: only trust a URL that actually appears, verbatim,
 * somewhere in the post's own text (caption or image alt text) — a link a
 * human actually typed into the post will; a fabricated one won't.
 */
function sanitizeUrl(value: string | null, eventTitle: string, sourceText: string): string | null {
  if (value === null) return null;
  if (!/^https?:\/\//i.test(value)) {
    console.warn(`[instagram] "${eventTitle}": ignoring malformed url "${value}" (expected an absolute URL)`);
    return null;
  }
  const stripped = value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!sourceText.toLowerCase().includes(stripped.toLowerCase())) {
    console.warn(
      `[instagram] "${eventTitle}": ignoring url "${value}" — not found verbatim in the post (likely hallucinated)`,
    );
    return null;
  }
  return value;
}

/** Converts one LLM-extracted event into the calendar's Event shape. */
export function toCalendarEvent(extracted: ExtractedEvent, post: InstagramPost): Event {
  const startTimeRaw = sanitizeTime(extracted.start_time, "start_time", extracted.title);
  const endTimeRaw = sanitizeTime(extracted.end_time, "end_time", extracted.title);
  const sourceText = [post.caption, ...post.images.map((i) => i.alt)].join("\n");
  const url = sanitizeUrl(extracted.url, extracted.title, sourceText);

  const startTime = startTimeRaw ?? "00:00";
  const start_at = toIso(extracted.date, startTime);

  let end_at: string | undefined;
  if (endTimeRaw) {
    let end = fromZonedTime(`${extracted.date} ${endTimeRaw}:00`, TIME_ZONE);
    // "10PM–2AM" crosses midnight.
    if (end <= new Date(start_at)) end = addDays(end, 1);
    end_at = end.toISOString();
  }

  const descriptionParts = [extracted.description.trim()];
  if (!startTimeRaw) descriptionParts.push("_Time not listed in the post — check with the organizer._");

  const slug = slugify(extracted.title, { lower: true, strict: true }).slice(0, 60);

  return {
    title: extracted.title.trim(),
    description: descriptionParts.join("\n\n"),
    location: extracted.location.trim(),
    start_at,
    end_at,
    url: url ?? post.url,
    external_id: `${SCRAPER_ID}-${post.shortcode}-${extracted.date}-${slug}`,
    icon: { type: "emoji", emoji: "📸" },
  };
}

function printPost(post: InstagramPost): void {
  console.log(`\n📸 @${post.author}${post.authorName ? ` (${post.authorName})` : ""} — posted ${post.postedOn ?? "?"}`);
  console.log(`   ${post.url}`);
  console.log(`   ${post.images.length} image(s)`);
  for (const [i, img] of post.images.entries()) {
    console.log(`     ${i + 1}. ${img.url.split("?")[0]}`);
    if (img.alt) console.log(`        alt: ${img.alt.slice(0, 160)}${img.alt.length > 160 ? "…" : ""}`);
  }
  console.log("   Caption:");
  for (const line of post.caption.split("\n")) console.log(`     │ ${line}`);
}

function printExtracted(events: ExtractedEvent[], skipped: string[], notes: string | null): void {
  console.log(`\n🧠 Found ${events.length} event(s):`);
  for (const e of events) {
    const time = e.start_time ? `${e.start_time}${e.end_time ? `–${e.end_time}` : ""}` : "time n/a";
    console.log(`   • ${e.date} ${time.padEnd(12)} ${e.title}  @ ${e.location}  [${e.confidence}, from ${e.source}]`);
    if (e.price) console.log(`       price: ${e.price}`);
    if (e.url) console.log(`       url: ${e.url}`);
  }
  if (skipped.length) {
    console.log(`   Skipped (${skipped.length}):`);
    for (const s of skipped) console.log(`     - ${s}`);
  }
  if (notes) console.log(`   Notes: ${notes}`);
}

/**
 * The shared browser is the system Chrome. On some machines Instagram refuses
 * its connections outright (net::ERR_SOCKET_NOT_CONNECTED) while accepting
 * puppeteer's bundled headless shell, so fall back to that once and reuse it.
 */
let fallbackBrowser: Browser | null = null;

async function fetchPostWithFallback(url: string, shared: Browser, verbose: boolean): Promise<InstagramPost> {
  try {
    return await fetchInstagramPost(url, { browser: fallbackBrowser ?? shared, verbose });
  } catch (err) {
    const msg = (err as Error).message;
    if (fallbackBrowser || !/net::ERR_|Timed out loading/.test(msg)) throw err;
    console.warn(`⚠️  System Chrome could not connect to Instagram (${msg.split(" at ")[0]}). Retrying with puppeteer's bundled headless shell...`);
    try {
      fallbackBrowser = await puppeteer.launch({
        headless: "shell",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
      });
    } catch (launchErr) {
      throw new Error(
        `Instagram refused system Chrome and the bundled headless shell is not installed. ` +
          `Run \`npx puppeteer browsers install chrome-headless-shell\` once, then retry. ` +
          `(${(launchErr as Error).message.split("\n")[0]})`,
      );
    }
    return await fetchInstagramPost(url, { browser: fallbackBrowser, verbose });
  }
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("scrape-instagram")
    .usage("$0 [url] [url ...] [--dry-run] [--fetch-only] [--caption-only] [--verbose]")
    .command("$0 [urls...]", "Extract events from one or more Instagram posts", (y) =>
      y.positional("urls", {
        type: "string",
        array: true,
        describe: "Instagram post URL(s). Omit to be prompted for them one at a time.",
      }),
    )
    .option("dry-run", { alias: "n", type: "boolean", default: false, describe: "Extract but do not post to Notion" })
    .option("fetch-only", { type: "boolean", default: false, describe: "Only fetch and print the post; skip the LLM" })
    .option("caption-only", { type: "boolean", default: false, describe: "Send the caption to the model without images" })
    .option("verbose", { alias: "v", type: "boolean", default: false })
    .option("ignore-recurring", {
      type: "boolean",
      default: false,
      describe: "Don't skip events that look like a duplicate of a repeating-events.json rule",
    })
    .help()
    .strict()
    .parse();

  // One readline interface for the whole run, reused for both URL collection
  // below and location confirmation later. A second, separately-created
  // interactive prompt (whether a fresh readline interface or an inquirer
  // prompt) has been observed to break mid-process in this environment —
  // reusing a single instance throughout is what's reliable.
  const rl: Interface = createInterface({ input: process.stdin });

  let rawUrls = (argv.urls as string[] | undefined) ?? [];

  if (rawUrls.length === 0) {
    const collected: string[] = [];
    console.log("No URL given — paste Instagram post links one at a time (blank line to finish):");
    while (true) {
      const line = await readLine(rl, `URL ${collected.length + 1}:`);
      if (line === null) break;
      const trimmed = line.trim();
      if (!trimmed) break;
      try {
        parseInstagramUrl(trimmed);
        collected.push(trimmed);
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`);
      }
    }
    if (collected.length === 0) {
      console.error("❌ No URLs entered.");
      rl.close();
      process.exit(1);
    }
    rawUrls = collected;
  }

  const urls = rawUrls.map((u) => parseInstagramUrl(u).url);
  const willPost = !argv.dryRun && !argv.fetchOnly;

  if (willPost && (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID)) {
    console.error("❌ NOTION_API_KEY and NOTION_DATABASE_ID must be set to post (or pass --dry-run).");
    process.exit(1);
  }
  if (!argv.fetchOnly && !process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY is not set. Add it to .env, or pass --fetch-only to skip extraction.");
    process.exit(1);
  }

  const recurringRules: RecurringRule[] =
    argv.fetchOnly || argv.ignoreRecurring ? [] : await loadRecurringRules();
  if (recurringRules.length && argv.verbose) {
    console.log(`[instagram] Loaded ${recurringRules.length} recurring-event rule(s) for duplicate checking.`);
  }

  let browser: Browser | null = null;
  let hadError = false;
  const allEvents: Event[] = [];
  const skippedRecurring: { extracted: ExtractedEvent; rule: RecurringRule }[] = [];

  try {
    browser = await getBrowserInstance();

    for (const url of urls) {
      try {
        const post = await fetchPostWithFallback(url, browser, argv.verbose);
        printPost(post);
        if (argv.fetchOnly) continue;

        console.log(`\n🧠 Extracting events (calling OpenAI, up to ~90s)...`);
        const result = await extractEventsFromPost(post, {
          verbose: argv.verbose,
          captionOnly: argv.captionOnly,
        });
        printExtracted(result.events, result.skipped, result.notes);

        // Convert one event at a time: a single malformed date/time from the
        // model shouldn't cost us every other valid event found in the post.
        const events: Event[] = [];
        for (const e of result.events) {
          const conflict = findRecurringConflict(e, recurringRules);
          if (conflict) {
            console.warn(
              `⚠️  Skipping "${e.title}" on ${e.date} — looks like the same occurrence as the recurring ` +
                `"${conflict.title}" at ${conflict.location} (rule "${conflict.ruleId}", already generated automatically). ` +
                `Pass --ignore-recurring to post it anyway.`,
            );
            skippedRecurring.push({ extracted: e, rule: conflict });
            continue;
          }
          try {
            events.push(toCalendarEvent(e, post));
          } catch (err) {
            hadError = true;
            console.error(`❌ "${e.title}" (${e.date}): ${(err as Error).message}`);
          }
        }
        const validated = EventsArraySchema.safeParse(events);
        if (!validated.success) {
          hadError = true;
          console.error(`❌ Extracted events failed validation for ${url}:`);
          console.error(validated.error.format());
          continue;
        }
        for (const ev of validated.data) logEventFound(SCRAPER_ID, ev);
        allEvents.push(...validated.data);
      } catch (err) {
        hadError = true;
        console.error(`❌ ${url}: ${(err as Error).message}`);
        if (argv.verbose) console.error(err);
      }
    }

    if (argv.fetchOnly) return;

    if (skippedRecurring.length) {
      console.log(
        `\n🔁 Skipped ${skippedRecurring.length} event(s) already covered by repeating-events.json:`,
      );
      for (const { extracted, rule } of skippedRecurring) {
        console.log(`   - "${extracted.title}" on ${extracted.date}  →  rule "${rule.ruleId}" ("${rule.title}")`);
      }
    }

    const past = allEvents.filter((e) => new Date(e.start_at) < new Date());
    if (past.length) {
      console.warn(
        `\n⚠️  ${past.length} event(s) are in the past (before ${formatInTimeZone(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm zzz")}) and will still be posted:`,
      );
      for (const e of past) console.warn(`   - ${e.title} (${e.start_at})`);
    }

    if (allEvents.length === 0) {
      console.log("\nNo events to post.");
    } else if (argv.dryRun) {
      console.log(`\n🌵 Dry run: ${allEvents.length} event(s) not posted.`);
      if (argv.verbose) console.log(JSON.stringify(allEvents, null, 2));
    } else {
      const notion = new Client({ auth: process.env.NOTION_API_KEY });
      const databaseId = process.env.NOTION_DATABASE_ID!;
      for (const e of allEvents) {
        const resolved = await resolveLocation(e.location, notion, databaseId, rl);
        if (resolved !== e.location) {
          console.log(`[instagram] Location "${e.location}" → "${resolved}"`);
          e.location = resolved;
        }
      }

      console.log(`\n📤 Posting ${allEvents.length} event(s) to Notion...`);
      const res = await postEventsToNotion(allEvents);
      console.log(`✅ created=${res.created} skipped=${res.skipped} failed=${res.failed}`);
      for (const e of res.errors) console.error(`   ✗ ${e.eventTitle}: ${e.message}`);
      if (res.failed > 0) hadError = true;
    }
  } finally {
    rl.close();
    if (fallbackBrowser) await fallbackBrowser.close().catch(() => {});
    if (browser) await closeBrowserInstance();
    if (hadError) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});

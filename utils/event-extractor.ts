import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";

import type { InstagramPost } from "./instagram.js";
import { downloadImageAsBase64 } from "./instagram.js";

/**
 * Uses an OpenAI vision model to turn an Instagram post — caption plus poster
 * image(s) — into zero or more structured calendar events.
 *
 * Why an LLM: Instagram captions are free-form. A single post may list a whole
 * month of events ("SAT 9/5 • RAVE AT ARCADE • 10PM ...") or describe one
 * event whose date and time appear *only* in the poster image. Regexes can't
 * cover that; a vision model reads both the caption and the flyer.
 */

const TIME_ZONE = "America/New_York";
// GPT-5.6 Luna: OpenAI's cheapest tier from the 2026-07-09 GPT-5.6 release,
// meant for high-volume workloads. Change here (or set OPENAI_MODEL) if your
// account uses a different name, or to step back up to gpt-5.6-terra /
// gpt-5.6-sol for better quality.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
const MAX_IMAGES = 10;

export const ExtractedEventSchema = z.object({
  title: z
    .string()
    .describe("Short event name in Title Case, without date/time/price. E.g. 'Karaoke Boys' or 'Silent Book Club: Outdoor Meetup'."),
  description: z
    .string()
    .describe("1-3 sentence plain-language description specific to this event (Markdown allowed, no hashtags). Include price/cover, age restriction, and RSVP details when stated."),
  location: z
    .string()
    .describe("Venue name, plus street address if shown. If the post never names a venue, use the account's own venue when the account clearly *is* a venue (e.g. a bar posting its own calendar); otherwise 'Beacon, NY' or the best available place name."),
  date: z
    .string()
    .describe("Event date as YYYY-MM-DD. Infer the year from the post date: pick the first occurrence on or after the post date."),
  start_time: z
    .string()
    .nullable()
    .describe("Start time as 24-hour HH:MM in local time, or null if not stated anywhere."),
  end_time: z
    .string()
    .nullable()
    .describe("End time as 24-hour HH:MM, or null if not stated."),
  price: z.string().nullable().describe("Price/cover text exactly as stated (e.g. '$5', 'FREE', '$15 advance / $20 door'), or null."),
  url: z
    .string()
    .nullable()
    .describe("A ticket/RSVP/registration URL, ONLY if it is written character-for-character in the caption or visibly printed in an image. Never the Instagram post URL itself. Never a URL you construct, guess, or autocomplete (e.g. a plausible-looking Eventbrite/Ticketspice link) — if you are not copying text that is actually present, use null."),
  source: z
    .enum(["caption", "image", "both"])
    .describe("Where the date/time information came from."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("high = date and time explicit; medium = date explicit but time/venue inferred; low = date itself inferred or image hard to read."),
});

export const ExtractionResultSchema = z.object({
  events: z.array(ExtractedEventSchema),
  skipped: z
    .array(z.string())
    .describe("Things mentioned in the post that were NOT turned into events (recurring weekly programs without specific dates, past events, vague 'coming soon' teasers), one short line each."),
  notes: z
    .string()
    .nullable()
    .describe("Anything a human reviewer should double-check, or null."),
});

export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

const SYSTEM_PROMPT = `You extract community calendar events from Instagram posts for a small-town events calendar in Beacon, New York (Hudson Valley). You receive the post's caption, its metadata, and the post's image(s). Read the images carefully: flyers and posters often carry the date, time, venue, and price that the caption omits.

Rules:
- Return one event per distinct dated occurrence. A "month of events" post yields many events; a single flyer yields one. Two different events on the same day are two events.
- Only output events that have a determinable calendar date. Weekly/recurring items with no specific date (e.g. "Trivia every Tuesday") go in "skipped", not "events".
- Resolve the year from the post date. Abbreviated dates like "SAT 9/5" or "FRI, 30TH" mean the first such date on or after the post date. Cross-check the weekday when one is given.
- Times are local (America/New_York). "8–11PM" means start 20:00, end 23:00. "10PM" means start 22:00 with no end. A range like "4PM TO MIDNIGHT" ends at 23:59.
- Do not invent details. If a time or venue is not stated in the caption or visible in an image, leave it null (or, for the venue, fall back per the schema description).
- Never invent a URL. Most posts have no real ticket link at all — that is normal, use null. Only fill in "url" by copying text that is literally present; do not construct, guess, or autocomplete one (this includes "helpfully" fabricating a realistic-looking Eventbrite/Ticketspice/bit.ly link — that is worse than leaving it null).
- Ignore likes, comments, hashtags, and calls to follow. Do not include emoji in titles.`;

export interface ExtractOptions {
  /** "Now", used only for logging; the post date drives year inference. */
  now?: Date;
  verbose?: boolean;
  /** Skip image download/vision (caption only). Cheaper but misses flyer-only dates. */
  captionOnly?: boolean;
  client?: OpenAI;
}

/**
 * Sends the post to the model and returns structured events. Throws on API
 * errors or if the model refuses / returns unparseable output.
 */
export async function extractEventsFromPost(
  post: InstagramPost,
  { now = new Date(), verbose = false, captionOnly = false, client }: ExtractOptions = {},
): Promise<ExtractionResult> {
  // The SDK default is a 10-minute timeout with retries on top, which can
  // leave the CLI looking hung with no output for a very long time. Fail
  // faster and let the caller decide whether to retry.
  const openai = client ?? new OpenAI({ timeout: 90_000, maxRetries: 1 });

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

  if (!captionOnly) {
    const images = post.images.slice(0, MAX_IMAGES);
    for (const [i, img] of images.entries()) {
      try {
        // A captured Reel frame already has its bytes in hand; only fetch
        // when we actually just have a CDN URL (a real image post).
        const { data, mediaType } = img.base64 ?? (await downloadImageAsBase64(img.url));
        content.push({ type: "text", text: `Image ${i + 1} of ${images.length}:` });
        content.push({
          type: "image_url",
          image_url: { url: `data:${mediaType};base64,${data}` },
        });
      } catch (err) {
        // A missing image shouldn't sink the whole extraction; the caption and
        // Instagram's alt text (which often includes OCR'd poster text) remain.
        console.warn(`[extractor] Could not download image ${i + 1}: ${(err as Error).message}`);
        content.push({
          type: "text",
          text: `Image ${i + 1} of ${images.length} could not be downloaded. Instagram's alt text for it: ${img.alt || "(none)"}`,
        });
      }
    }
    if (post.images.length > MAX_IMAGES) {
      console.warn(`[extractor] Post has ${post.images.length} images; only the first ${MAX_IMAGES} were sent.`);
    }
  }

  const metadata = [
    `Post URL: ${post.url}`,
    `Account: @${post.author}${post.authorName ? ` (${post.authorName})` : ""}`,
    `Posted on: ${post.postedOn ?? "unknown"}`,
    `Today: ${formatInTimeZone(now, TIME_ZONE, "EEEE, MMMM d, yyyy")}`,
    `Images attached: ${captionOnly ? 0 : Math.min(post.images.length, MAX_IMAGES)}`,
  ].join("\n");

  const altTexts = post.images
    .map((img, i) => (img.alt ? `Image ${i + 1} alt text: ${img.alt}` : null))
    .filter(Boolean)
    .join("\n");

  content.push({
    type: "text",
    text: `${metadata}\n\nCaption:\n"""\n${post.caption}\n"""\n${altTexts ? `\n${altTexts}\n` : ""}\nExtract the events.`,
  });

  if (verbose) {
    console.log(`[extractor] Calling ${MODEL} with ${content.filter((c) => c.type === "image_url").length} image(s)...`);
  }

  let response;
  try {
    response = await openai.chat.completions.parse({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: zodResponseFormat(ExtractionResultSchema, "extraction_result"),
    });
  } catch (err) {
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      throw new Error(
        `OpenAI request timed out after 90s. Check your network connection, or that model "${MODEL}" ` +
          `is correct for your account (set OPENAI_MODEL to override).`,
      );
    }
    throw err;
  }

  const choice = response.choices[0];
  if (choice.message.refusal) {
    throw new Error(`Model declined to process this post: ${choice.message.refusal}`);
  }
  if (choice.finish_reason === "length") {
    throw new Error("Model's response was cut off (max output tokens). The post may be unusually long.");
  }
  if (!choice.message.parsed) {
    throw new Error("Model returned output that did not match the event schema.");
  }

  if (verbose) {
    const u = response.usage;
    console.log(
      `[extractor] ${response.model}: ${choice.message.parsed.events.length} event(s), ` +
        `${choice.message.parsed.skipped.length} skipped; tokens in=${u?.prompt_tokens} out=${u?.completion_tokens}`,
    );
  }

  return choice.message.parsed;
}

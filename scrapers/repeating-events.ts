import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import rrule from "rrule";
const { RRule } = rrule;
import {
  add,
  formatISO,
  startOfDay,
  endOfDay,
  parse as parseDate,
  format as formatDateFn,
} from "date-fns";
import { toDate, formatInTimeZone } from "date-fns-tz";
import { Client, isNotionClientError } from "@notionhq/client"; // Import Notion Client
// Remove specific deep type imports - rely on inference
// import type {
//   QueryDatabaseParameters,
//   PageObjectResponse, // Import PageObjectResponse
//   PartialPageObjectResponse, // Import PartialPageObjectResponse
//   RichTextItemResponse, // Import RichTextItemResponse
// } from "@notionhq/client/build/src/api-endpoints";

import type { Event, Scraper, ScrapeOptions } from "../types.js";
import { EventsArraySchema } from "../utils/validation.js"; // Use this for final validation if needed
import { formatDate } from "../utils/date.js"; // For logging
import { logEventFound } from "../utils/logging.js";
// Import Notion client/query functions when available
// import { queryNotionForExistingIds, getNotionClient } from "../api/notion-helpers.js";

// --- DST HANDLING DOCUMENTATION ---
/**
 * DAYLIGHT SAVING TIME (DST) HANDLING STRATEGY
 *
 * This scraper implements robust timezone handling to prevent events from appearing
 * on the wrong day due to Daylight Saving Time transitions. Here's how it works:
 *
 * 1. STABLE REFERENCE TIMES: All RRule DTSTARTs use noon (12:00) to avoid
 *    edge cases during DST transitions (2 AM spring forward, 2 AM fall back).
 *
 * 2. CONSISTENT TIMEZONE OPERATIONS: All date operations explicitly specify
 *    the target timezone (America/New_York) using date-fns-tz functions.
 *
 * 3. DATE VALIDATION: Each generated event is validated to ensure the final
 *    datetime lands on the expected date, preventing silent date shifts.
 *
 * 4. DST TRANSITION TESTING: The scraper validates all rules against known
 *    DST transition dates to proactively identify potential issues.
 *
 * WHY THIS MATTERS:
 * - During DST transitions, naive date/time operations can shift events by a day
 * - RRule library can return ambiguous dates during transitions
 * - Converting between UTC and local time requires careful timezone handling
 *
 * MAINTENANCE NOTES:
 * - If events still appear on wrong days after DST changes, check the
 *   validateDSTTransitions() function output for specific problem rules
 * - Consider adjusting event times (e.g., avoid 1-3 AM) for problematic rules
 * - Test new rules around March and November DST transition dates
 */

// --- Timezone Utilities for DST-Safe Operations ---

/**
 * Creates a timezone-aware date that is immune to DST transitions
 * by always using noon as the reference time
 */
function createDSTSafeDate(dateStr: string, timezone: string): Date {
  return toDate(`${dateStr}T12:00:00`, { timeZone: timezone });
}

/**
 * Safely converts an event time to the target timezone while preserving the intended date
 * This prevents events from shifting to wrong days during DST transitions
 */
function createEventDateTime(
  dateStr: string,
  timeStr: string,
  timezone: string,
): {
  dateTime: Date;
  actualDateStr: string;
  isValid: boolean;
} {
  const eventDateTime = toDate(`${dateStr}T${timeStr}:00`, {
    timeZone: timezone,
  });
  const actualDateStr = formatInTimeZone(eventDateTime, timezone, "yyyy-MM-dd");

  return {
    dateTime: eventDateTime,
    actualDateStr,
    isValid: actualDateStr === dateStr,
  };
}

/**
 * Enhanced RRule options builder that handles DST transitions properly
 */
function buildDSTSafeRRuleOptions(
  rruleString: string,
  referenceDate: Date,
  timezone: string,
  endDate?: string,
): any {
  const options = RRule.parseString(rruleString);

  // Use a stable midday reference to avoid DST edge cases
  const referenceDateStr = formatInTimeZone(
    referenceDate,
    timezone,
    "yyyy-MM-dd",
  );
  options.dtstart = createDSTSafeDate(referenceDateStr, timezone);
  options.tzid = timezone;

  if (endDate) {
    options.until = toDate(`${endDate}T23:59:59`, { timeZone: timezone });
  }

  return options;
}

/**
 * Test utility to validate event generation around DST transitions
 * This helps identify potential issues before they affect production
 */
function validateDSTTransitions(
  rules: RepeatingEventRule[],
  timezone: string,
): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Common DST transition dates for America/New_York
  const dstTransitionDates = [
    "2024-03-10", // Spring forward 2024
    "2024-11-03", // Fall back 2024
    "2025-03-09", // Spring forward 2025
    "2025-11-02", // Fall back 2025
    "2026-03-08", // Spring forward 2026
    "2026-11-01", // Fall back 2026
  ];

  for (const rule of rules) {
    for (const transitionDate of dstTransitionDates) {
      // Test day before, day of, and day after transition
      const testDates = [
        formatInTimeZone(
          add(toDate(`${transitionDate}T12:00:00`, { timeZone: timezone }), {
            days: -1,
          }),
          timezone,
          "yyyy-MM-dd",
        ),
        transitionDate,
        formatInTimeZone(
          add(toDate(`${transitionDate}T12:00:00`, { timeZone: timezone }), {
            days: 1,
          }),
          timezone,
          "yyyy-MM-dd",
        ),
      ];

      for (const testDate of testDates) {
        const eventResult = createEventDateTime(testDate, rule.time, timezone);
        if (!eventResult.isValid) {
          errors.push(
            `Rule ${rule.ruleId}: Event time ${rule.time} on ${testDate} results in date shift to ${eventResult.actualDateStr}`,
          );
        }
      }
    }
  }

  if (warnings.length > 0 || errors.length > 0) {
    console.log(
      `[${SCRAPER_ID}] DST Validation Results: ${warnings.length} warnings, ${errors.length} errors`,
    );
  }

  return { warnings, errors };
}

// --- Notion Client Setup (reuse or adapt from notion-poster) ---
// Ensure NOTION_API_KEY and NOTION_DATABASE_ID are loaded (e.g., via dotenv)
import dotenv from "dotenv";
dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});
const databaseId = process.env.NOTION_DATABASE_ID;

const SCRAPER_ID = "repeating-events";
const CONFIG_FILE_PATH = path.resolve("repeating-events.json"); // Assumes file is in root
const TIME_ZONE = "America/New_York";
const GENERATION_WEEKS = 8;

// --- Zod Schema for Configuration ---
const DurationSchema = z
  .object({
    hours: z.number().int().min(0).optional(),
    minutes: z.number().int().min(0).optional(),
  })
  .refine((data) => data.hours || data.minutes, {
    message: "Duration must have at least hours or minutes",
  });

const RepeatingEventRuleSchema = z.object({
  ruleId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  location: z.string(),
  url: z.string().url().optional(),
  duration: DurationSchema.optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"), // HH:MM format
  rrule: z.string().min(1), // Basic validation, rrule library handles parsing
  iconEmoji: z.string().optional(), // Optional emoji for Notion icon
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "End date must be in YYYY-MM-DD format")
    .optional(), // Optional end date for events
});

const RepeatingEventsConfigSchema = z.array(RepeatingEventRuleSchema);

type RepeatingEventRule = z.infer<typeof RepeatingEventRuleSchema>;

// --- Helper Functions ---

/**
 * Queries Notion for existing repeating events within a date range
 * whose External ID contains one of the known rule IDs.
 */
async function queryNotionForExistingRepeatingEventIds(
  startDate: Date,
  endDate: Date,
  knownRuleIds: Set<string>,
): Promise<Set<string>> {
  if (!databaseId) {
    throw new Error(
      `[${SCRAPER_ID}] NOTION_DATABASE_ID environment variable is not set`,
    );
  }

  if (knownRuleIds.size === 0) {
    console.log(`[${SCRAPER_ID}] No rule IDs provided, skipping Notion query.`);
    return new Set<string>();
  }

  const existingIds = new Set<string>();
  let hasMore = true;
  let startCursor: string | undefined = undefined;

  // Format dates for Notion query (YYYY-MM-DD)
  const startDateStr = formatDateFn(startDate, "yyyy-MM-dd");
  const endDateStr = formatDateFn(endDate, "yyyy-MM-dd");

  // Construct the 'or' filter part for rule IDs
  const ruleIdFilters = Array.from(knownRuleIds).map((ruleId) => ({
    property: "External ID", // Replace with your actual property name if different
    rich_text: {
      contains: ruleId,
    },
  }));

  // Check if batching is needed (Notion limits OR filters, ~100 clauses typical max)
  // For now, we assume the number of rules is less than the limit.
  if (ruleIdFilters.length > 90) {
    // Conservative limit
    console.warn(
      `[${SCRAPER_ID}] Warning: Approaching Notion OR filter limit with ${ruleIdFilters.length} rules. Query might fail or need batching in the future.`,
    );
  }

  console.log(
    `[${SCRAPER_ID}] Querying Notion for events between ${startDateStr} and ${endDateStr} matching ${knownRuleIds.size} ruleId prefixes...`,
  );

  try {
    while (hasMore) {
      // Define query config inline, letting TS infer types where possible
      const queryConfig = {
        database_id: databaseId,
        filter: {
          and: [
            {
              property: "Date", // Replace with your actual property name
              date: {
                on_or_after: startDateStr,
              },
            },
            {
              property: "Date", // Replace with your actual property name
              date: {
                on_or_before: endDateStr,
              },
            },
            {
              or: ruleIdFilters,
            },
          ],
        },
        page_size: 100, // Max page size
        ...(startCursor && { start_cursor: startCursor }),
      };

      // console.log("[${SCRAPER_ID}] Notion Query Filter:", JSON.stringify(queryConfig.filter, null, 2)); // DEBUG

      // Let TS infer the response type
      const response = await notion.databases.query(queryConfig);

      for (const page of response.results) {
        // Check if it's a full page object with properties
        if (!("properties" in page)) continue;

        const externalIdProperty = page.properties["External ID"]; // Replace name if needed

        // Type guard for rich_text property
        if (
          externalIdProperty &&
          externalIdProperty.type === "rich_text" &&
          Array.isArray(externalIdProperty.rich_text) &&
          externalIdProperty.rich_text.length > 0
        ) {
          const richTextItem = externalIdProperty.rich_text[0];
          // Check if the item has plain_text
          if (richTextItem && "plain_text" in richTextItem) {
            const externalId = richTextItem.plain_text;
            if (externalId) {
              // Check if plain_text is not empty
              existingIds.add(externalId);
            }
          }
        }
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor ?? undefined;

      if (hasMore) {
        console.log(`[${SCRAPER_ID}] Fetching next page of Notion results...`);
        await new Promise((resolve) => setTimeout(resolve, 350)); // Rate limit compliance
      }
    }

    console.log(
      `[${SCRAPER_ID}] Found ${existingIds.size} existing event IDs in Notion matching criteria.`,
    );
    return existingIds;
  } catch (error) {
    if (isNotionClientError(error)) {
      console.error(
        `[${SCRAPER_ID}] Notion API Error querying existing events: ${error.code} - ${error.message}`,
        // Removed error.body logging
      );
    } else {
      console.error(
        `[${SCRAPER_ID}] Error querying Notion for existing events:`,
        error,
      );
    }
    // Decide on behavior: throw or return empty set?
    // Returning empty set might lead to duplicate creation, throwing stops the process.
    throw new Error("Failed to query Notion for existing events.");
  }
}

// --- Main Scraper Function ---
const scrapeRepeatingEvents = async (
  options: ScrapeOptions,
): Promise<Event[]> => {
  console.log(`[${SCRAPER_ID}] Starting generation...`);

  // 0. Check Notion Env Vars
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    console.error(
      `[${SCRAPER_ID}] Error: NOTION_API_KEY or NOTION_DATABASE_ID missing from environment.`,
    );
    // Optionally, load dotenv here if not loaded globally
    // dotenv.config();
    // if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    //    throw new Error("Notion environment variables are required.");
    // }
    throw new Error("Notion environment variables are required.");
  }

  // 1. Define Timezone & Calculation Window
  const now = new Date();
  const generationStartDate = startOfDay(toDate(now, { timeZone: TIME_ZONE }));
  const generationEndDate = endOfDay(
    add(generationStartDate, { weeks: GENERATION_WEEKS }),
  );

  console.log(
    `[${SCRAPER_ID}] Generating events from ${formatDate(
      generationStartDate,
    )} to ${formatDate(generationEndDate)} (inclusive)`,
  );

  try {
    // 2. Read and Validate Configuration File
    console.log(`[${SCRAPER_ID}] Reading config file: ${CONFIG_FILE_PATH}`);
    const configFileContent = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
    const rawConfig = JSON.parse(configFileContent);

    console.log(`[${SCRAPER_ID}] Validating configuration...`);
    const validationResult = RepeatingEventsConfigSchema.safeParse(rawConfig);

    if (!validationResult.success) {
      console.error(
        `[${SCRAPER_ID}] Configuration validation failed:`,
        validationResult.error.flatten(),
      );
      throw new Error("Invalid repeating-events.json configuration.");
    }

    const rules: RepeatingEventRule[] = validationResult.data;
    console.log(`[${SCRAPER_ID}] Validated ${rules.length} rules.`);

    // 2.5. DST Validation (helps identify potential timezone issues)
    console.log(`[${SCRAPER_ID}] Running DST transition validation...`);
    const dstValidation = validateDSTTransitions(rules, TIME_ZONE);
    if (dstValidation.errors.length > 0) {
      console.error(
        `[${SCRAPER_ID}] DST validation found ${dstValidation.errors.length} critical timezone issues:`,
      );
      dstValidation.errors.forEach((error) => console.error(`  - ${error}`));
      console.error(
        `[${SCRAPER_ID}] These issues may cause events to appear on wrong dates. Consider adjusting event times or RRULE configurations.`,
      );
    }
    if (dstValidation.warnings.length > 0) {
      console.warn(
        `[${SCRAPER_ID}] DST validation warnings (${dstValidation.warnings.length}):`,
      );
      dstValidation.warnings.forEach((warning) =>
        console.warn(`  - ${warning}`),
      );
    }
    if (
      dstValidation.errors.length === 0 &&
      dstValidation.warnings.length === 0
    ) {
      console.log(
        `[${SCRAPER_ID}] DST validation passed - no timezone issues detected.`,
      );
    }

    const knownRuleIds = new Set(rules.map((r) => r.ruleId));

    // 3. Query Notion for Existing Events
    const existingExternalIds = await queryNotionForExistingRepeatingEventIds(
      generationStartDate,
      generationEndDate,
      knownRuleIds,
    );
    // console.log(`[${SCRAPER_ID}] Found ${existingExternalIds.size} potentially relevant existing events in Notion.`); // Logging moved inside query func

    // 4. Generate Event Occurrences
    const generatedEvents: Event[] = [];

    for (const rule of rules) {
      if (options.verbose) {
        console.log(`[${SCRAPER_ID}] Processing rule: ${rule.ruleId}`);
      }
      let rruleSet: InstanceType<typeof RRule>;
      let effectiveEndDate = generationEndDate;

      // If rule has an endDate, use it to limit generation
      if (rule.endDate) {
        const ruleEndDate = toDate(`${rule.endDate}T23:59:59`, {
          timeZone: TIME_ZONE,
        });
        effectiveEndDate =
          ruleEndDate < generationEndDate ? ruleEndDate : generationEndDate;
      }

      try {
        // Use the enhanced DST-safe RRule builder
        const rruleOptions = buildDSTSafeRRuleOptions(
          rule.rrule,
          generationStartDate,
          TIME_ZONE,
          rule.endDate,
        );

        rruleSet = new RRule(rruleOptions);
      } catch (e) {
        console.error(
          `[${SCRAPER_ID}] Error parsing RRULE "${rule.rrule}" for ruleId "${rule.ruleId}":`,
          e,
        );
        continue; // Skip this rule if RRULE is invalid
      }

      const occurrences = rruleSet.between(
        generationStartDate,
        effectiveEndDate,
        true, // inc = inclusive
      );

      const endDateInfo = rule.endDate ? ` (ends ${rule.endDate})` : "";
      console.log(
        `[${SCRAPER_ID}]   Rule ${rule.ruleId}: Found ${occurrences.length} occurrences in window${endDateInfo}.`,
      );

      for (const occurrenceDate of occurrences) {
        // Get the intended occurrence date in target timezone
        const occurrenceDateStr = formatInTimeZone(
          occurrenceDate,
          TIME_ZONE,
          "yyyy-MM-dd",
        );

        // Use the DST-safe event datetime creator
        const eventResult = createEventDateTime(
          occurrenceDateStr,
          rule.time,
          TIME_ZONE,
        );

        // Validate that the event landed on the correct date
        if (!eventResult.isValid) {
          console.warn(
            `[${SCRAPER_ID}]   WARNING: DST-related date shift detected for ${rule.ruleId}! ` +
              `Expected ${occurrenceDateStr} but event landed on ${eventResult.actualDateStr}. ` +
              `This may indicate a timezone handling issue. Skipping this occurrence.`,
          );
          continue;
        }

        const start_at = formatISO(eventResult.dateTime);
        const external_id = `${rule.ruleId}-${eventResult.actualDateStr}`;

        // Check if already exists
        if (existingExternalIds.has(external_id)) {
          console.log(
            `[${SCRAPER_ID}]   Skipping existing event: ${external_id}`,
          );
          continue;
        }

        // Calculate end_at if duration is provided
        let end_at: string | undefined = undefined;
        if (rule.duration) {
          const endAtDateTime = add(eventResult.dateTime, rule.duration);
          end_at = formatISO(endAtDateTime);
        }

        const event: Event = {
          title: rule.title,
          description: rule.description ?? "",
          location: rule.location,
          start_at: start_at,
          url: rule.url ?? undefined,
          external_id: external_id,
          ...(end_at && { end_at: end_at }), // Conditionally add end_at
          ...(rule.iconEmoji && {
            icon: { type: "emoji", emoji: rule.iconEmoji },
          }), // Conditionally add emoji icon
        };

        // console.log(`[Repeating Events DEBUG] Generated event object for ${external_id}:`, JSON.stringify(event, null, 2)); // REMOVE LOG

        generatedEvents.push(event);
        logEventFound(SCRAPER_ID, event);
      }
    }

    console.log(
      `[${SCRAPER_ID}] Generated ${generatedEvents.length} new event instances.`,
    );

    // 5. Final Validation (Optional but recommended)
    try {
      const finalValidation = EventsArraySchema.parse(generatedEvents);
      console.log(
        `[${SCRAPER_ID}] Final event structure validation successful.`,
      );
      return finalValidation as Event[];
    } catch (validationError) {
      console.error(
        `[${SCRAPER_ID}] Zod validation failed for final generated event list:`,
        validationError,
      );
      throw new Error(`[${SCRAPER_ID}] Final event validation failed.`);
    }
  } catch (error) {
    console.error(
      `[${SCRAPER_ID}] An error occurred during generation:`,
      error,
    );
    return []; // Return empty array on error
  }
};

// Export the scraper object
export const scraper: Scraper = {
  id: SCRAPER_ID,
  name: "Repeating Events Generator",
  scrape: scrapeRepeatingEvents,
};

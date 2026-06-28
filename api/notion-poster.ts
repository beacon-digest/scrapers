// Before running, install the required dependencies:
// pnpm add @notionhq/client dotenv @tryfabric/martian date-fns-tz
//
// Create a .env file in the project root with:
// NOTION_API_KEY=your_api_key
// NOTION_DATABASE_ID=your_database_id
//
// Or copy the .env.example file and fill in your values:
// cp .env.example .env
import { Client, APIErrorCode, isNotionClientError } from "@notionhq/client";
import type {
  BlockObjectRequest,
  CreatePageParameters,
} from "@notionhq/client/build/src/api-endpoints";
import type { Event, NotionIcon, PostResult } from "../types.js";
import dotenv from "dotenv";
import { markdownToBlocks } from "@tryfabric/martian";
import { formatInTimeZone } from "date-fns-tz";

// Load environment variables from .env file
dotenv.config();

// Eastern Time Zone identifier
const TIME_ZONE = "America/New_York";

// Initialize Notion client
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const databaseId = process.env.NOTION_DATABASE_ID;

/**
 * Retrieves and logs the schema of the Notion database (for debugging purposes)
 */
export async function getDatabaseSchema() {
  if (!databaseId) {
    throw new Error("NOTION_DATABASE_ID environment variable is not set");
  }

  try {
    const response = await notion.databases.retrieve({
      database_id: databaseId,
    });

    console.log("Database properties:");
    console.log(JSON.stringify(response.properties, null, 2));

    return response.properties;
  } catch (error) {
    console.error("Error retrieving database schema:", error);
    throw error;
  }
}

/**
 * Retrieves events from Notion that have external IDs matching the provided list
 * @param externalIds List of external IDs to check
 * @returns Set of external IDs that already exist in Notion
 */
async function getExistingExternalIds(
  externalIds: string[]
): Promise<Set<string>> {
  if (!databaseId) {
    throw new Error("NOTION_DATABASE_ID environment variable is not set");
  }

  // If no external IDs provided, return empty set
  if (externalIds.length === 0) {
    return new Set<string>();
  }

  const existingIds = new Set<string>();
  let hasMore = true;
  let startCursor: string | undefined = undefined;

  try {
    console.log(
      `Checking for ${externalIds.length} events that may already exist in Notion...`
    );

    // Notion API has limits on filter complexity, so we need to handle this in batches
    // We'll process in batches of 10 external IDs at a time (adjust as needed)
    const batchSize = 10;

    for (let i = 0; i < externalIds.length; i += batchSize) {
      const batchIds = externalIds.slice(i, i + batchSize);

      // Paginate through all results for this batch of IDs
      hasMore = true;
      startCursor = undefined;

      while (hasMore) {
        // Create an OR filter for this batch of external IDs
        const filter = {
          or: batchIds.map((id) => ({
            property: "External ID",
            rich_text: {
              equals: id,
            },
          })),
        };

        // Query the database for pages with matching external IDs
        const response = await notion.databases.query({
          database_id: databaseId,
          filter: filter,
          page_size: 100,
          start_cursor: startCursor,
        });

        // Extract external IDs from the results
        for (const page of response.results) {
          // Check if it's a page object (which has properties)
          if ("properties" in page) {
            const externalIdProperty = page.properties["External ID"];

            if (
              externalIdProperty.type === "rich_text" &&
              externalIdProperty.rich_text.length > 0
            ) {
              const externalId = externalIdProperty.rich_text[0].plain_text;
              if (externalId) {
                existingIds.add(externalId);
              }
            }
          }
        }

        // Check if there are more results
        hasMore = response.has_more;
        startCursor = response.next_cursor || undefined;
      }
    }

    console.log(
      `Found ${existingIds.size} events that already exist in Notion`
    );
    return existingIds;
  } catch (error) {
    console.error("Error checking for existing events:", error);
    // In case of error, return an empty set
    return new Set<string>();
  }
}

// Define helper here so it's accessible
const formatWithTimeZone = (
  isoString: string | undefined
): string | undefined => {
  if (!isoString) return undefined;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    console.warn(
      `[Notion Poster] Invalid date string encountered: ${isoString}`
    );
    return undefined;
  }
  return formatInTimeZone(date, TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
};

/**
 * Rewrites links/images in a Markdown string so Notion accepts them.
 *
 * Notion's API rejects link targets that aren't absolute URLs with
 * "Invalid URL for link". This operates purely on the Markdown text
 * (Markdown in → Markdown out) so the result still feeds cleanly into
 * `markdownToBlocks`:
 *   - site-relative ("/path")      -> prepend `baseUrl`
 *   - protocol-relative ("//host") -> prepend "https:"
 *   - already absolute / mailto / tel -> left as-is
 *   - anything else (anchors, bare text, ftp, relative files, or
 *     site-relative when no baseUrl is known) -> link dropped, keeping
 *     the visible text; broken images are removed entirely.
 */
function sanitizeMarkdownLinks(markdown: string, baseUrl: string): string {
  if (!markdown) return "";
  // Matches Markdown links `[text](href "title")` and images `![alt](href "title")`.
  const linkRegex = /(!?)\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g;
  return markdown.replace(linkRegex, (_full, bang, text, href, title) => {
    let newHref: string | null;
    if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) {
      newHref = href; // already absolute and supported
    } else if (href.startsWith("//")) {
      newHref = `https:${href}`; // protocol-relative
    } else if (href.startsWith("/")) {
      newHref = baseUrl ? `${baseUrl}${href}` : null; // site-relative
    } else {
      newHref = null; // anchors, bare text, relative files, ftp, etc.
    }

    if (newHref === null) {
      console.warn(
        `[Link Sanitize] Dropping unsupported ${
          bang ? "image" : "link"
        }: ${href}`
      );
      return bang ? "" : text;
    }
    if (newHref !== href) {
      console.log(`[Link Sanitize] Rewrote ${href} -> ${newHref}`);
    }
    return `${bang}[${text}](${newHref}${title})`;
  });
}

/**
 * Posts multiple events to a Notion database.
 * @param events Array of events to post to Notion
 * @returns PostResult with counts of created, skipped, failed events and error details
 */
export async function postEventsToNotion(events: Event[]): Promise<PostResult> {
  if (!databaseId) {
    throw new Error("NOTION_DATABASE_ID environment variable is not set");
  }

  // Extract all external IDs from the events we're about to post
  const eventExternalIds = events.map((event) => event.external_id);

  // Check which external IDs already exist in the database
  const existingIds = await getExistingExternalIds(eventExternalIds);

  // Retrieve the database to get available location options
  let locationOptions: { id: string; name: string }[] = [];
  try {
    const dbSchema = await notion.databases.retrieve({
      database_id: databaseId,
    });

    // Extract location options from the schema
    if (dbSchema.properties.Location?.type === "select") {
      locationOptions = dbSchema.properties.Location.select.options || [];
      console.log(
        `Found ${locationOptions.length} location options in the database`
      );
    }
  } catch (error) {
    console.warn(
      "Could not retrieve database schema for location matching:",
      error
    );
  }

  const results: string[] = [];
  const errors: { eventTitle: string; error: Error }[] = [];
  const skipped: string[] = [];

  for (const event of events) {
    try {
      // Check if exists
      if (existingIds.has(event.external_id)) {
        console.log(
          `Skipping event "${event.title}" - already exists with external ID: ${event.external_id}`
        );
        skipped.push(event.external_id);
        continue;
      }

      // --- Log event.icon directly ---
      // console.log(`[Notion Poster DEBUG] Processing event ${event.external_id}, event.icon:`, JSON.stringify(event.icon, null, 2)); // REMOVE LOG

      // --- Location Matching ---
      let locationName = event.location;
      if (locationOptions.length > 0) {
        const matchingLocation = locationOptions.find(
          (option) =>
            option.name.toLowerCase().includes(locationName.toLowerCase()) ||
            locationName
              .toLowerCase()
              .includes(option.name.toLowerCase().split(" (")[0])
        );

        if (matchingLocation) {
          console.log(
            `Matched location "${event.location}" to "${matchingLocation.name}"`
          );
          locationName = matchingLocation.name;
        } else {
          console.warn(`No matching location found for "${event.location}"`);
        }
      }

      // --- Sanitize Description Links ---
      // Notion rejects non-absolute link targets ("Invalid URL for link").
      // Derive the base URL from the event's own URL so relative links in the
      // description (e.g. "/young-storytellers-guild") become absolute.
      let baseUrlForLinks = "";
      if (event.url) {
        try {
          baseUrlForLinks = new URL(event.url).origin;
        } catch {
          /* leave baseUrlForLinks empty if event.url isn't a valid URL */
        }
      }
      const descriptionForBlocks = sanitizeMarkdownLinks(
        event.description,
        baseUrlForLinks
      );

      // --- Remove DEBUG Logs ---
      /*
      console.log(`[Notion Poster DEBUG] Markdown input for ${event.title} (length ${sanitizedDescription?.length}):\n${sanitizedDescription?.substring(0, 300)}...`);
      */
      // --- END Remove DEBUG ---

      // --- Common Data Prep ---
      const descriptionBlocks = markdownToBlocks(descriptionForBlocks);

      // --- Remove DEBUG Logs ---
      /*
      console.log(`[Notion Poster DEBUG] Resulting blocks for ${event.title}:`, JSON.stringify(descriptionBlocks?.slice(0, 3), null, 2)); // Log first 3 blocks
      console.log(`[Notion Poster DEBUG] Total blocks generated: ${descriptionBlocks?.length}`);
      */
      // --- END Remove DEBUG ---

      const startDateWithTz = formatWithTimeZone(event.start_at);
      const endDateWithTz = event.end_at
        ? formatWithTimeZone(event.end_at)
        : undefined;

      if (!startDateWithTz) {
        throw new Error(
          `Failed to format start date timezone for ${event.title}`
        );
      }

      // --- Construct Properties ---
      const properties: CreatePageParameters["properties"] = {
        Name: { title: [{ text: { content: event.title } }] },
        Date: { date: { start: startDateWithTz, end: endDateWithTz } },
        Location: { select: { name: locationName } },
        "External ID": {
          rich_text: [{ text: { content: event.external_id } }],
        },
        // Conditionally add Website only if event.url is present
        ...(event.url && { Website: { url: event.url } }),
      };

      // --- Post to Notion ---
      console.log(
        `Posting event "${event.title}" (URL: ${event.url || "(none)"})`
      );
      console.log(
        `  Timezone: Start=${startDateWithTz}, End=${endDateWithTz || "N/A"}`
      );

      const createPageArgs: CreatePageParameters = {
        parent: { database_id: databaseId },
        properties: properties,
        children: descriptionBlocks as BlockObjectRequest[],
        ...(event.icon && { icon: event.icon as CreatePageParameters["icon"] }),
      };

      // console.log(`[Notion Poster DEBUG] Payload for "${event.title}":`, JSON.stringify(createPageArgs, null, 2)); // REMOVE LOG

      const response = await notion.pages.create(createPageArgs);

      existingIds.add(event.external_id);
      console.log(`Successfully added event "${event.title}" to Notion`);
      results.push(response.id);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      // --- Simple Error Handling ---
      console.error(`Posting failed for "${event.title}":`, error);
      errors.push({ eventTitle: event.title, error: error as Error });
      // --- End Error Handling ---
    }
  } // End for loop

  // --- Final Logging ---
  if (errors.length > 0) {
    console.warn(`${errors.length} events failed to post to Notion:`);
    for (const e of errors) {
      console.warn(`  - ${e.eventTitle}: ${e.error.message}`);
    }
  }
  if (skipped.length > 0) {
    console.log(
      `Skipped ${skipped.length} events that already exist in Notion`
    );
  }
  console.log(
    `Successfully posted ${results.length} of ${events.length} events to Notion (${skipped.length} skipped, ${errors.length} failed)`
  );
  
  return {
    created: results.length,
    skipped: skipped.length,
    failed: errors.length,
    errors: errors.map((e) => ({
      eventTitle: e.eventTitle,
      message: e.error.message,
    })),
  };
}

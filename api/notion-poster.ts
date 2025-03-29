// Before running, install the required dependencies:
// pnpm add @notionhq/client dotenv @tryfabric/martian
//
// Create a .env file in the project root with:
// NOTION_API_KEY=your_api_key
// NOTION_DATABASE_ID=your_database_id
//
// Or copy the .env.example file and fill in your values:
// cp .env.example .env
import { Client } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints";
import type { Event } from "../types.js";
import dotenv from "dotenv";
import { markdownToBlocks } from "@tryfabric/martian";

// Load environment variables from .env file
dotenv.config();

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
 * Posts multiple events to a Notion database
 * @param events Array of events to post to Notion
 * @returns Array of created page IDs
 */
export async function postEventsToNotion(events: Event[]): Promise<string[]> {
  if (!databaseId) {
    throw new Error("NOTION_DATABASE_ID environment variable is not set");
  }

  // First, retrieve the database to get available location options
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
  const errors: Error[] = [];

  // Process events sequentially to avoid rate limits
  for (const event of events) {
    try {
      // Find best matching location from available options
      let locationName = event.location;

      if (locationOptions.length > 0) {
        // Try to find a partial match
        const matchingLocation = locationOptions.find(
          (option) =>
            option.name.toLowerCase().includes(event.location.toLowerCase()) ||
            event.location
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

      // Convert markdown description to Notion blocks
      const descriptionBlocks = markdownToBlocks(event.description);

      // Create the page with properties
      console.log(
        `Posting event with start time: ${event.start_at} and end time: ${event.end_at}`
      );

      const response = await notion.pages.create({
        parent: {
          database_id: databaseId,
        },
        properties: {
          // Match property names to database schema
          Name: {
            title: [
              {
                text: {
                  content: event.title,
                },
              },
            ],
          },
          Date: {
            date: {
              start: event.start_at.includes("Z")
                ? event.start_at
                : `${event.start_at}Z`,
              end: event.end_at
                ? event.end_at.includes("Z")
                  ? event.end_at
                  : `${event.end_at}Z`
                : undefined,
            },
          },
          Website: {
            url: event.url,
          },
          Location: {
            select: {
              name: locationName,
            },
          },
          "External ID": {
            rich_text: [
              {
                text: {
                  content: event.external_id,
                },
              },
            ],
          },
          // We don't have tags in our Event type, so we're not setting Tags property
        },
        // Add the description as blocks in the page content
        children: descriptionBlocks as BlockObjectRequest[],
      });

      console.log(`Successfully added event "${event.title}" to Notion`);
      results.push(response.id);

      // Add a small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`Error adding event "${event.title}" to Notion:`, error);
      errors.push(error as Error);
    }
  }

  if (errors.length > 0) {
    console.warn(`${errors.length} events failed to post to Notion`);
  }

  console.log(
    `Successfully posted ${results.length} of ${events.length} events to Notion`
  );
  return results;
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Checking for environment variables...");

  // Check if environment variables are set
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    console.error("Required environment variables are not set!");
    console.error(
      "Make sure you have a .env file with the following variables:"
    );
    console.error("  NOTION_API_KEY=your_notion_api_key");
    console.error("  NOTION_DATABASE_ID=your_notion_database_id");
    console.error(
      "Or create a .env file by copying .env.example and filling in your values."
    );
    process.exit(1);
  }

  console.log("Environment variables found, retrieving database schema...");

  // Only run database schema retrieval
  getDatabaseSchema()
    .then((properties) => {
      console.log("Database schema retrieved successfully!");
      console.log(`Database has ${Object.keys(properties).length} properties:`);

      // Print a simplified list of property names and types
      for (const [name, property] of Object.entries(properties)) {
        console.log(`- ${name} (${property.type || "unknown"})`);
      }
    })
    .catch((error) => {
      console.error("Failed to retrieve database schema:", error);
      process.exit(1);
    });
}

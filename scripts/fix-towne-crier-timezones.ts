import { Client } from "@notionhq/client";
import dotenv from "dotenv";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { readFileSync } from "node:fs";

// Corrects the historic host-timezone parsing bug for existing Towne Crier
// records. It only updates a captured set of records whose corrected local
// date is after the supplied cutoff date.
dotenv.config();

const TIME_ZONE = "America/New_York";
const PREFIXES = ["towne-crier-main-", "towne-crier-salon-"];
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const cutoffArg = process.argv.find((arg) => arg.startsWith("--after="));
const planArg = process.argv.find((arg) => arg.startsWith("--plan="));
const cutoff = cutoffArg?.slice("--after=".length);

if (!cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
  throw new Error("Usage: tsx scripts/fix-towne-crier-timezones.ts --after=YYYY-MM-DD [--plan=PATH] [--apply]");
}
const cutoffDate = cutoff;

const databaseId = process.env.NOTION_DATABASE_ID;
const apiKey = process.env.NOTION_API_KEY;
if (!databaseId || !apiKey) {
  throw new Error("NOTION_API_KEY and NOTION_DATABASE_ID must be available in the environment.");
}
const notionDatabaseId = databaseId;
const notion = new Client({ auth: apiKey });

type PageLike = {
  id: string;
  properties: Record<string, any>;
};

type PlannedUpdate = {
  pageId: string;
  title: string;
  externalId: string;
  currentStart: string;
  correctedStart: string;
  correctedLocalDate: string;
  existingEnd: string | null;
};

function sameInstant(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return left === right;
  return new Date(left).getTime() === new Date(right).getTime();
}

function richText(property: any): string | undefined {
  return property?.type === "rich_text" ? property.rich_text?.[0]?.plain_text : undefined;
}

function title(property: any): string {
  return property?.type === "title" ? property.title?.[0]?.plain_text ?? "(untitled)" : "(untitled)";
}

function correctedStartFromHistoricBug(start: string): Date {
  const historicInstant = new Date(start);
  if (Number.isNaN(historicInstant.getTime())) {
    throw new Error(`Invalid existing Notion date: ${start}`);
  }
  // The old scraper stored Towne Crier's wall-clock fields as if they were UTC.
  // Recover those UTC fields as a wall time, then interpret that wall time in NY.
  const historicWallTime = formatInTimeZone(historicInstant, "UTC", "yyyy-MM-dd'T'HH:mm:ss");
  return fromZonedTime(historicWallTime, TIME_ZONE);
}

async function queryCandidates(): Promise<PageLike[]> {
  const pages: PageLike[] = [];
  let cursor: string | undefined;
  do {
    const response: any = await notion.databases.query({
      database_id: notionDatabaseId,
      filter: {
        or: PREFIXES.map((prefix) => ({
          property: "External ID",
          rich_text: { starts_with: prefix },
        })),
      },
      page_size: 100,
      start_cursor: cursor,
    });
    pages.push(...response.results.filter((result: any) => "properties" in result) as PageLike[]);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return pages;
}

async function main() {
  let candidates: PageLike[] = [];
  let planned: PlannedUpdate[] = [];
  let skipped: { pageId: string; reason: string }[] = [];

  if (planArg) {
    const planPath = planArg.slice("--plan=".length);
    const savedPlan = JSON.parse(readFileSync(planPath, "utf8"));
    if (savedPlan.cutoff !== cutoffDate || !Array.isArray(savedPlan.planned)) {
      throw new Error("Saved plan has an unexpected cutoff or no planned records.");
    }
    planned = savedPlan.planned;
    skipped = savedPlan.skipped ?? [];
  } else {
    candidates = await queryCandidates();
    for (const page of candidates) {
      const date = page.properties.Date;
      const externalId = richText(page.properties["External ID"]);
      if (!date?.date?.start || !externalId) {
        skipped.push({ pageId: page.id, reason: "missing Date.start or External ID" });
        continue;
      }

      const corrected = correctedStartFromHistoricBug(date.date.start);
      const correctedLocalDate = formatInTimeZone(corrected, TIME_ZONE, "yyyy-MM-dd");
      if (correctedLocalDate <= cutoffDate) {
        skipped.push({ pageId: page.id, reason: `corrected local date ${correctedLocalDate} is not after ${cutoffDate}` });
        continue;
      }

      planned.push({
        pageId: page.id,
        title: title(page.properties.Name),
        externalId,
        currentStart: date.date.start,
        correctedStart: formatInTimeZone(corrected, TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
        correctedLocalDate,
        existingEnd: date.date.end ?? null,
      });
    }
  }

  const report = {
    mode: apply ? "apply" : "dry-run",
    cutoff: cutoffDate,
    queried: planArg ? undefined : candidates.length,
    plannedCount: planned.length,
    skippedCount: skipped.length,
    planned,
    skipped,
    updated: [] as string[],
    alreadyCorrect: [] as string[],
  };

  if (apply) {
    for (const item of planned) {
      const before: any = await notion.pages.retrieve({ page_id: item.pageId });
      const currentStart = before.properties?.Date?.date?.start;
      if (sameInstant(currentStart, item.correctedStart)) {
        report.alreadyCorrect.push(item.pageId);
        continue;
      }
      if (!sameInstant(currentStart, item.currentStart)) {
        throw new Error(`Conflict for ${item.pageId}: expected ${item.currentStart}, got ${currentStart ?? "none"}`);
      }

      await notion.pages.update({
        page_id: item.pageId,
        properties: {
          Date: { date: { start: item.correctedStart, end: item.existingEnd } },
        },
      });
      const verified: any = await notion.pages.retrieve({ page_id: item.pageId });
      const actual = verified.properties?.Date?.date?.start;
      if (!sameInstant(actual, item.correctedStart)) {
        throw new Error(`Verification failed for ${item.pageId}: expected ${item.correctedStart}, got ${actual ?? "none"}`);
      }
      report.updated.push(item.pageId);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

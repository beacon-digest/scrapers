#!/usr/bin/env node
/** Apply an exact dry-run plan from format-unprocessed-events.mjs. */
import { readFileSync } from "node:fs";
import { loadDotEnv } from "./audit-notion-duplicates.mjs";

function parseArgs(argv) {
  const args = { planPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--plan") args.planPath = argv[++i];
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/apply-event-formatter-plan.mjs --plan PATH");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.planPath) throw new Error("--plan is required");
  return args;
}

function plainText(items = []) {
  return items.map((item) => item.plain_text || item.text?.content || "").join("");
}

function pageState(page) {
  const p = page.properties || {};
  return {
    title: plainText(p.Name?.title),
    icon: page.icon?.type === "emoji" ? page.icon.emoji : null,
    processed: p.Processed?.checkbox === true,
    published: p.Published?.checkbox === true,
    hidden: p.Hidden?.checkbox === true,
  };
}

async function notion(path, method = "GET", body = undefined) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Notion ${method} ${path} failed: HTTP ${response.status}`);
  return response.json();
}

async function page(pageId) {
  return notion(`/pages/${pageId}`);
}

async function blocks(pageId) {
  const results = [];
  let cursor = null;
  do {
    const response = await notion(`/blocks/${pageId}/children${cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : ""}`);
    results.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return new Map(results.map((block) => [block.id, { type: block.type, text: plainText(block[block.type]?.rich_text) }]));
}

async function main() {
  loadDotEnv();
  if (!process.env.NOTION_API_KEY) throw new Error("NOTION_API_KEY is not configured");
  const { planPath } = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  if (plan.mode !== "dry-run" || !Array.isArray(plan.events)) throw new Error("Plan must be formatter dry-run JSON");

  const apply = plan.events.filter((event) => !event.duplicate_of);
  const held = plan.events.filter((event) => event.duplicate_of);

  // Validate every intended mutation before any write occurs.
  for (const event of apply) {
    const current = pageState(await page(event.id));
    if (current.title !== event.before.title || current.icon !== event.before.icon || current.processed || current.published || current.hidden) {
      throw new Error(`Preflight conflict for ${event.id}`);
    }
    const currentBlocks = await blocks(event.id);
    for (const change of event.description_changes || []) {
      if (currentBlocks.get(change.id)?.text !== change.before) throw new Error(`Preflight block conflict for ${event.id}/${change.id}`);
    }
  }
  for (const event of held) {
    const current = pageState(await page(event.id));
    if (current.processed) throw new Error(`Held duplicate is unexpectedly processed: ${event.id}`);
  }

  const applied = [];
  for (const event of apply) {
    await notion(`/pages/${event.id}`, "PATCH", {
      icon: { type: "emoji", emoji: event.after.icon },
      properties: { Name: { title: [{ type: "text", text: { content: event.after.title } }] } },
    });
    let current = pageState(await page(event.id));
    if (current.title !== event.after.title || current.icon !== event.after.icon || current.processed) throw new Error(`Content read-back failed for ${event.id}`);

    const currentBlocks = await blocks(event.id);
    for (const change of event.description_changes || []) {
      const block = currentBlocks.get(change.id);
      if (!block) throw new Error(`Missing block ${event.id}/${change.id}`);
      await notion(`/blocks/${change.id}`, "PATCH", { [block.type]: { rich_text: [{ type: "text", text: { content: change.after } }] } });
    }
    const updatedBlocks = await blocks(event.id);
    for (const change of event.description_changes || []) {
      if (updatedBlocks.get(change.id)?.text !== change.after) throw new Error(`Block read-back failed for ${event.id}/${change.id}`);
    }

    await notion(`/pages/${event.id}`, "PATCH", { properties: { Processed: { checkbox: true } } });
    current = pageState(await page(event.id));
    if (current.title !== event.after.title || current.icon !== event.after.icon || !current.processed) throw new Error(`Final read-back failed for ${event.id}`);
    applied.push({ id: event.id, title: current.title, icon: current.icon, description_edits: (event.description_changes || []).length });
  }

  const heldReadback = [];
  for (const event of held) {
    const current = pageState(await page(event.id));
    if (current.title !== event.before.title || current.icon !== event.before.icon || current.processed) throw new Error(`Held duplicate read-back failed for ${event.id}`);
    heldReadback.push({ id: event.id, title: current.title, duplicate_of: event.duplicate_of });
  }

  process.stdout.write(`${JSON.stringify({ applied_count: applied.length, description_edits: applied.reduce((sum, event) => sum + event.description_edits, 0), applied, held_duplicates: heldReadback }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`event-formatter apply error: ${error.message}`);
  process.exit(1);
});

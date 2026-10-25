#!/usr/bin/env node
/**
 * Review and optionally normalize unpublished Beacon Digest events.
 *
 * Default mode is dry-run. It reads only events where Published=false,
 * Hidden=false, Processed=false, and Date is today or later in New York.
 * Apply mode updates only the exact reviewed records and marks them Processed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadDotEnv } from "./audit-notion-duplicates.mjs";

const TIME_ZONE = "America/New_York";
const DEFAULT_MODEL = process.env.EVENT_FORMATTER_MODEL || "gpt-4o-mini";
const DEFAULT_LIMIT = 10;
const MAX_BATCH = 1;
const NOTION_VERSION = "2022-06-28";
const PLACEHOLDER_ICONS = new Set(["📸"]);
const VENUE_FALLBACK_EMOJI = [{ locationPrefix: "Towne Crier", emoji: "🎵" }];

function parseArgs(argv) {
  const args = {
    apply: false,
    deriveRules: false,
    limit: DEFAULT_LIMIT,
    ids: null,
    from: null,
    model: DEFAULT_MODEL,
    rulesPath: resolve("config/beacon-emoji-rules.json"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--derive-rules") args.deriveRules = true;
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--ids") args.ids = argv[++i].split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--from") args.from = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--rules") args.rulesPath = resolve(argv[++i]);
    else if (arg === "--help") {
      console.log("Usage: node scripts/format-unprocessed-events.mjs [--dry-run|--apply] [--limit N] [--ids PAGE_ID[,PAGE_ID]] [--from YYYY-MM-DD] [--derive-rules] [--rules path] [--model name]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) throw new Error("--limit must be an integer from 1 through 50");
  if (args.ids && !args.ids.length) throw new Error("--ids must contain at least one Notion page ID");
  return args;
}

function localDate(instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function daysBeforeToday(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return localDate(date);
}

function assertEnv() {
  for (const name of ["NOTION_API_KEY", "NOTION_DATABASE_ID", "OPENAI_API_KEY"]) {
    if (!process.env[name]) throw new Error(`${name} is not configured`);
  }
}

async function notion(path, method = "GET", body = undefined) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Notion ${method} ${path} failed: HTTP ${response.status}`);
  return response.json();
}

async function queryAll(filter, sorts = [{ property: "Date", direction: "ascending" }]) {
  const pages = [];
  let cursor = null;
  do {
    const response = await notion(`/databases/${process.env.NOTION_DATABASE_ID}/query`, "POST", {
      page_size: 100,
      filter,
      sorts,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return pages;
}

function plainText(items = []) {
  return items.map((item) => item.plain_text || item.text?.content || "").join("");
}

function eventFromPage(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    title: plainText(p.Name?.title),
    date: p.Date?.date?.start || null,
    location: p.Location?.select?.name || null,
    website: p.Website?.url || null,
    icon: page.icon?.type === "emoji" ? page.icon.emoji : null,
    processed: p.Processed?.checkbox === true,
    published: p.Published?.checkbox === true,
    hidden: p.Hidden?.checkbox === true,
  };
}

function iconToPreserve(icon) {
  return icon && !PLACEHOLDER_ICONS.has(icon) ? icon : null;
}

function venueFallbackEmoji(location) {
  const rule = VENUE_FALLBACK_EMOJI.find((candidate) => location?.startsWith(candidate.locationPrefix));
  return rule?.emoji || null;
}

function contentFallbackEmoji(event) {
  const text = [event.title, ...(event.editableBlocks || []).map((block) => block.text)].join(" ").toLowerCase();
  return /\b(live\s+music|musical|guitarist|band|singer|concert)\b/.test(text) ? "🎵" : null;
}

const TEXT_BLOCK_TYPES = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "quote", "callout", "toggle"]);

function extractTextBlocks(blocks) {
  const supported = [];
  const preserved = [];
  for (const block of blocks) {
    if (!TEXT_BLOCK_TYPES.has(block.type)) {
      preserved.push({ id: block.id, type: block.type });
      continue;
    }
    const node = block[block.type];
    const richText = node?.rich_text || [];
    const hasLinksOrMentions = richText.some((item) => item.href || item.type !== "text" || item.text?.link);
    if (hasLinksOrMentions) {
      preserved.push({ id: block.id, type: block.type, reason: "rich-text formatting or link" });
      continue;
    }
    supported.push({ id: block.id, type: block.type, text: plainText(richText) });
  }
  return { supported, preserved };
}

async function children(pageId) {
  const blocks = [];
  let cursor = null;
  do {
    const response = await notion(`/blocks/${pageId}/children${cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : ""}`);
    blocks.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return blocks;
}

function iconSummary(pages) {
  const groups = new Map();
  for (const page of pages) {
    const event = eventFromPage(page);
    if (!event.icon || !event.title) continue;
    const existing = groups.get(event.icon) || [];
    existing.push(event.title);
    groups.set(event.icon, existing);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 60)
    .map(([emoji, titles]) => ({ emoji, count: titles.length, examples: titles.slice(0, 7) }));
}

async function openAIJson(task, model) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return only valid JSON. Follow the supplied schema and do not include markdown fences." },
        { role: "user", content: JSON.stringify(task) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI request failed: HTTP ${response.status}`);
  const payload = await response.json();
  const content = String(payload.choices?.[0]?.message?.content || "").trim();
  const unfenced = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new Error(`OpenAI response was not valid JSON (finish=${payload.choices?.[0]?.finish_reason || "unknown"}; sample=${JSON.stringify(unfenced.slice(0, 180))})`);
  }
}

function normalizeSeriesTitle(title) {
  return title
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .split(/[:–—-]/, 1)[0]
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function seriesRules(pages) {
  const groups = new Map();
  for (const page of pages) {
    const event = eventFromPage(page);
    const key = normalizeSeriesTitle(event.title);
    if (!event.icon || key.length < 4) continue;
    const group = groups.get(key) || { labels: new Map(), examples: [] };
    group.labels.set(event.icon, (group.labels.get(event.icon) || 0) + 1);
    if (group.examples.length < 4) group.examples.push(event.title);
    groups.set(key, group);
  }
  const rules = [];
  for (const [prefix, group] of groups) {
    const ranked = [...group.labels.entries()].sort((a, b) => b[1] - a[1]);
    const [emoji, count] = ranked[0] || [];
    const total = [...group.labels.values()].reduce((sum, value) => sum + value, 0);
    if (count >= 3 && count / total >= 0.9) rules.push({ prefix, emoji, count, examples: group.examples });
  }
  return rules.sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

function emojiFromSeries(title, rules) {
  const key = normalizeSeriesTitle(title);
  const match = (rules.series_rules || []).find((rule) => key === rule.prefix);
  return match?.emoji || null;
}

async function deriveRules(model, rulesPath) {
  const from = daysBeforeToday(100);
  const pages = await queryAll({ and: [
    { property: "Published", checkbox: { equals: true } },
    { property: "Date", date: { on_or_after: from } },
  ] });
  const rules = await openAIJson({
    task: "Derive compact, reusable emoji-assignment rules for a Beacon, NY community-events calendar from human-set page icons. Prefer the demonstrated convention over generic emoji intuition. Keep existing manually assigned event icons unchanged. Cover the common categories, use one default emoji for uncategorized events, and define rule priority for overlapping categories.",
    source_window: { from, through: localDate(), time_zone: TIME_ZONE, published_events: pages.length },
    icon_evidence: iconSummary(pages),
    response_schema: {
      version: 1,
      source_window: { from: "YYYY-MM-DD", through: "YYYY-MM-DD", published_events: 0 },
      default_emoji: "single emoji",
      rules: [{ priority: 1, emoji: "single emoji", when: "plain-language category rule", examples: ["title"] }],
      notes: ["boundary note"],
    },
  }, model);
  if (!rules.default_emoji || !Array.isArray(rules.rules)) throw new Error("Emoji-rule derivation returned an invalid shape");
  rules.series_rules = seriesRules(pages);
  mkdirSync(dirname(rulesPath), { recursive: true });
  writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
  return { rules, publishedEvents: pages.length, from };
}

function loadRules(path) {
  if (!existsSync(path)) throw new Error(`Emoji rules are missing at ${path}; run with --derive-rules first`);
  const rules = JSON.parse(readFileSync(path, "utf8"));
  if (!rules.default_emoji || !Array.isArray(rules.rules)) throw new Error(`Invalid emoji rules at ${path}`);
  return rules;
}

function wordTokens(value) {
  return (value.toLowerCase().replace(/[’'`]/g, "").match(/[a-z0-9]+/g) || []);
}

function introducesNewTokens(before, after) {
  const original = new Set(wordTokens(before));
  return wordTokens(after).some((token) => !original.has(token));
}

function selectEditableBlocks(ids, original) {
  const byId = new Map(original.map((block) => [block.id, block]));
  return [...new Set((ids || []).filter((id) => typeof id === "string"))]
    .map((id) => byId.get(id))
    .filter(Boolean);
}

async function reviewBatch(events, rules, model) {
  const reviewed = await openAIJson({
    task: "Review unpublished Beacon Digest event records without changing their factual context. For each event: choose an emoji only when its existing icon is null (otherwise preserve it); clean the title into natural title case while retaining the event name, meaningful age ranges, and essential identifiers; remove stage/room suffixes such as '- Salon Stage'; remove nonessential parenthetical logistics such as caregivers/siblings. Select only the IDs of editable text blocks that genuinely need cleanup for HTML artifacts, stray labels, repetition, or whitespace. Do not select well-formed prose merely to reprint it. Do not add facts, remove material event details, invent links, or rewrite event copy into marketing language. placeholder icon is not semantically meaningful and must never be chosen or preserved; classify it from the title and description instead. Apply `emoji_rules.rules` in ascending priority order: narrowly defined rules beat broad categories; use the default only if no rule applies. Preserve non-text and link-containing blocks by omission.",
    emoji_rules: { ...rules, rules: [...rules.rules].sort((left, right) => left.priority - right.priority) },
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      date: event.date,
      location: event.location,
      website: event.website,
      existing_icon: iconToPreserve(event.icon),
      placeholder_icon: PLACEHOLDER_ICONS.has(event.icon) ? event.icon : null,
      editable_blocks: event.editableBlocks,
      preserved_blocks: event.preservedBlocks,
    })),
    response_schema: {
      events: [{
        id: "Notion page UUID",
        emoji: "single emoji",
        title: "clean title",
        clean_block_ids: ["editable block UUID requiring a change"],
        summary: "short exact change summary",
      }],
    },
  }, model);
  if (!Array.isArray(reviewed.events)) throw new Error("Event formatter returned an invalid shape");
  const byId = new Map(reviewed.events.map((event) => [event.id, event]));
  return events.map((event) => {
    const proposal = byId.get(event.id);
    if (!proposal || typeof proposal.title !== "string") throw new Error(`Event formatter omitted ${event.id}`);
    const proposedTitle = proposal.title.trim();
    const title = !proposedTitle || proposedTitle.length > 1900 || introducesNewTokens(event.title, proposedTitle)
      ? event.title
      : proposedTitle;
    const preservedIcon = iconToPreserve(event.icon);
    const proposedEmoji = typeof proposal.emoji === "string" ? proposal.emoji.trim() : "";
    const needsFallback = proposedEmoji === rules.default_emoji || PLACEHOLDER_ICONS.has(proposedEmoji);
    const emoji = preservedIcon || emojiFromSeries(title, rules) || (needsFallback ? venueFallbackEmoji(event.location) || contentFallbackEmoji(event) || rules.default_emoji : proposedEmoji);
    if (!title || !emoji || [...emoji].length > 8) throw new Error(`Invalid formatted values for ${event.id}`);
    return {
      ...event,
      proposed: {
        title,
        emoji,
        blocks: [],
        selectedBlocks: selectEditableBlocks(proposal.clean_block_ids, event.editableBlocks),
        summary: String(proposal.summary || "").slice(0, 240),
      },
    };
  });
}

async function cleanOneBlock(event, block, model) {
  const reviewed = await openAIJson({
    task: "Clean one editable Notion text block for a Beacon Digest event. Preserve every material fact, proper name, date, time, price, age range, instruction, URL, and contact detail. Only remove HTML/scraper artifacts, redundant labels, and excess whitespace; make paragraph text read naturally. Return the original text unchanged if no cleanup is needed.",
    event: { title: event.proposed.title, date: event.date, location: event.location, website: event.website },
    block: { id: block.id, type: block.type, text: block.text },
    response_schema: { id: block.id, text: "cleaned plain text" },
  }, model);
  if (reviewed.id !== block.id || typeof reviewed.text !== "string") throw new Error(`Invalid block cleanup response for ${block.id}`);
  const text = reviewed.text.trim();
  if (!text || text.length > 1900 || text === block.text || introducesNewTokens(block.text, text)) return null;
  return { id: block.id, type: block.type, text };
}

function changeSummary(event) {
  const changes = [];
  if (event.title !== event.proposed.title) changes.push("title cleaned");
  if (!iconToPreserve(event.icon)) changes.push(`emoji set to ${event.proposed.emoji}`);
  if (event.proposed.blocks.length) changes.push(`${event.proposed.blocks.length} description block${event.proposed.blocks.length === 1 ? "" : "s"} cleaned`);
  return changes.length ? changes.join("; ") : "no visible content change; will mark processed after review";
}

async function currentPageIsEligible(event) {
  const page = await notion(`/pages/${event.id}`);
  const current = eventFromPage(page);
  if (current.published || current.hidden || current.processed || current.title !== event.title || current.date !== event.date) {
    return null;
  }
  return current;
}

async function updateBlock(block) {
  await notion(`/blocks/${block.id}`, "PATCH", {
    [block.type]: { rich_text: [{ type: "text", text: { content: block.text } }] },
  });
}

async function applyOne(event) {
  const current = await currentPageIsEligible(event);
  if (!current) return { status: "skipped_concurrent_change", id: event.id };
  await notion(`/pages/${event.id}`, "PATCH", {
    icon: { type: "emoji", emoji: event.proposed.emoji },
    properties: { Name: { title: [{ type: "text", text: { content: event.proposed.title } }] } },
  });
  const contentPage = eventFromPage(await notion(`/pages/${event.id}`));
  if (contentPage.processed || contentPage.title !== event.proposed.title || contentPage.icon !== event.proposed.emoji) {
    throw new Error(`Page content read-back failed for ${event.id}`);
  }
  for (const block of event.proposed.blocks) await updateBlock(block);
  const verifiedBlocks = new Map(extractTextBlocks(await children(event.id)).supported.map((block) => [block.id, block.text]));
  for (const block of event.proposed.blocks) {
    if (verifiedBlocks.get(block.id) !== block.text) throw new Error(`Block read-back failed for ${event.id}`);
  }
  await notion(`/pages/${event.id}`, "PATCH", { properties: { Processed: { checkbox: true } } });
  const verifiedPage = eventFromPage(await notion(`/pages/${event.id}`));
  if (!verifiedPage.processed || verifiedPage.title !== event.proposed.title || verifiedPage.icon !== event.proposed.emoji) {
    throw new Error(`Final read-back failed for ${event.id}`);
  }
  return { status: "modified", id: event.id };
}

async function main() {
  loadDotEnv();
  assertEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.deriveRules) {
    const derived = await deriveRules(args.model, args.rulesPath);
    process.stdout.write(`${JSON.stringify({ mode: "derive-rules", rules_path: args.rulesPath, published_events: derived.publishedEvents, source_from: derived.from, rules: derived.rules.rules.length, default_emoji: derived.rules.default_emoji }, null, 2)}\n`);
    return;
  }
  const from = args.from || localDate();
  const pages = await queryAll({ and: [
    { property: "Published", checkbox: { equals: false } },
    { property: "Hidden", checkbox: { equals: false } },
    { property: "Processed", checkbox: { equals: false } },
    { property: "Date", date: { on_or_after: from } },
  ] });
  const selectedPages = args.ids
    ? args.ids.map((id) => pages.find((page) => page.id === id)).filter(Boolean)
    : pages.slice(0, args.limit);
  if (args.ids && selectedPages.length !== args.ids.length) throw new Error("One or more --ids pages are no longer eligible");
  const selected = selectedPages.map(eventFromPage);
  const enriched = [];
  for (const event of selected) {
    const extracted = extractTextBlocks(await children(event.id));
    enriched.push({ ...event, editableBlocks: extracted.supported, preservedBlocks: extracted.preserved });
  }
  const rules = loadRules(args.rulesPath);
  const reviewed = [];
  for (let index = 0; index < enriched.length; index += MAX_BATCH) {
    reviewed.push(...await reviewBatch(enriched.slice(index, index + MAX_BATCH), rules, args.model));
  }
  for (const event of reviewed) {
    for (const block of event.proposed.selectedBlocks) {
      const cleaned = await cleanOneBlock(event, block, args.model);
      if (cleaned) event.proposed.blocks.push(cleaned);
    }
    delete event.proposed.selectedBlocks;
  }
  const result = {
    mode: args.apply ? "apply" : "dry-run",
    from,
    eligible: pages.length,
    reviewed: reviewed.length,
    model: args.model,
    events: reviewed.map((event) => ({
      id: event.id,
      url: event.url,
      date: event.date,
      location: event.location,
      before: { title: event.title, icon: event.icon },
      after: { title: event.proposed.title, icon: event.proposed.emoji, changed_blocks: event.proposed.blocks.length },
      description_changes: event.proposed.blocks.map((block) => ({
        id: block.id,
        before: event.editableBlocks.find((source) => source.id === block.id)?.text || "",
        after: block.text,
      })),
      summary: changeSummary(event),
    })),
  };
  if (args.apply) {
    result.apply = [];
    for (const event of reviewed) result.apply.push(await applyOne(event));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`event-formatter error: ${error.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Read-only audit for likely duplicate published Beacon Digest events.
 *
 * Queries published, visible events in a bounded New York-local date range,
 * pairs events on the same local day at the same Notion Location, and asks a
 * low-cost OpenAI model whether each candidate pair is the same real-world
 * occurrence. It never writes to Notion.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIME_ZONE = "America/New_York";
const DEFAULT_MODEL = process.env.DUPLICATE_AUDIT_MODEL || "gpt-4o-mini";
const DEFAULT_LOOKBACK_DAYS = 0;
const DEFAULT_LOOKAHEAD_DAYS = 120;

export function loadDotEnv(path = resolve(process.cwd(), ".env")) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Accept the common local shorthand too, while keeping OPENAI_API_KEY as
    // the canonical name consumed by the classifier.
    if (match[1] === "OPEN_API_KEY" && !process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = value;
      continue;
    }
    // Prefer a repository-local OpenAI key over a stale inherited credential,
    // but otherwise preserve the established process environment (including the
    // production Notion connection used by the existing scraper runtime).
    if (match[1] === "OPENAI_API_KEY" || !process.env[match[1]]) {
      process.env[match[1]] = value;
    }
  }
}

function parseArgs(argv) {
  const args = { noAi: false, from: null, to: null, model: DEFAULT_MODEL, fixture: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--no-ai") args.noAi = true;
    else if (value === "--from") args.from = argv[++i];
    else if (value === "--to") args.to = argv[++i];
    else if (value === "--model") args.model = argv[++i];
    else if (value === "--fixture") args.fixture = argv[++i];
    else if (value === "--help") {
      console.log("Usage: node scripts/audit-notion-duplicates.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--no-ai] [--model MODEL] [--fixture events.json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function localDate(instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function shiftDate(date, deltaDays) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + deltaDays);
  return value.toISOString().slice(0, 10);
}

function nowLocalDate() {
  return localDate(new Date().toISOString());
}

function normalizeTitle(value) {
  return value
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function significantTokens(value) {
  const stopwords = new Set(["a", "an", "and", "at", "the", "for", "in", "of", "on", "to", "with", "live", "night", "event"]);
  return new Set(normalizeTitle(value).split(" ").filter((token) => token.length > 1 && !stopwords.has(token)));
}

export function titleSimilarity(left, right) {
  const a = significantTokens(left);
  const b = significantTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

function minutesInNewYork(instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(byType.hour) * 60 + Number(byType.minute);
}

function circularMinutesDifference(left, right) {
  const difference = Math.abs(minutesInNewYork(left) - minutesInNewYork(right));
  return Math.min(difference, 1440 - difference);
}

function canonicalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "fbclid") url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().toLowerCase() || null;
  }
}

function readText(property) {
  return (property?.rich_text || property?.title || []).map((item) => item.plain_text || item.text?.content || "").join("");
}

function pageToEvent(page) {
  const properties = page.properties || {};
  const start = properties.Date?.date?.start;
  const location = properties.Location?.select?.name;
  const title = readText(properties.Name);
  if (!start || !location || !title) return null;
  return {
    id: page.id,
    notionUrl: page.url,
    title,
    location,
    start,
    end: properties.Date?.date?.end || null,
    website: properties.Website?.url || null,
    externalId: readText(properties["External ID"]) || null,
  };
}

async function notionQuery(databaseId, token, from, to) {
  const all = [];
  let startCursor;
  do {
    const body = {
      page_size: 100,
      ...(startCursor ? { start_cursor: startCursor } : {}),
      filter: {
        and: [
          { property: "Published", checkbox: { equals: true } },
          { property: "Hidden", checkbox: { equals: false } },
          { property: "Date", date: { on_or_after: from } },
          { property: "Date", date: { on_or_before: to } },
        ],
      },
      sorts: [{ property: "Date", direction: "ascending" }],
    };
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Notion query failed: HTTP ${response.status}`);
    const payload = await response.json();
    all.push(...(payload.results || []));
    startCursor = payload.has_more ? payload.next_cursor : null;
  } while (startCursor);
  return all.map(pageToEvent).filter(Boolean);
}

function pairKey(left, right) {
  return [left.id, right.id].sort().join("|");
}

export function buildCandidatePairs(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${localDate(event.start)}\u0000${event.location}`;
    const group = groups.get(key) || [];
    group.push(event);
    groups.set(key, group);
  }
  const pairs = [];
  for (const group of groups.values()) {
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const left = group[leftIndex];
        const right = group[rightIndex];
        const titleScore = titleSimilarity(left.title, right.title);
        const urlMatch = canonicalUrl(left.website) && canonicalUrl(left.website) === canonicalUrl(right.website);
        const timeDifferenceMinutes = circularMinutesDifference(left.start, right.start);
        // Same venue/day alone is common (a venue can host several unrelated
        // events). Keep this candidate gate deliberately broad enough for
        // sourced-title and time drift, but require some corroborating signal
        // before paying for an AI judgment.
        const candidate = titleScore >= 0.25
          || (urlMatch && titleScore >= 0.1)
          || (titleScore >= 0.15 && timeDifferenceMinutes <= 60);
        if (!candidate) continue;
        pairs.push({
          pairKey: pairKey(left, right),
          date: localDate(left.start),
          location: left.location,
          left,
          right,
          heuristics: { titleSimilarity: Number(titleScore.toFixed(2)), urlMatch: Boolean(urlMatch), timeDifferenceMinutes },
        });
      }
    }
  }
  return pairs;
}

function feedbackPath() {
  return process.env.DUPLICATE_AUDIT_FEEDBACK_PATH || join(process.env.HERMES_HOME || join(homedir(), ".hermes"), "data", "beacon-duplicate-feedback.json");
}

function loadFeedback() {
  const path = feedbackPath();
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function feedbackForPair(feedback, key) {
  return feedback.entries.find((entry) => entry.pairKey === key) || null;
}

async function classifyPair(pair, apiKey, model) {
  const prompt = {
    task: "Assess whether two Beacon Digest calendar records represent the same real-world event occurrence. Same location and same day are necessary but not sufficient. Different start times or minor title wording can be sourcing drift. Do not call distinct sessions, performances, classes, or events duplicates merely because they share a venue/day.",
    pair: {
      date: pair.date,
      location: pair.location,
      left: pair.left,
      right: pair.right,
      heuristics: pair.heuristics,
    },
    response_schema: { duplicate: "boolean", confidence: "high|medium|low", rationale: "under 30 words" },
  };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return only valid JSON matching the requested response_schema." },
        { role: "user", content: JSON.stringify(prompt) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI classification failed: HTTP ${response.status}`);
  const payload = await response.json();
  let parsed;
  try {
    parsed = JSON.parse(payload.choices?.[0]?.message?.content || "");
  } catch {
    throw new Error("OpenAI classification returned invalid JSON");
  }
  if (typeof parsed.duplicate !== "boolean" || !["high", "medium", "low"].includes(parsed.confidence)) {
    throw new Error("OpenAI classification returned an invalid shape");
  }
  return { duplicate: parsed.duplicate, confidence: parsed.confidence, rationale: String(parsed.rationale || "").slice(0, 240) };
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const today = nowLocalDate();
  const from = args.from || shiftDate(today, -DEFAULT_LOOKBACK_DAYS);
  const to = args.to || shiftDate(today, DEFAULT_LOOKAHEAD_DAYS);
  const events = args.fixture
    ? JSON.parse(readFileSync(resolve(args.fixture), "utf8"))
    : await notionQuery(process.env.NOTION_DATABASE_ID, process.env.NOTION_API_KEY, from, to);

  if (!Array.isArray(events)) throw new Error("Fixture must be a JSON array of normalized event objects");
  const feedback = loadFeedback();
  const candidates = buildCandidatePairs(events);
  const findings = [];
  let suppressedFalsePositives = 0;
  for (const pair of candidates) {
    const prior = feedbackForPair(feedback, pair.pairKey);
    if (prior?.outcome === "false_positive") {
      suppressedFalsePositives += 1;
      continue;
    }
    if (args.noAi) {
      findings.push({ ...pair, assessment: { duplicate: null, confidence: "unassessed", rationale: "AI disabled" }, priorFeedback: prior?.outcome || null });
      continue;
    }
    const assessment = await classifyPair(pair, process.env.OPENAI_API_KEY, args.model);
    if (assessment.duplicate) findings.push({ ...pair, assessment, priorFeedback: prior?.outcome || null });
  }

  process.stdout.write(`${JSON.stringify({
    scanned: events.length,
    range: { from, to, timeZone: TIME_ZONE },
    candidatePairs: candidates.length,
    suppressedFalsePositives,
    model: args.noAi ? null : args.model,
    findings,
    feedbackInstructions: "Reply FP <pairKey> [note], DUP <pairKey> [note], or FN <left-page-id-or-url> <right-page-id-or-url> [note].",
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`duplicate-audit error: ${error.message}`);
    process.exit(1);
  });
}

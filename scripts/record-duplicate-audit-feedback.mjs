#!/usr/bin/env node
/** Record a human assessment of a Beacon duplicate-audit pair without touching Notion. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { outcome: null, pairKey: null, left: null, right: null, note: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--outcome") args.outcome = argv[++i];
    else if (value === "--pair-key") args.pairKey = argv[++i];
    else if (value === "--left") args.left = argv[++i];
    else if (value === "--right") args.right = argv[++i];
    else if (value === "--note") args.note = argv[++i] || "";
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!["false_positive", "confirmed_duplicate", "false_negative"].includes(args.outcome)) {
    throw new Error("--outcome must be false_positive, confirmed_duplicate, or false_negative");
  }
  if (!args.pairKey && !(args.left && args.right)) {
    throw new Error("Provide --pair-key or both --left and --right");
  }
  if (!args.pairKey) args.pairKey = [args.left, args.right].sort().join("|");
  return args;
}

function feedbackPath() {
  return process.env.DUPLICATE_AUDIT_FEEDBACK_PATH || join(process.env.HERMES_HOME || join(homedir(), ".hermes"), "data", "beacon-duplicate-feedback.json");
}

function readFeedback(path) {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

const args = parseArgs(process.argv.slice(2));
const path = feedbackPath();
const state = readFeedback(path);
const entry = {
  pairKey: args.pairKey,
  outcome: args.outcome,
  note: args.note.slice(0, 1000),
  recordedAt: new Date().toISOString(),
};
state.entries = state.entries.filter((existing) => existing.pairKey !== entry.pairKey);
state.entries.push(entry);
mkdirSync(join(path, ".."), { recursive: true });
const temp = `${path}.tmp`;
writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
renameSync(temp, path);
process.stdout.write(`${JSON.stringify({ recorded: { pairKey: entry.pairKey, outcome: entry.outcome }, feedbackPath: path })}\n`);

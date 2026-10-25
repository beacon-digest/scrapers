#!/usr/bin/env bash
set -euo pipefail

cd /opt/data/beacon-digest-scrapers
plan=/opt/data/cache/scratch/beacon-event-formatter-cycle-plan.json
result=/opt/data/cache/scratch/beacon-event-formatter-cycle-result.json

node scripts/format-unprocessed-events.mjs --dry-run --all > "$plan"

node - "$plan" <<'NODE'
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (plan.reviewed === 0) process.exit(0);
console.error(`formatter plan: ${plan.reviewed} eligible events (${plan.events.filter((event) => event.duplicate_of).length} held duplicates)`);
NODE

if [[ "${1:-}" == "--dry-run" ]]; then
  node - "$plan" <<'NODE'
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (plan.reviewed === 0) process.exit(0);
console.log(`Beacon formatter dry run — ${plan.reviewed} eligible future events; ${plan.events.filter((event) => event.duplicate_of).length} likely duplicate hold(s).`);
NODE
  exit 0
fi

node scripts/apply-event-formatter-plan.mjs --plan "$plan" > "$result"
node - "$plan" "$result" <<'NODE'
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const result = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (result.applied_count === 0 && result.held_duplicates.length === 0) process.exit(0);
const planned = new Map(plan.events.map((event) => [event.id, event]));
console.log(`Beacon formatter — processed ${result.applied_count} future event(s); ${result.description_edits} description artifact edit(s).`);
for (const event of result.applied) {
  const before = planned.get(event.id)?.before || {};
  const after = planned.get(event.id)?.after || {};
  const changes = [];
  if (before.title !== after.title) changes.push(`title → ${after.title}`);
  if (before.icon !== after.icon) changes.push(`emoji → ${after.icon}`);
  if (event.description_edits) changes.push(`${event.description_edits} description cleanup${event.description_edits === 1 ? '' : 's'}`);
  console.log(`- ${event.title}${changes.length ? ` — ${changes.join('; ')}` : ' — reviewed and processed'}`);
}
for (const event of result.held_duplicates) console.log(`- ${event.title} — likely duplicate; left unprocessed`);
NODE

import assert from "node:assert/strict";
import test from "node:test";

import { parseBeetleAndFredDateTime } from "./beetle-and-fred.js";

test("parses Beetle and Fred class times in America/New_York", () => {
  const afternoon = parseBeetleAndFredDateTime("Sep 26, 2026 01:00 pm");
  assert.ok(afternoon);
  assert.equal(
    afternoon.toISOString(),
    "2026-09-26T17:00:00.000Z",
  );
  const morning = parseBeetleAndFredDateTime("Oct 25, 2026 09:30 am");
  assert.ok(morning);
  assert.equal(
    morning.toISOString(),
    "2026-10-25T13:30:00.000Z",
  );
});

test("rejects malformed Beetle and Fred class timestamps", () => {
  assert.equal(parseBeetleAndFredDateTime("date TBD"), undefined);
});

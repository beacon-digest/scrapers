import assert from "node:assert/strict";
import test from "node:test";

import { convertToISO } from "./towne-crier.js";

test("parses Towne Crier wall-clock times in America/New_York", () => {
  assert.equal(
    convertToISO("Saturday, April 5, 2025", "8:30 pm"),
    "2025-04-06T00:30:00.000Z",
  );
  assert.equal(
    convertToISO("Sunday, November 2, 2025", "8:30 pm"),
    "2025-11-03T01:30:00.000Z",
  );
});

test("rejects malformed Towne Crier date strings", () => {
  assert.equal(convertToISO("Date TBD", "8:30 pm"), undefined);
});
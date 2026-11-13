import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.ts";

test("version is set", () => {
  assert.equal(VERSION, "0.2.0");
});

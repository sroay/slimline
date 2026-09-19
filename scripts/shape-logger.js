#!/usr/bin/env node
/**
 * Temporary diagnostic: logs the STRUCTURE (not full content) of tool_response
 * payloads so we can confirm each tool's output shape before writing truncation
 * for it. A wrong updatedToolOutput shape is silently ignored by Claude Code,
 * so guessing is not an option. Delete once shapes are confirmed.
 */
const fs = require("fs");
const path = require("path");

function describe(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return depth > 2
      ? `array(${value.length})`
      : { __array: value.length, __firstItem: value.length ? describe(value[0], depth + 1) : "empty" };
  }
  const t = typeof value;
  if (t === "string") return `string(len=${value.length}, sample=${JSON.stringify(value.slice(0, 80))})`;
  if (t !== "object") return t;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = describe(v, depth + 1);
  return out;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw);
    const record = {
      tool_name: input.tool_name,
      tool_response_type: Array.isArray(input.tool_response) ? "array" : typeof input.tool_response,
      tool_response_shape: describe(input.tool_response),
    };
    const outPath = path.join(__dirname, "..", ".claude", "shapes.jsonl");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.appendFileSync(outPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // diagnostic only — never interfere with the tool call
  }
  process.exit(0);
});

import type { SQLOutputValue } from "node:sqlite";

import { invalid, valid, type Parsed } from "#shared/json.ts";

export function requiredColumn(
  value: SQLOutputValue | undefined,
  name: string,
): Parsed<string> {
  if (value === undefined) return invalid(`missing column ${name}`);
  if (typeof value !== "string")
    return invalid(`column ${name} is not a string`);
  return valid(value);
}

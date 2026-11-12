/**
 * RFC 8785 (JSON Canonicalization Scheme) for the subset of JSON Leash signs:
 * objects, arrays, strings, booleans, null and safe integers.
 *
 * SAFETY: floats are rejected on purpose. Money is integer cents everywhere, and refusing floats removes the
 * only part of JCS (ECMAScript number serialisation) where two implementations could disagree.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalize: non-integer number ${value}`);
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const obj = value as Record<string, unknown>;
      // JCS sorts by UTF-16 code units, which is what Array.prototype.sort does for strings.
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }
}

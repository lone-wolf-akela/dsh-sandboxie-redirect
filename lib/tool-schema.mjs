/**
 * `sandbox_clear`'s output schema, kept out of the tool definition so a test can
 * check it WITHOUT booting DSH.
 *
 * Why this file exists: `defineTool` compiles `parameters` with the PARAMETER
 * spec DSL and `output.schema` with the VALUE schema DSL, and the two do not
 * agree about `required`. The value DSL allows it only on a PROPERTY node — the
 * direct children of a `properties` map — while the root, an `items` object and
 * a `oneOf` branch all reject it. Getting that wrong does not merely lose the
 * tool: `defineTool` throws while the plugin row composes, and the throw happens
 * inside a cordis callback, where the loader reports it as an unattributed
 * failure. That is exactly how a schema typo turned into "the tool silently does
 * not exist" and, one restart later, into a boot failure.
 *
 * The rules below mirror `runSchemaCompiler`/`allowRequired` in
 * `@deepseek-ai/dsh-tools` (read from the shipped bundle, not guessed):
 *   - every node: the annotation keys, plus `type` (or `oneOf`), plus `enum` and
 *     `const` on scalars, plus `properties`/`additionalProperties` on objects and
 *     `items` on arrays;
 *   - `required`   only where the parent node is a property-map entry;
 *   - every OBJECT node must state `additionalProperties` as a boolean.
 * The authoritative compiler still runs at registration; this is a pre-flight so
 * a bad schema is caught before it costs a restart.
 */

/** Author-facing keys the DSL accepts on any node. */
const ANNOTATION_KEYS = ["description", "title", "default", "examples"];
/** Keys accepted on scalar nodes. */
const SCALAR_TYPES = ["string", "number", "integer", "boolean", "null"];

/**
 * Collect every way `schema` breaks the value schema DSL.
 * @param schema - an object-rooted value schema.
 * @param path - diagnostic path for this node.
 * @param allowRequired - whether this node may carry `required` (only property-map entries may).
 * @returns a list of human-readable violations; empty means it looks legal.
 */
export function valueSchemaViolations(schema, path = "output.schema", allowRequired = false) {
  const problems = [];
  if (typeof schema !== "object" || schema === null) return [`${path} must be an object`];
  const keys = Object.keys(schema);
  const base = [...ANNOTATION_KEYS, "type", ...(allowRequired ? ["required"] : [])];

  if (Object.hasOwn(schema, "oneOf")) {
    const extra = keys.filter((key) => ![...base, "oneOf"].includes(key));
    for (const key of extra) problems.push(`${path}.${key} is not a valid key on a oneOf node`);
    if (Object.hasOwn(schema, "type")) problems.push(`${path} cannot declare both type and oneOf`);
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) problems.push(`${path}.oneOf must hold at least two schemas`);
    else schema.oneOf.forEach((branch, index) => problems.push(...valueSchemaViolations(branch, `${path}.oneOf[${index}]`, false)));
    return problems;
  }

  const type = schema.type;
  if (!SCALAR_TYPES.includes(type) && type !== "object" && type !== "array" && type !== "json") {
    problems.push(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
    return problems;
  }

  const allowed =
    type === "object"
      ? [...base, "properties", "additionalProperties"]
      : type === "array"
        ? [...base, "items"]
        : type === "json"
          ? [...base]
          : [...base, "enum", "const"];
  for (const key of keys) if (!allowed.includes(key)) problems.push(`${path}.${key} is not supported by the value schema DSL${key === "required" ? " on this node (only a property-map entry may carry it)" : ""}`);

  if (type === "object") {
    if (typeof schema.additionalProperties !== "boolean") problems.push(`${path}.additionalProperties must be explicitly true or false`);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      // Property-map entries are the ONLY nodes that may carry `required`.
      problems.push(...valueSchemaViolations(child, `${path}.properties.${name}`, true));
    }
  }
  if (type === "array" && Object.hasOwn(schema, "items")) {
    problems.push(...valueSchemaViolations(schema.items, `${path}.items`, false));
  }
  return problems;
}

/** Wire payload of `sandbox_clear`: what it did, and what it found. */
export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", required: true, enum: ["inspect", "clear", "status"] },
    workspace: { type: "string", required: true },
    copies: {
      type: "array",
      required: true,
      items: {
        // No `required` on this node: an `items` object is not a property-map
        // entry, so the DSL rejects it there (see the header).
        type: "object",
        additionalProperties: false,
        properties: {
          box: { type: "string", required: true },
          root: { type: "string", required: true },
          files: { type: "integer", required: true },
          bytes: { type: "integer", required: true },
          truncated: { type: "boolean", required: true }
        }
      }
    },
    cleared: { type: "array", required: true, items: { type: "string" } },
    note: { type: "string", required: true }
  }
};

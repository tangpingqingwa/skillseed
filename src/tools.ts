import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import type { OpenApiDocument } from "./load.js";

export const MAX_TOOLS = 8;

export class GenerateError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "GenerateError";
    this.exitCode = exitCode;
  }
}

export type JsonSchema = Record<string, unknown>;

export type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  method: string;
  path: string;
};

export type SelectToolsOptions = {
  allowTools?: string[];
};

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];
type PathItem = OpenAPIV3.PathItemObject | OpenAPIV3_1.PathItemObject;
type Operation = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
type Parameter = OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject;
type RequestBody = OpenAPIV3.RequestBodyObject | OpenAPIV3_1.RequestBodyObject;
type Schema = OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReference(value: unknown): value is { $ref: string } {
  return isRecord(value) && typeof value.$ref === "string";
}

function failUnresolved(pointer: string): never {
  throw new GenerateError(`unresolved $ref: ${pointer}`);
}

function assertNoRefs(value: unknown): void {
  if (isReference(value)) failUnresolved(value.$ref);
  if (Array.isArray(value)) {
    for (const item of value) assertNoRefs(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") failUnresolved(child);
    assertNoRefs(child);
  }
}

function cloneSchema(schema: Schema | undefined, fallbackType = "string"): JsonSchema {
  if (!schema) return { type: fallbackType };
  assertNoRefs(schema);
  return structuredClone(schema) as JsonSchema;
}

function parameterSchema(param: Parameter): JsonSchema {
  if (param.schema) {
    if (isReference(param.schema)) failUnresolved(param.schema.$ref);
    const schema = cloneSchema(param.schema);
    if (param.description && typeof schema.description !== "string") {
      schema.description = param.description;
    }
    return schema;
  }

  const first = param.content ? Object.values(param.content)[0] : undefined;
  if (first?.schema) {
    if (isReference(first.schema)) failUnresolved(first.schema.$ref);
    return cloneSchema(first.schema);
  }

  const schema: JsonSchema = { type: "string" };
  if (param.description) schema.description = param.description;
  return schema;
}

function requestBodySchema(body: RequestBody): { schema: JsonSchema; required: boolean } {
  const preferred = ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"];
  const media = preferred.map((type) => body.content[type]).find(Boolean) ?? Object.values(body.content)[0];
  if (!media?.schema) {
    return { schema: { type: "object", additionalProperties: true }, required: Boolean(body.required) };
  }
  if (isReference(media.schema)) failUnresolved(media.schema.$ref);
  return { schema: cloneSchema(media.schema, "object"), required: Boolean(body.required) };
}

function setProperty(
  properties: Record<string, JsonSchema>,
  required: Set<string>,
  name: string,
  schema: JsonSchema,
  isRequired: boolean,
): void {
  properties[name] = schema;
  if (isRequired) required.add(name);
  else required.delete(name);
}

function addParameters(
  properties: Record<string, JsonSchema>,
  required: Set<string>,
  params: readonly unknown[],
): void {
  for (const raw of params) {
    if (isReference(raw)) failUnresolved(raw.$ref);
    const param = raw as Parameter;
    if (param.in === "header" || param.in === "cookie") continue;
    setProperty(properties, required, param.name, parameterSchema(param), Boolean(param.required));
  }
}

function operationToTool(method: HttpMethod, path: string, pathItem: PathItem, operation: Operation): McpTool {
  if (!operation.operationId || operation.operationId.trim() === "") {
    throw new GenerateError(`missing operationId on ${method.toUpperCase()} ${path}`);
  }

  const name = operation.operationId;
  const description =
    (typeof operation.description === "string" && operation.description.trim()) ||
    (typeof operation.summary === "string" && operation.summary.trim()) ||
    `${method.toUpperCase()} ${path}`;

  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();

  addParameters(properties, required, pathItem.parameters ?? []);
  addParameters(properties, required, operation.parameters ?? []);

  if (operation.requestBody) {
    if (isReference(operation.requestBody)) failUnresolved(operation.requestBody.$ref);
    const body = requestBodySchema(operation.requestBody as RequestBody);
    const schema = body.schema;
    const schemaType = schema.type;
    const looksObject =
      schemaType === "object" ||
      schemaType === undefined ||
      (Array.isArray(schemaType) && schemaType.includes("object"));

    if (looksObject && isRecord(schema.properties)) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (isReference(value)) failUnresolved(value.$ref);
        if (properties[key] !== undefined) {
          throw new GenerateError(`request body property collides with parameter: ${key}`);
        }
        const propRequired = Array.isArray(schema.required) && schema.required.includes(key);
        setProperty(properties, required, key, cloneSchema(value as Schema), body.required && propRequired);
      }
    } else if (properties.body !== undefined) {
      throw new GenerateError("request body collides with parameter: body");
    } else {
      setProperty(properties, required, "body", schema, body.required);
    }
  }

  const inputSchema: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.size > 0) inputSchema.required = [...required].sort();

  return {
    name,
    description,
    inputSchema,
    method: method.toUpperCase(),
    path,
  };
}

function pathOperations(pathItem: PathItem): Array<{ method: HttpMethod; operation: Operation }> {
  const out: Array<{ method: HttpMethod; operation: Operation }> = [];
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (operation) out.push({ method, operation });
  }
  return out;
}

export function selectTools(api: OpenApiDocument, options: SelectToolsOptions = {}): McpTool[] {
  if (!("paths" in api) || !api.paths) {
    throw new GenerateError("OpenAPI document has no paths");
  }

  const allow = options.allowTools;
  if (allow && allow.length > MAX_TOOLS) {
    throw new GenerateError(`allow-list has ${allow.length} tools; max is ${MAX_TOOLS}`, 2);
  }

  if (allow && new Set(allow).size !== allow.length) {
    throw new GenerateError("allow-list contains duplicate operationIds");
  }

  const allowSet = allow ? new Set(allow) : undefined;
  const selected: McpTool[] = [];
  const seen = new Set<string>();

  for (const [path, rawItem] of Object.entries(api.paths)) {
    if (!rawItem) continue;
    if (isReference(rawItem)) failUnresolved(rawItem.$ref);
    for (const { method, operation } of pathOperations(rawItem)) {
      const id = operation.operationId?.trim() ?? "";
      if (allowSet) {
        if (!id || !allowSet.has(id)) continue;
      } else if (!id) {
        throw new GenerateError(`missing operationId on ${method.toUpperCase()} ${path}`);
      }
      if (seen.has(id)) {
        throw new GenerateError(`duplicate operationId: ${id}`);
      }
      seen.add(id);
      selected.push(operationToTool(method, path, rawItem, operation));
    }
  }

  if (allowSet) {
    const missing = allow!.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      throw new GenerateError(`unknown operationId in allow-list: ${missing.join(", ")}`);
    }
  }

  if (selected.length > MAX_TOOLS) {
    throw new GenerateError(
      `${selected.length} operations selected; max is ${MAX_TOOLS} (pass an allow-list)`,
      2,
    );
  }

  if (allow) {
    const order = new Map(allow.map((id, i) => [id, i]));
    selected.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  } else {
    selected.sort((a, b) => a.name.localeCompare(b.name));
  }

  return selected;
}

export function apiTitle(api: OpenApiDocument, fallback = "API"): string {
  if ("info" in api && api.info && typeof api.info.title === "string" && api.info.title.trim()) {
    return api.info.title.trim();
  }
  return fallback;
}

export function apiHomepage(api: OpenApiDocument): string {
  if ("externalDocs" in api && api.externalDocs && typeof api.externalDocs.url === "string") {
    return api.externalDocs.url;
  }
  if ("info" in api && api.info && "contact" in api.info && api.info.contact?.url) {
    return api.info.contact.url;
  }
  if ("servers" in api && Array.isArray(api.servers) && api.servers[0]?.url) {
    return api.servers[0].url;
  }
  return "";
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skill";
}

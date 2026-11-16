/**
 * Assemble the `amplitude` catalog: schema `main` (Amplitude's own objects),
 * schema `unified` (the shared product-analytics vocabulary) and the `amplitude`
 * secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { CHART_FUNCTIONS, realtimeActiveUsers, UNIFIED_FUNCTIONS } from "./amp/analytics.ts";
import { SECRET_TYPE } from "./amp/client.ts";
import { cohortMembers } from "./amp/cohort_members.ts";
import { events, unifiedEvents } from "./amp/events.ts";
import { MAIN_TABLES, UNIFIED_DEF_TABLES } from "./amp/resources.ts";
import {
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  SCHEMA_COMMENT,
  SCHEMA_TAGS,
  SOURCE_URL,
  UNIFIED_COMMENT,
  UNIFIED_SCHEMA_TAGS,
} from "./meta.ts";

export const FUNCTIONS: VgiFunction[] = [events, ...CHART_FUNCTIONS, cohortMembers];
export const TABLES = [...MAIN_TABLES, realtimeActiveUsers];
export const UNIFIED_TABLES = [unifiedEvents, ...UNIFIED_DEF_TABLES];

const doc = (text: string) => new Map([["vgi_doc", text]]);
const redacted = (text: string) =>
  new Map([
    ["redact", "true"],
    ["vgi_doc", text],
  ]);

/** CREATE SECRET (TYPE amplitude, API_KEY '…', SECRET_KEY '…', REGION 'us' | 'eu', BASE_URL '…'). */
export const AMPLITUDE_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "An Amplitude project's API key and secret key (HTTP Basic auth), plus its data region",
  schema: schema(
    [
      field("api_key", utf8(), true, redacted("Project API key (Project settings > General).")),
      field("secret_key", utf8(), true, redacted("Project secret key (Project settings > General).")),
      field(
        "region",
        utf8(),
        true,
        doc("Data region: 'us' (default, https://amplitude.com) or 'eu' (https://analytics.eu.amplitude.com)."),
      ),
      field(
        "base_url",
        utf8(),
        true,
        doc(
          "Override the API origin (a proxy or test server); wins over REGION. http:// only for 127.0.0.1/localhost.",
        ),
      ),
    ],
    new Map([["vgi_doc_url", "https://amplitude.com/docs/apis/authentication"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const tableExamples = (tables: { tags?: Record<string, string> }[]) =>
  tables.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]);

const MAIN_EXAMPLES = [...stampExampleQueries(FUNCTIONS), ...tableExamples(TABLES)];
const UNIFIED_EXAMPLES = [...stampExampleQueries(UNIFIED_FUNCTIONS), ...tableExamples(UNIFIED_TABLES)];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [AMPLITUDE_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_COMMENT,
      functions: FUNCTIONS,
      tables: TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(MAIN_EXAMPLES.slice(0, 12)) },
    },
    {
      path: ["unified"],
      comment: UNIFIED_COMMENT,
      functions: UNIFIED_FUNCTIONS,
      tables: UNIFIED_TABLES,
      tags: { ...UNIFIED_SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(UNIFIED_EXAMPLES) },
    },
  ],
};

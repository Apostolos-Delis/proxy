import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { lexicographicSortSchema, printSchema } from "graphql";

import { schema } from "../src/graphql/schema.js";

const target = resolve(process.cwd(), "schema.graphql");
await writeFile(target, `${printSchema(lexicographicSortSchema(schema))}\n`, "utf8");
console.log(`wrote ${target}`);

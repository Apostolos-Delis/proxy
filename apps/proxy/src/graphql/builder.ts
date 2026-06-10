import SchemaBuilder from "@pothos/core";
import { GraphQLScalarType, Kind, type ValueNode } from "graphql";

import type { JsonValue } from "../types.js";
import type { GraphQLContext } from "./context.js";

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  DefaultFieldNullability: false;
  Scalars: {
    JSON: { Input: JsonValue; Output: unknown };
  };
}>({
  defaultFieldNullability: false
});

builder.queryType({});
builder.mutationType({});

function parseJsonLiteral(node: ValueNode, variables?: Record<string, unknown> | null): JsonValue {
  switch (node.kind) {
    case Kind.STRING:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.OBJECT:
      return Object.fromEntries(
        node.fields.map((field) => [field.name.value, parseJsonLiteral(field.value, variables)])
      );
    case Kind.LIST:
      return node.values.map((value) => parseJsonLiteral(value, variables));
    case Kind.NULL:
      return null;
    case Kind.VARIABLE:
      return (variables?.[node.name.value] ?? null) as JsonValue;
    default:
      return null;
  }
}

const jsonScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value passed through unchanged.",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (node, variables) => parseJsonLiteral(node, variables)
});

builder.addScalarType("JSON", jsonScalar, {});

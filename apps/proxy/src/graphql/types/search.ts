import { builder } from "../builder.js";
import type { SearchHitModel, SearchResultModel } from "../models.js";

export const SearchHitKind = builder.enumType("SearchHitKind", {
  values: ["session", "log", "user", "logical_model", "api_key"] as const
});

export const SearchHit = builder.objectRef<SearchHitModel>("SearchHit").implement({
  fields: (t) => ({
    kind: t.field({ type: SearchHitKind, resolve: (hit) => hit.kind }),
    id: t.exposeString("id"),
    title: t.exposeString("title"),
    subtitle: t.exposeString("subtitle", { nullable: true }),
    status: t.exposeString("status", { nullable: true }),
    snippet: t.exposeString("snippet", { nullable: true }),
    occurredAt: t.exposeString("occurredAt", { nullable: true })
  })
});

export const SearchResult = builder.objectRef<SearchResultModel>("SearchResult").implement({
  fields: (t) => ({
    query: t.exposeString("query"),
    results: t.expose("results", { type: [SearchHit] })
  })
});

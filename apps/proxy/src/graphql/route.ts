import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getOperationAST, GraphQLError, type ASTVisitor, type ValidationContext } from "graphql";
import { createInMemoryCache, hashSHA256, useResponseCache, type BuildResponseCacheKeyFunction, type Cache } from "@graphql-yoga/plugin-response-cache";
import { createYoga, type Plugin } from "graphql-yoga";

import type { AdminAuthService } from "../adminAuth.js";
import type { AppConfig } from "../config.js";
import type { EmailService } from "../email.js";
import type { EventService } from "../events.js";
import type { AdminSessionIdentity } from "../persistence/adminSessions.js";
import type { ProjectionService } from "../projections.js";
import type { AppPersistence, GraphQLContext } from "./context.js";
import { unauthenticatedError } from "./errors.js";
import { schema } from "./schema.js";

export const ADMIN_GRAPHQL_ENDPOINT = "/admin/graphql";
const MAX_QUERY_DEPTH = 12;
const RESPONSE_CACHE_TTL_MS = 30_000;
const RESPONSE_CACHE_SCOPE_PARAM = "gqlCacheScope";
const RESPONSE_CACHE_EPOCH_PARAM = "gqlCacheEpoch";
const CACHEABLE_RESPONSE_KEY_PREFIX = "admin-gql-get:";
const MUTATION_INVALIDATION_KEY_PREFIX = "admin-gql-mutate:";
const RESPONSE_CACHE_SCOPE_ENTITY = "AdminGraphQLResponseCacheScope";

function depthLimitRule(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    let depth = 0;
    return {
      Field: {
        enter() {
          depth += 1;
          if (depth > maxDepth) {
            context.reportError(
              new GraphQLError(`Query depth ${depth} exceeds the maximum of ${maxDepth}.`)
            );
          }
        },
        leave() {
          depth -= 1;
        }
      }
    };
  };
}

const depthLimitPlugin: Plugin = {
  onValidate({ addValidationRule }) {
    addValidationRule(depthLimitRule(MAX_QUERY_DEPTH));
  }
};

// The endpoint is reachable without a session (login and the public
// invitation flow live here now), but anonymous callers may not walk the
// schema.
const anonymousIntrospectionGuard: Plugin<Record<string, unknown>, YogaServerContext> = {
  onValidate({ context, addValidationRule }) {
    if ((context as unknown as YogaServerContext).sessionIdentity) return;
    addValidationRule((validationContext: ValidationContext): ASTVisitor => ({
      Field(node) {
        if (node.name.value === "__schema" || node.name.value === "__type") {
          validationContext.reportError(
            new GraphQLError("Introspection requires an authenticated admin session.")
          );
        }
      }
    }));
  }
};

function responseCacheKey(responseCache: AdminResponseCache): BuildResponseCacheKeyFunction {
  return async ({
    documentString,
    variableValues,
    operationName,
    sessionId,
    request,
    context
  }) => {
    const url = new URL(request.url);
    const serverScope = await responseCacheScopeKey((context as YogaServerContext).sessionIdentity);
    const digest = await hashSHA256(JSON.stringify({
      documentString,
      variableValues: variableValues ?? null,
      operationName: operationName ?? null,
      sessionId: sessionId ?? null,
      cacheScope: url.searchParams.get(RESPONSE_CACHE_SCOPE_PARAM),
      cacheEpoch: url.searchParams.get(RESPONSE_CACHE_EPOCH_PARAM)
    }));
    const prefix = responseCacheCanStore(request)
      ? CACHEABLE_RESPONSE_KEY_PREFIX
      : MUTATION_INVALIDATION_KEY_PREFIX;
    return `${prefix}${serverScope}:${responseCache.scopeVersion(serverScope)}:${digest}`;
  };
}

function responseCacheCanStore(request: Request) {
  return request.method === "GET" && new URL(request.url).searchParams.has(RESPONSE_CACHE_SCOPE_PARAM);
}

function responseCacheCanRun(request: Request, context: YogaServerContext) {
  if (!context.sessionIdentity) return false;
  if (responseCacheCanStore(request)) return true;
  return request.method === "POST" && !request.headers.has("if-none-match");
}

type AdminResponseCache = Cache & {
  invalidateScope: (scopeKey: string) => ReturnType<Cache["invalidate"]>;
  scopeVersion: (scopeKey: string) => number;
};

function createAdminResponseCache(): AdminResponseCache {
  const cache = createInMemoryCache();
  const scopeVersions = new Map<string, number>();
  return {
    get: (id) => cache.get(id),
    set: (id, data, entities, ttl) => {
      const scopeKey = responseCacheScopeKeyFromCacheKey(id);
      if (!scopeKey) return cache.set(id, data, entities, ttl);
      return cache.set(id, data, [
        ...entities,
        { typename: RESPONSE_CACHE_SCOPE_ENTITY, id: scopeKey }
      ], ttl);
    },
    invalidate: (entities) => cache.invalidate(entities),
    invalidateScope: (scopeKey) => {
      scopeVersions.set(scopeKey, (scopeVersions.get(scopeKey) ?? 0) + 1);
      return cache.invalidate([
        { typename: RESPONSE_CACHE_SCOPE_ENTITY, id: scopeKey }
      ]);
    },
    scopeVersion: (scopeKey) => scopeVersions.get(scopeKey) ?? 0
  };
}

function responseCacheScopeKeyFromCacheKey(cacheKey: string) {
  if (!cacheKey.startsWith(CACHEABLE_RESPONSE_KEY_PREFIX)) return null;
  const value = cacheKey.slice(CACHEABLE_RESPONSE_KEY_PREFIX.length);
  const separator = value.indexOf(":");
  return separator === -1 ? null : value.slice(0, separator);
}

async function responseCacheScopeKey(identity: AdminSessionIdentity | null) {
  if (!identity) return "anonymous";
  return hashSHA256(identity.organizationId);
}

function responseCacheMutationInvalidator(responseCache: AdminResponseCache): Plugin<GraphQLContext> {
  return {
    onExecute({ args }) {
      const operation = getOperationAST(args.document, args.operationName);
      if (operation?.operation !== "mutation") return;
      return {
        async onExecuteDone({ result }) {
          if (!isExecutionResult(result)) return;
          const identity = args.contextValue.sessionIdentity;
          if (!identity) return;
          await responseCache.invalidateScope(await responseCacheScopeKey(identity));
        }
      };
    }
  };
}

function isExecutionResult(result: unknown) {
  return Boolean(
    result &&
    typeof result === "object" &&
    !(Symbol.asyncIterator in result)
  );
}

type YogaServerContext = {
  req: FastifyRequest;
  reply: FastifyReply;
  sessionIdentity: AdminSessionIdentity | null;
};

export type AdminGraphQLDeps = {
  config: AppConfig;
  adminAuth: AdminAuthService;
  emailService: EmailService;
  events: EventService;
  projections: ProjectionService;
  persistence?: AppPersistence;
};

export function registerAdminGraphQL(app: FastifyInstance, deps: AdminGraphQLDeps) {
  const responseCache = createAdminResponseCache();
  const yoga = createYoga<YogaServerContext, GraphQLContext>({
    schema,
    graphqlEndpoint: ADMIN_GRAPHQL_ENDPOINT,
    graphiql: deps.config.adminGraphiqlEnabled,
    batching: false,
    landingPage: false,
    cors: false,
    maskedErrors: true,
    logging: {
      debug: (...args) => args.forEach((arg) => app.log.debug(arg)),
      info: (...args) => args.forEach((arg) => app.log.info(arg)),
      warn: (...args) => args.forEach((arg) => app.log.warn(arg)),
      error: (...args) => args.forEach((arg) => app.log.error(arg))
    },
    plugins: [
      useResponseCache<YogaServerContext>({
        cache: responseCache,
        ttl: RESPONSE_CACHE_TTL_MS,
        session: (_request, context) => {
          const identity = context.sessionIdentity;
          if (!identity) return null;
          return [
            identity.sessionId,
            identity.organizationId,
            identity.workspaceId,
            identity.userId
          ].join(":");
        },
        enabled: responseCacheCanRun,
        shouldCacheResult: ({ cacheKey, result }) => (
          cacheKey.startsWith(CACHEABLE_RESPONSE_KEY_PREFIX) && !result.errors?.length
        ),
        buildResponseCacheKey: responseCacheKey(responseCache)
      }),
      responseCacheMutationInvalidator(responseCache),
      depthLimitPlugin,
      anonymousIntrospectionGuard
    ],
    context: ({ sessionIdentity, req, reply }) => ({
      identity: () => {
        if (!sessionIdentity) throw unauthenticatedError();
        return sessionIdentity;
      },
      sessionIdentity,
      config: deps.config,
      persistence: deps.persistence,
      events: deps.events,
      projections: deps.projections,
      emailService: deps.emailService,
      adminAuth: deps.adminAuth,
      requestHeaders: req.headers,
      setSessionCookie: (value: string) => {
        reply.header("set-cookie", value);
      }
    })
  });

  app.route({
    url: ADMIN_GRAPHQL_ENDPOINT,
    method: ["GET", "POST", "OPTIONS"],
    handler: async (req, reply) => {
      const sessionIdentity = await deps.adminAuth
        .resolve(req.headers)
        .catch(() => null);
      const response = await yoga.handleNodeRequestAndResponse(req, reply, {
        req,
        reply,
        sessionIdentity
      });
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      if (response.headers.has("etag") && !response.headers.has("cache-control")) {
        reply.header("cache-control", "private, max-age=0, must-revalidate");
      }
      reply.status(response.status);
      reply.send(response.body);
      return reply;
    }
  });
}

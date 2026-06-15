import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GraphQLError, type ASTVisitor, type ValidationContext } from "graphql";
import { hashSHA256, useResponseCache, type BuildResponseCacheKeyFunction } from "@graphql-yoga/plugin-response-cache";
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

const responseCacheKey: BuildResponseCacheKeyFunction = async ({
  documentString,
  variableValues,
  operationName,
  sessionId,
  request
}) => {
  const url = new URL(request.url);
  const digest = await hashSHA256(JSON.stringify({
    documentString,
    variableValues: variableValues ?? null,
    operationName: operationName ?? null,
    sessionId: sessionId ?? null,
    cacheScope: url.searchParams.get(RESPONSE_CACHE_SCOPE_PARAM),
    cacheEpoch: url.searchParams.get(RESPONSE_CACHE_EPOCH_PARAM)
  }));
  return `${responseCacheCanStore(request) ? CACHEABLE_RESPONSE_KEY_PREFIX : MUTATION_INVALIDATION_KEY_PREFIX}${digest}`;
};

function responseCacheCanStore(request: Request) {
  return request.method === "GET" && new URL(request.url).searchParams.has(RESPONSE_CACHE_SCOPE_PARAM);
}

function responseCacheCanRun(request: Request, context: YogaServerContext) {
  if (!context.sessionIdentity) return false;
  if (responseCacheCanStore(request)) return true;
  return request.method === "POST" && !request.headers.has("if-none-match");
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
        buildResponseCacheKey: responseCacheKey
      }),
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

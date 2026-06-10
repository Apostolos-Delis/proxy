import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GraphQLError, type ASTVisitor, type ValidationContext } from "graphql";
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
    plugins: [depthLimitPlugin, anonymousIntrospectionGuard],
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
      reply.status(response.status);
      reply.send(response.body);
      return reply;
    }
  });
}

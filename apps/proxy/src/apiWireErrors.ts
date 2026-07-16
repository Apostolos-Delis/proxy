import type { FastifyReply } from "fastify";

import type { Surface } from "./types.js";

export function sendGatewayError(
  surface: Surface,
  reply: FastifyReply,
  status: number,
  code: string,
  message = code,
  details: Record<string, unknown> = {}
) {
  reply.header("content-type", "application/json; charset=utf-8");
  reply.code(status).send({
    ...gatewayErrorBody(surface, status, code, message),
    ...details
  });
}

export function gatewayErrorBody(
  surface: Surface,
  status: number,
  code: string,
  message = code
) {
  if (surface === "anthropic-messages") {
    return {
      type: "error",
      error: {
        type: gatewayErrorType(surface, status),
        message
      }
    };
  }
  return {
    error: {
      message,
      type: gatewayErrorType(surface, status),
      code
    }
  };
}

function gatewayErrorType(surface: Surface, status: number) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return surface === "anthropic-messages" ? "api_error" : "server_error";
  if (surface === "anthropic-messages" && status === 404) return "not_found_error";
  return "invalid_request_error";
}

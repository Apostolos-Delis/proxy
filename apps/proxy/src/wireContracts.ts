import type { Dialect, GatewayOperationId } from "@proxy/schema";

const WIRE_OPERATIONS: Record<Dialect, readonly GatewayOperationId[]> = {
  "anthropic-messages": ["text.generate", "text.count_tokens"],
  "openai-responses": ["text.generate"],
  "openai-chat": ["text.generate"],
  "bedrock-converse": ["text.generate"]
};

export function wireSupportsOperation(wireId: Dialect, operationId: GatewayOperationId) {
  return WIRE_OPERATIONS[wireId].includes(operationId);
}

export function wirePathSupportsOperation(
  ingressWireId: Dialect,
  egressWireId: Dialect,
  operationId: GatewayOperationId
) {
  if (!wireSupportsOperation(egressWireId, operationId)) return false;
  return ingressWireId === egressWireId || operationId === "text.generate";
}

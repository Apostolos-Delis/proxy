export type BedrockContentBlock = Record<string, unknown>;

export type BedrockMessage = {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
};

export class BedrockConverseTranslationError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
  }
}

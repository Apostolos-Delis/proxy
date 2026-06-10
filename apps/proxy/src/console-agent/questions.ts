import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { z } from "zod";

export const ASK_USER_QUESTION_TOOL = "ask_user_question";

const askUserQuestionInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        options: z
          .array(z.string().min(1))
          .min(2)
          .max(4)
          .refine((options) => new Set(options).size === options.length, {
            message: "options must be unique"
          })
      })
    )
    .min(1)
    .max(4)
});

export type AskedQuestion = z.infer<typeof askUserQuestionInput>["questions"][number];

export function askUserQuestionTool(
  onAsk: (questions: AskedQuestion[]) => void
): AgentTool<TSchema, { questions: AskedQuestion[] }> {
  const { $schema: _discarded, ...schema } = z.toJSONSchema(askUserQuestionInput, { io: "input" });
  return {
    name: ASK_USER_QUESTION_TOOL,
    label: "Ask the user",
    description:
      "Ask the user up to 4 clarifying questions, each with 2-4 concrete answer options. Use this instead of guessing when a decision is required; the run pauses until the user answers.",
    parameters: schema as TSchema,
    execute: async (_toolCallId: string, params: unknown) => {
      const parsed = askUserQuestionInput.safeParse(params);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid ask_user_question input: ${parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")}`
            }
          ],
          details: { questions: [] },
          terminate: false
        };
      }
      onAsk(parsed.data.questions);
      return {
        content: [
          {
            type: "text" as const,
            text: "Questions presented to the user. The run pauses for their answer."
          }
        ],
        details: { questions: parsed.data.questions },
        // Asking ends the turn: the run parks awaiting_input until the user replies.
        terminate: true
      };
    }
  };
}

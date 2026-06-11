import { useState } from "react";

import type { ConsoleAgentQuestion } from "./consoleAgentData";

// Selecting options answers the agent's structured question; the composer
// below the transcript stays available as the free-text override.
export function AgentQuestionCard({
  questions,
  active,
  busy,
  onAnswer
}: {
  questions: ConsoleAgentQuestion[];
  active: boolean;
  busy: boolean;
  onAnswer: (text: string) => void;
}) {
  const [selections, setSelections] = useState<Record<number, string>>({});
  const single = questions.length === 1;
  const allAnswered = questions.every((_, index) => selections[index] !== undefined);
  const disabled = !active || busy;

  const choose = (index: number, option: string) => {
    if (single) {
      onAnswer(option);
      return;
    }
    setSelections((current) => ({ ...current, [index]: option }));
  };

  const submit = () => {
    onAnswer(
      questions.map((entry, index) => `${entry.question} -> ${selections[index]}`).join("\n")
    );
  };

  return (
    <div className={`agent-question-card${active ? "" : " resolved"}`}>
      <div className="agent-message-role">Agent needs input</div>
      {questions.map((entry, index) => (
        <div key={`${index}-${entry.question}`} className="agent-question">
          <p className="agent-question-text">{entry.question}</p>
          <div className="agent-question-options">
            {entry.options.map((option) => (
              <button
                key={option}
                type="button"
                className={`btn${selections[index] === option ? " btn-primary" : ""}`}
                disabled={disabled}
                onClick={() => choose(index, option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ))}
      {!single && active ? (
        <button
          className="btn btn-primary"
          type="button"
          disabled={disabled || !allAnswered}
          onClick={submit}
        >
          Send answers
        </button>
      ) : null}
      {active ? <p className="agent-question-hint">Or type your own reply below.</p> : null}
    </div>
  );
}

import { KeyRound, Link2 } from "lucide-react";

export function ClaudeSetupGuide() {
  return (
    <div className="provider-credential-guide">
      <KeyRound />
      <div>
        <strong>Use a Claude setup token</strong>
        <span>This setup currently uses a manual token flow; paste a token minted by Claude Code.</span>
        <ol className="provider-credential-steps">
          <li>Run <span className="mono">claude setup-token</span> while signed into the Claude subscription account that should pay for this traffic.</li>
          <li>Paste the printed <span className="mono">sk-ant-oat01-...</span> value into <span className="mono">Claude setup token</span>.</li>
          <li>Save the credential, then bind it to a Prompt Proxy API key you own before using that key with Claude Code.</li>
        </ol>
      </div>
    </div>
  );
}

export function CodexSetupGuide() {
  return (
    <div className="provider-credential-guide">
      <Link2 />
      <div>
        <strong>Use an existing Codex identity</strong>
        <span>This setup currently uses a manual token flow; paste an existing Codex token or auth JSON.</span>
        <ol className="provider-credential-steps">
          <li>Create a Codex access token from the ChatGPT workspace Access tokens page, or run <span className="mono">codex login</span> and use <span className="mono">~/.codex/auth.json</span> when present.</li>
          <li>Paste the full auth JSON, or paste the raw access token and fill <span className="mono">ChatGPT account ID</span> separately.</li>
          <li>Accepted JSON fields include <span className="mono">access_token</span> or <span className="mono">tokens.access_token</span>, plus <span className="mono">chatgpt_account_id</span> or <span className="mono">account_id</span>; camelCase variants work too.</li>
          <li>Save the credential, then bind it to a Prompt Proxy API key you own before using that key with Codex.</li>
        </ol>
      </div>
    </div>
  );
}

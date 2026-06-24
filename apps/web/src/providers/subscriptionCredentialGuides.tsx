import { KeyRound, Link2 } from "lucide-react";

import type { CreateProviderCredentialSource } from "./createCredentialWizard";

export function ClaudeSetupGuide({ source }: { source: CreateProviderCredentialSource }) {
  if (source === "claude_oauth") {
    return (
      <div className="provider-credential-guide">
        <Link2 />
        <div>
          <strong>Sign in with Claude</strong>
          <span>Proxy opens Claude login in your browser and stores the resulting Claude Code OAuth token as an encrypted provider credential.</span>
          <ol className="provider-credential-steps">
            <li>Start sign-in while using the Claude account that should pay for this traffic.</li>
            <li>Finish the Claude browser login; Proxy saves the credential automatically.</li>
            <li>Bind the saved credential to a Proxy API key before using that key with Claude Code.</li>
          </ol>
        </div>
      </div>
    );
  }

  if (source === "local_auth") {
    return (
      <div className="provider-credential-guide">
        <KeyRound />
        <div>
          <strong>Import a Claude Code token</strong>
          <span>Proxy reads the token from the proxy process environment and stores it as an encrypted provider credential.</span>
          <ol className="provider-credential-steps">
            <li>Run <span className="mono">claude setup-token</span> while signed into the Claude account that should pay for this traffic.</li>
            <li>Set <span className="mono">CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...</span> where the proxy runs, then restart the proxy.</li>
            <li>Save the credential, then bind it to a Proxy API key you own before using that key with Claude Code.</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="provider-credential-guide">
      <KeyRound />
      <div>
        <strong>Paste a Claude setup token</strong>
        <span>Claude Code can mint a long-lived setup token for environments where browser login is not available.</span>
        <ol className="provider-credential-steps">
          <li>Run <span className="mono">claude setup-token</span> while signed into the Claude subscription account that should pay for this traffic.</li>
          <li>Paste the printed <span className="mono">sk-ant-oat01-...</span> value into <span className="mono">Claude setup token</span>.</li>
          <li>Save the credential, then bind it to a Proxy API key you own before using that key with Claude Code.</li>
        </ol>
      </div>
    </div>
  );
}

export function CodexSetupGuide({ source }: { source: CreateProviderCredentialSource }) {
  if (source === "openai_oauth") {
    return (
      <div className="provider-credential-guide">
        <Link2 />
        <div>
          <strong>Sign in with OpenAI</strong>
          <span>Proxy starts the Codex device-code flow, then stores the resulting access and refresh tokens as an encrypted provider credential.</span>
          <ol className="provider-credential-steps">
            <li>Start sign-in, open the OpenAI link, and enter the one-time code shown here.</li>
            <li>After OpenAI confirms the login, Proxy saves the credential automatically.</li>
            <li>Bind the saved credential to a Proxy API key before using that key with Codex.</li>
          </ol>
        </div>
      </div>
    );
  }

  if (source === "local_auth") {
    return (
      <div className="provider-credential-guide">
        <Link2 />
        <div>
          <strong>Import a Codex identity</strong>
          <span>Proxy reads Codex auth JSON from the proxy host and stores refresh-capable auth as an encrypted provider credential.</span>
          <ol className="provider-credential-steps">
            <li>Run <span className="mono">codex login</span> on the proxy host, or use <span className="mono">codex login --device-auth</span> for a device-code flow.</li>
            <li>Leave the auth cache at <span className="mono">~/.codex/auth.json</span>, or set <span className="mono">PROXY_CODEX_AUTH_FILE</span> to another auth JSON path.</li>
            <li>Save the credential, then bind it to a Proxy API key you own before using that key with Codex.</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="provider-credential-guide">
      <Link2 />
      <div>
        <strong>Paste a Codex identity</strong>
        <span>Use this fallback when Proxy cannot read the proxy host's Codex auth cache directly.</span>
        <ol className="provider-credential-steps">
          <li>Create a Codex access token from the ChatGPT workspace Access tokens page, or run <span className="mono">codex login</span> and use <span className="mono">~/.codex/auth.json</span> when present.</li>
          <li>Paste the full auth JSON, or paste the raw access token and fill <span className="mono">ChatGPT account ID</span> separately.</li>
          <li>Accepted JSON fields include <span className="mono">access_token</span> or <span className="mono">tokens.access_token</span>, plus <span className="mono">chatgpt_account_id</span>, <span className="mono">account_id</span>, or <span className="mono">tokens.account_id</span>; camelCase variants work too.</li>
          <li>Save the credential, then bind it to a Proxy API key you own before using that key with Codex.</li>
        </ol>
      </div>
    </div>
  );
}

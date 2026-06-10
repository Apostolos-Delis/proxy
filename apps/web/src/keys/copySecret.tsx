import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopySecret({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row gap-8 invite-link-row">
      <span className="mono invite-link">{secret}</span>
      <button
        className="btn btn-sm"
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(secret);
          setCopied(true);
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy key"}
      </button>
    </div>
  );
}

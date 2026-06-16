import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopySecret({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="key-secret-copy">
      <span className="mono key-secret-value">{secret}</span>
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

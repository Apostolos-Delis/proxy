/* Proxy — mock data for a mid-size startup */
(function () {
  const MODELS = [
    { id: "proxy-opus-4",   label: "proxy-opus-4",   color: "#0d9488", inPrice: 15, outPrice: 75 },
    { id: "proxy-sonnet-4", label: "proxy-sonnet-4", color: "#2dd4bf", inPrice: 3,  outPrice: 15 },
    { id: "proxy-haiku-4",  label: "proxy-haiku-4",  color: "#38bdf8", inPrice: 0.8, outPrice: 4 },
    { id: "proxy-embed-3",  label: "proxy-embed-3",  color: "#34d399", inPrice: 0.1, outPrice: 0 },
  ];

  const AVATARS = ["#14b8a6","#38bdf8","#34d399","#5eead4","#22d3ee","#60a5fa","#2dd4bf","#0ea5e9","#10b981","#7dd3fc"];
  function avatarColor(i){ return AVATARS[i % AVATARS.length]; }
  function initials(name){ return name.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase(); }

  const USERS = [
    { name: "Apostolos Delis",   email: "apostolos@proxy.dev",  role: "Owner",     keys: 4, tokens: 18_420_000, spend: 1842.66, status: "active",  joined: "Jan 2026" },
    { name: "Amanda Hollis",     email: "amanda@proxy.dev",     role: "Admin",     keys: 2, tokens: 9_120_000,  spend: 912.04,  status: "active",  joined: "Jan 2026" },
    { name: "Anton Nikitchenko", email: "anton@proxy.dev",      role: "Developer", keys: 3, tokens: 7_640_000,  spend: 764.31,  status: "active",  joined: "Feb 2026" },
    { name: "Samuel Levine",     email: "sam@proxy.dev",        role: "Developer", keys: 2, tokens: 5_210_000,  spend: 521.09,  status: "active",  joined: "Feb 2026" },
    { name: "Volodymyr Bobyr",   email: "vlad@proxy.dev",       role: "Developer", keys: 1, tokens: 3_980_000,  spend: 398.22,  status: "active",  joined: "Mar 2026" },
    { name: "Josh Benard",       email: "josh@proxy.dev",       role: "Developer", keys: 2, tokens: 2_760_000,  spend: 276.18,  status: "active",  joined: "Mar 2026" },
    { name: "Sean Busby",        email: "sean@proxy.dev",       role: "Developer", keys: 1, tokens: 1_540_000,  spend: 154.77,  status: "active",  joined: "Apr 2026" },
    { name: "Neil Lokare",       email: "neil@proxy.dev",       role: "Billing",   keys: 1, tokens: 980_000,    spend: 98.40,   status: "active",  joined: "Apr 2026" },
    { name: "Dharma Kanneganti", email: "dharma@proxy.dev",     role: "Developer", keys: 1, tokens: 642_000,    spend: 64.22,   status: "active",  joined: "Apr 2026" },
    { name: "Ben Booi",          email: "ben@proxy.dev",        role: "Developer", keys: 1, tokens: 310_000,    spend: 31.05,   status: "invited", joined: "May 2026" },
    { name: "Saad Khan",         email: "saad@proxy.dev",       role: "Viewer",    keys: 0, tokens: 0,          spend: 0,       status: "invited", joined: "May 2026" },
    { name: "Vignesh Hira",      email: "vignesh@proxy.dev",    role: "Developer", keys: 1, tokens: 188_000,    spend: 18.83,   status: "active",  joined: "May 2026" },
  ];
  USERS.forEach((u,i)=>{ u.id = "usr_" + Math.random().toString(36).slice(2,9); u.color = avatarColor(i); u.initials = initials(u.name); });

  const KEY_NAMES = [
    ["codex-test","All","active"],["production-web","All","active"],["anton-local","Read","active"],
    ["sam-staging","All","active"],["lennar-kb","Write","active"],["jben-codex","All","active"],
    ["codex-2","All","inactive"],["agentic-concierge","All","active"],["runlayer-svc","Inherited","active"],
    ["vignesh-api","Read","active"],["skyvern-test","All","inactive"],["dharma-local","All","active"],
    ["batch-pipeline","Write","active"],["eval-harness","Read","active"],
  ];
  function rid(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }
  function secret(){ return "sk-proxy-" + Math.random().toString(36).slice(2,6) + "..." + rid().slice(0,4); }
  const DATES = ["Jun 8, 2026","Jun 4, 2026","Jun 1, 2026","May 28, 2026","May 24, 2026","May 18, 2026","May 12, 2026","May 8, 2026","May 4, 2026","Apr 30, 2026","Apr 24, 2026","Apr 18, 2026","Apr 12, 2026","Apr 6, 2026"];
  const KEYS = KEY_NAMES.map((k,i)=>({
    id: "key_" + Math.random().toString(36).slice(2,10),
    name: k[0], perms: k[1], status: k[2],
    tracking: "key_" + Math.random().toString(36).slice(2,14),
    secret: secret(),
    created: DATES[i % DATES.length],
    lastUsed: i % 5 === 4 ? "Never" : DATES[(i+1) % DATES.length],
    creator: USERS[i % USERS.length].name,
    creatorColor: USERS[i % USERS.length].color,
    creatorInitials: USERS[i % USERS.length].initials,
    spend: Math.round((6000 / (i + 1)) * 100) / 100,
    requests: Math.round(40000 / (i + 1)),
  }));

  // ----- usage time series: 30 days -----
  function genSeries(days, base, variance, trend) {
    const out = []; let v = base;
    const today = new Date(2026, 5, 8);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const dow = d.getDay();
      const weekend = (dow === 0 || dow === 6) ? 0.55 : 1;
      const noise = 1 + (Math.sin(i * 1.7) * 0.18) + (Math.cos(i * 0.6) * 0.12);
      v = base * (1 + trend * (days - i) / days);
      const val = Math.max(0, v * weekend * noise * (0.85 + Math.random() * 0.3));
      out.push({
        date: d,
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        value: val,
      });
    }
    return out;
  }

  const spendSeries = genSeries(30, 150, 0.4, 0.25);
  // align tokens & requests to spend shape
  const tokenSeries = spendSeries.map(p => ({ ...p, value: p.value * 11000 + 200000 }));
  const reqSeries = spendSeries.map(p => ({ ...p, value: Math.round(p.value * 70 + 1200) }));

  const totalSpend = spendSeries.reduce((a, b) => a + b.value, 0);
  const totalTokens = tokenSeries.reduce((a, b) => a + b.value, 0);
  const totalReq = reqSeries.reduce((a, b) => a + b.value, 0);

  // model split for donut
  const modelSplit = [
    { ...MODELS[0], tokens: totalTokens * 0.46, requests: totalReq * 0.30 },
    { ...MODELS[1], tokens: totalTokens * 0.34, requests: totalReq * 0.42 },
    { ...MODELS[2], tokens: totalTokens * 0.15, requests: totalReq * 0.22 },
    { ...MODELS[3], tokens: totalTokens * 0.05, requests: totalReq * 0.06 },
  ];

  // ----- prompts / request logs -----
  const PROMPTS = [
    "Summarize the attached Q2 earnings call transcript into 5 bullet points.",
    "Write a Python function that deduplicates a list of dicts by the 'id' key.",
    "Classify this support ticket sentiment: 'My order never arrived and nobody replied.'",
    "Generate 3 subject lines for a re-engagement email to dormant users.",
    "Extract all dates and amounts from this invoice and return JSON.",
    "Explain the difference between optimistic and pessimistic locking.",
    "Translate this product description from English to Japanese.",
    "Given these flaky tests, suggest the most likely root cause.",
    "Draft a polite decline email for a vendor proposal we're passing on.",
    "Rewrite this paragraph to be more concise and active voice.",
    "What's the time complexity of this sorting routine? Suggest improvements.",
    "Create a SQL query for monthly active users grouped by signup cohort.",
    "Turn these bullet notes into a structured PRD outline.",
    "Identify PII in the following text block and redact it.",
    "Suggest an index strategy for a table with 40M rows and frequent range scans.",
    "Generate alt text for an image of a modern open-plan kitchen.",
  ];
  const RESPONSES = [
    "Here are 5 key takeaways: 1) Revenue grew 24% YoY to $48.2M, driven by enterprise...",
    "def dedupe(items):\n    seen = set(); out = []\n    for it in items:\n        if it['id'] not in seen: ...",
    "Sentiment: negative (0.92). Detected frustration and an unresolved delivery issue...",
    "1) 'We saved your seat — come back?'  2) 'It's been a while, here's 20% off'  3) ...",
    "{ \"invoice_no\": \"INV-2031\", \"date\": \"2026-05-22\", \"total\": 1840.00, \"line_items\": [...] }",
    "Optimistic locking assumes conflicts are rare and checks a version column at write...",
    "この製品は、毎日の使用のために設計された高品質な... (translation continues)",
    "The shared mutable fixture `db_session` is reused across tests without rollback...",
    "Subject: Re: Partnership proposal\n\nHi Dana, thank you for sending this over. After...",
    "We shipped the redesign in three weeks, cutting load time by half and lifting...",
    "This is O(n²) due to the nested scan. Swapping to a hash-based grouping makes it O(n)...",
    "SELECT date_trunc('month', signup) AS cohort, count(distinct user_id) FROM events...",
    "# PRD: Usage Analytics\n\n## Problem\nTeams can't see per-key spend...\n\n## Goals...",
    "Redacted 2 emails and 1 phone number. Output: 'Contact [REDACTED] regarding...'",
    "Create a BRIN index on the timestamp column given the natural ordering, plus a...",
    "A bright, modern open-plan kitchen with white cabinetry, a marble island, and...",
  ];

  function genLogs(n) {
    const logs = []; const statuses = ["success","success","success","success","success","error","success","success"];
    const now = new Date(2026, 5, 8, 14, 32);
    for (let i = 0; i < n; i++) {
      const m = MODELS[Math.floor(Math.pow(Math.random(), 1.6) * MODELS.length)];
      const u = USERS[Math.floor(Math.pow(Math.random(), 1.4) * (USERS.length - 1))];
      const k = KEYS[Math.floor(Math.random() * KEYS.length)];
      const inTok = Math.floor(200 + Math.random() * 7000);
      const outTok = m.id === "proxy-embed-3" ? 0 : Math.floor(80 + Math.random() * 2400);
      const cost = (inTok * m.inPrice + outTok * m.outPrice) / 1_000_000;
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const ts = new Date(now); ts.setMinutes(ts.getMinutes() - Math.floor(Math.random() * 60 * 50));
      const pi = Math.floor(Math.random() * PROMPTS.length);
      logs.push({
        id: "req_" + Math.random().toString(36).slice(2,12),
        ts,
        tsLabel: ts.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        model: m.id, modelColor: m.color,
        user: u.name, userId: u.id, userColor: u.color, userInitials: u.initials,
        keyName: k.name,
        prompt: PROMPTS[pi],
        response: status === "error" ? "—" : RESPONSES[pi],
        inTok, outTok, totalTok: inTok + outTok,
        cost,
        latency: Math.round((status === "error" ? 120 : 380 + Math.random() * 4200)),
        status,
        errorMsg: status === "error" ? "rate_limit_exceeded: 429" : null,
        temperature: (Math.random() * 1).toFixed(1),
      });
    }
    return logs.sort((a, b) => b.ts - a.ts);
  }
  const LOGS = genLogs(60);

  const UPDATES = [
    { tag: "Models", date: "2 days ago", title: "proxy-opus-4 now generally available", body: "Our most capable model for complex reasoning and agentic workflows is out of preview." },
    { tag: "Platform", date: "1 week ago", title: "Prompt caching is on by default", body: "Reuse large shared prefixes across requests and cut input costs by up to 90%." },
    { tag: "Billing", date: "2 weeks ago", title: "Per-key spend limits", body: "Set hard and soft spend caps on individual API keys from the Billing tab." },
  ];

  window.PROXY_DATA = {
    MODELS, USERS, KEYS, LOGS, UPDATES, modelSplit,
    spendSeries, tokenSeries, reqSeries,
    totalSpend, totalTokens, totalReq,
    monthBudget: 8000,
    avatarColor, initials,
  };
})();

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Proxies month-end reconciliation commentary to the Anthropic API so the
// API key stays server-side. The browser sends only the reconciliation
// figures; the prompt and key never leave the edge runtime.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ analysis: null, error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  // No key configured → let the client render its local fallback summary.
  if (!apiKey) return json({ analysis: null, error: "no_key" });

  let rec: Record<string, number | string>;
  try {
    rec = await req.json();
  } catch {
    return json({ analysis: null, error: "bad_request" }, 400);
  }

  const { month, pl_revenue = 0, projects_total = 0, variance = 0, pct = 0 } = rec as {
    month: string; pl_revenue: number; projects_total: number; variance: number; pct: number;
  };

  const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const prompt = `You are a senior management consultant reconciling a month-end close at a professional services firm. Compare the firm-wide P&L revenue against the sum of client/project revenue for the same month, then write exactly 2 sentences.

Month: ${month}
P&L revenue (actual): ${money(pl_revenue)}
Sum of project revenue: ${money(projects_total)}
Variance: ${variance >= 0 ? "+" : ""}${money(variance)} (${Number(pct).toFixed(1)}%)

Sentence 1: State whether the two sources reconcile and the most likely cause of any gap (e.g. unbilled work, timing, revenue not yet allocated to projects, intercompany items).
Sentence 2: State the specific action the client's financial analyst should verify before sign-off.

Output only the 2 sentences, no labels.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("Anthropic API error", res.status, detail);
      return json({ analysis: null, error: `anthropic_${res.status}` });
    }

    const data = await res.json();
    const analysis = data?.content?.find((b: { type: string }) => b.type === "text")?.text?.trim() ?? null;
    return json({ analysis });
  } catch (err) {
    console.error("analyze-reconciliation error", err);
    return json({ analysis: null, error: "exception" });
  }
});

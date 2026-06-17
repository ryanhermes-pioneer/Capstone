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

  const {
    month, pl_revenue = 0, projects_total = 0, variance = 0, pct = 0,
    lineItems = [],
  } = rec as {
    month: string; pl_revenue: number; projects_total: number; variance: number; pct: number;
    lineItems: { client: string; amount: number }[];
  };

  const fmt  = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
  const sign = variance >= 0 ? "+" : "-";
  const lineBlock = lineItems.length
    ? "\nClient breakdown:\n" + lineItems.slice(0, 10).map(li => `  ${li.client}: ${fmt(li.amount)}`).join("\n")
    : "";

  const prompt = `Month-end P&L reconciliation — ${month}
P&L revenue: ${fmt(pl_revenue)}
Projects total: ${fmt(projects_total)}
Variance: ${sign}${fmt(variance)} (${Number(pct).toFixed(1)}%)${lineBlock}

Write 1–2 short sentences. Name the specific client(s) most likely driving the variance (if line items are provided) and what the analyst should verify. No preamble.`;

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
        max_tokens: 150,
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

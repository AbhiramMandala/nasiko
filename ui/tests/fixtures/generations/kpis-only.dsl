Sure — building that now.
root = AppStack([kpis], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_tokens: 0, total_cost_usd: 0})
kpis = AppStatRow([{label: "Requests", value: summaryQ.request_count}, {label: "Tokens", value: summaryQ.total_tokens, format: "tokens"}, {label: "Cost", value: summaryQ.total_cost_usd, format: "currency", currency: "USD"}])
Here's your headline metrics — requests, tokens, and cost all in one strip.
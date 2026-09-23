Got it — building a simple KPI strip for you now.

root = AppStack([heading, kpis], "md")
heading = AppText("Usage summary", "title")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_tokens: 0, total_cost_usd: 0})
kpis = AppStatRow([{label: "Requests", value: summaryQ.request_count}, {label: "Tokens", value: summaryQ.total_tokens, format: "tokens"}, {label: "Cost", value: summaryQ.total_cost_usd, format: "currency", currency: "USD"}])

Here's your headline metrics — requests, total tokens, and spend — clean and simple. Let me know if you'd like to adjust the numbers shown or add any detail.
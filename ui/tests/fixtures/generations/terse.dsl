Sure — building that now.
root = AppStack([kpis, table], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0, total_cost_usd: 0, avg_latency_ms: null, period_days: 0})
kpis = AppRow([costCard, tokensCard, requestsCard], "md")
costCard = AppStatCard("Total cost", "$" + @Round(summaryQ.total_cost_usd, 2), null, "neutral")
tokensCard = AppStatCard("Total tokens", @Count(summaryQ.total_tokens), null, "neutral")
requestsCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
agentRows = Query("fetchUsageByAgent", ["", 1, 50], [], "data")
table = AppTable(agentRows, 50, "pages", true)

Here's your spend dashboard with top-level cost/token/request KPIs and an agent usage table — let me know if you'd like to add filters, charts, or drill into specific details!
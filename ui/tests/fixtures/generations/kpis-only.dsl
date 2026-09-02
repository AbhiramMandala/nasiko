Sure — building that now.
root = AppStack([kpis], "md")
summaryQ = Query("fetchUsageSummary", [], 0)
kpis = AppRow([costCard, tokensCard, latencyCard, requestsCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, "neutral")
tokensCard = AppStatCard("Total tokens", summaryQ.total_tokens, "neutral")
latencyCard = AppStatCard("Avg latency", summaryQ.avg_latency_ms, "neutral")
requestsCard = AppStatCard("Requests", summaryQ.request_count, "neutral")
Here's your headline KPI row with cost, tokens, latency, and request count — let me know if you'd like to adjust the metrics or add more detail!
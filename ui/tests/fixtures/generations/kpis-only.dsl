Sure — building that now.
root = AppStack([kpis], "md")
summaryQ = Query("fetchUsageSummary", [], 0)
kpis = AppRow([costCard, tokensCard, latencyCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, "neutral")
tokensCard = AppStatCard("Total tokens", summaryQ.total_tokens, "neutral")
latencyCard = AppStatCard("Avg latency", summaryQ.avg_latency_ms, "neutral")
Here's your headline KPI row with total cost, tokens, and latency — let me know if you'd like to adjust the metrics or layout!
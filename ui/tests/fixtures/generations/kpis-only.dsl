Sure — building that now.
root = AppStack([kpis], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_tokens: 0, total_cost_usd: 0})
kpis = AppRow([requestCard, tokenCard, costCard], "md")
requestCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
tokenCard = AppStatCard("Total tokens", summaryQ.total_tokens, null, "neutral")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
Here's your headline metrics dashboard with requests, tokens, and cost — let me know if you'd like to adjust the KPIs or add any filters!
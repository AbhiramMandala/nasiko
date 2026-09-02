Got it, building your spend dashboard now.
root = AppStack([kpis, spendChart, agentTable], "md")
totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
requestCountQ = Query("fetchUsageSummary", [], 0, "request_count")
totalTokensQ = Query("fetchUsageSummary", [], 0, "total_tokens")
kpis = AppRow([costCard, requestCard, tokenCard], "md")
costCard = AppStatCard("Total cost", totalCostQ, null, "neutral")
requestCard = AppStatCard("Requests", requestCountQ, null, "neutral")
tokenCard = AppStatCard("Total tokens", totalTokensQ, null, "neutral")
historyRows = Query("fetchUsageHistory", [7], [])
spendChart = AppChart({labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}]}, "line", false, "currency", "USD")
agentRows = Query("fetchUsageByAgent", [null, 1, 20], [], "data")
agentTable = AppTable(agentRows, 20, "pages", true)
Here's your spend dashboard with top-level cost/request/token KPIs, a 7-day spend trend, and a paginated agent breakdown — let me know if you'd like to adjust the metrics, add filters, or dive into any specific dimension!
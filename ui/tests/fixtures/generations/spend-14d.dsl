Sure — building that now.
root = AppStack([kpis, chart], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
historyQ = Query("fetchUsageHistory", [14], [])
kpis = AppRow([costCard, requestCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
requestCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}, {label: "Requests", data: historyQ.request_count}]}, "line", false, "number", null)
Here's your spend and request volume dashboard for the last 14 days — two summary KPIs at the top and a trend chart below. Let me know if you'd like to adjust the time window, break it down by agent or model, or add more metrics!
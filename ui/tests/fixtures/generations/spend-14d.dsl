Sure — building that now.
root = AppStack([kpis, chart], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
historyQ = Query("fetchUsageHistory", [14], [])
kpis = AppRow([costCard, requestCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, "neutral")
requestCard = AppStatCard("Requests", summaryQ.request_count, "neutral")
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}, {label: "Requests", data: historyQ.request_count}]}, "line", false, "currency", "USD")
Here's your spend and request volume dashboard with summary KPIs and a 14-day trend chart — let me know if you'd like to adjust the view or add more details!
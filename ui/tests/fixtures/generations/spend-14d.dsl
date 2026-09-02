Sure — building that now.
root = AppStack([kpiRow, chart], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
historyQ = Query("fetchUsageHistory", [14], [])
kpiRow = AppRow([costCard, requestCard], "md")
costCard = AppStatCard("Total cost", summaryQ, null, "neutral")
requestCard = AppStatCard("Total requests", summaryQ, null, "neutral")
chartData = {labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}
chart = AppChart(chartData, "line", false, "currency", "USD")
Here's your 14-day spend and request dashboard with summary KPIs at the top and a cost trend chart below — let me know if you'd like to add request volume to the chart or adjust anything else!
Sure — building that now.
root = AppStack([kpis, chart], "md")
dashboardQ = Query("fetchTokenopsDashboard", [], {})
summaryData = dashboardQ
historyQ = Query("fetchUsageHistory", [14], [])
kpis = AppRow([costCard, opsCard], "md")
costCard = AppStatCard("Total cost (14d)", @Sum(historyQ.total_cost_usd), "neutral")
opsCard = AppStatCard("Total requests (14d)", @Sum(historyQ.request_count), "neutral")
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost", data: historyQ.total_cost_usd}, {label: "Requests", data: historyQ.request_count}]}, "line", false, "number", null)
Here's your 14-day spend and request volume dashboard with a summary row and a dual-axis trend chart — let me know if you'd like to adjust the view or add more metrics!
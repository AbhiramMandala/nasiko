Sure — building that now.
root = AppStack([kpis, table], "md")
summaryQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
historyQ = Query("fetchUsageHistory", [7], [])
kpis = AppRow([costCard, requestsCard], "md")
costCard = AppStatCard("Total cost", summaryQ, "neutral")
requestsCard = AppStatCard("Requests", Query("fetchUsageSummary", [], 0, "request_count"), "neutral")
table = AppTable(historyQ, 30, "pages", false)
Here's your spend dashboard with a cost KPI, request count, and a 7-day history table — let me know if you'd like to add more metrics or adjust the time range!
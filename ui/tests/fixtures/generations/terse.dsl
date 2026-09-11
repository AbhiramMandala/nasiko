Sure — building that now.
root = AppStack([heading, kpis, table], "md")
heading = AppText("Spend overview", "title")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
kpis = AppStatRow([{label: "Total cost", value: summaryQ.total_cost_usd, sub: "all time"}, {label: "Requests", value: summaryQ.request_count}])
historyRows = Query("fetchUsageHistory", [7], [])
table = AppTable(historyRows, 7, "pages", false)
Here's your spend dashboard with a 7-day history table — let me know if you'd like to add charts, filter by agent or model, or adjust the time window!
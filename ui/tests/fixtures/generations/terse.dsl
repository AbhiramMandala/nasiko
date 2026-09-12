Sure — building that now.
root = AppStack([heading, kpis, breakdown], "md")
heading = AppText("Spend overview", "title")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0}, "total_cost_usd")
historyRows = Query("fetchUsageHistory", [7], [])
kpis = AppStatCard("Total spend", summaryQ, null, "neutral", false, "currency", "USD")
breakdown = AppChart({labels: historyRows.date, datasets: [{label: "Cost (USD)", data: historyRows.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend in the last 7 days")
Here's your spend dashboard with a summary card and a 7-day cost trend — let me know if you'd like to add agent or model breakdowns, or adjust the time window!
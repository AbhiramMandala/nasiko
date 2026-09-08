Sure — building that now.

root = AppStack([heading, kpis, spendChart, agentTable], "md")
heading = AppText("Spend overview", "title")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_cost_usd: 0, total_tokens: 0}, null)
kpis = AppStatRow([{label: "Total cost", value: summaryQ.total_cost_usd, sub: "all time"}, {label: "Requests", value: summaryQ.request_count}, {label: "Tokens", value: summaryQ.total_tokens}])
historyRows = Query("fetchUsageHistory", [7], [])
spendChart = AppChart({labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}]}, "line", false, "currency", "USD")
agentRows = Query("fetchUsageByAgent", [null, 1, 50], [], "data")
agentTable = AppTable(agentRows, 50, "pages", false)

Here's your spend dashboard with headline KPIs, a 7-day cost trend, and a table breaking down usage by agent — let me know if you'd like to adjust the time window, add filters, or change what metrics appear!
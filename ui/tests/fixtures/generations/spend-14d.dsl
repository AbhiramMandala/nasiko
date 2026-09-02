Sure — building that now.
root = AppStack([header, chartsRow], "md")
header = AppStack([kpiRow], "md")
kpiRow = AppRow([kpiCost, kpiRequests], "md")
summaryQ = Query("fetchUsageSummary", [], 0)
kpiCost = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
kpiRequests = AppStatCard("Request volume", summaryQ.request_count, null, "neutral")
historyQ = Query("fetchUsageHistory", [14], [])
chartsRow = AppRow([costChart, requestChart], "md")
costChart = AppChart({labels: historyQ.date, datasets: [{label: "Daily cost", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
requestChart = AppChart({labels: historyQ.date, datasets: [{label: "Daily requests", data: historyQ.request_count}]}, "line", false, "number")
Here's your spend and request dashboard with summary KPIs and 14-day trend charts — let me know if you'd like to adjust the timeframe or add more detail!
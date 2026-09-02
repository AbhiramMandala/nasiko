Got it — building your 14-day spend and volume dashboard now.

root = AppStack([kpiRow, historyChart], "md")
summaryQ = Query("fetchUsageSummary", [], 0)
historyQ = Query("fetchUsageHistory", [14], [])
kpiRow = AppRow([costCard, volumeCard], "md")
costCard = AppStatCard("Total cost", summaryQ, null, "neutral")
volumeCard = AppStatCard("Request volume", summaryQ, null, "neutral")
historyChart = AppChart({labels: historyQ.date, datasets: [{label: "Daily cost", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")

Here's your 14-day dashboard with total spend and request volume at the top, plus a line chart showing daily cost over time — let me know if you'd like to break it down by agent or model!
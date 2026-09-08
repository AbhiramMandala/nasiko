Sure — building that now.

root = AppStack([heading, historyChart, historyTable], "md")
heading = AppText("Usage over the last 14 days", "title")
historyRows = Query("fetchUsageHistory", [14], [])
historyChart = AppChart({labels: historyRows.date, datasets: [{label: "Cost (USD)", data: historyRows.total_cost_usd}, {label: "Requests", data: historyRows.request_count}]}, "line", false, "compact")
historyTable = AppTable(historyRows, 14, "pages", false)

Here's your 14-day spend and request volume — a chart showing both metrics over time and a detailed table below. Let me know if you'd like to adjust the view or add more detail!
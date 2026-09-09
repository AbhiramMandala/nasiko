Sure — building that now.
root = AppStack([heading, chart, table], "md")
heading = AppText("Last 14 days", "title")
historyRows = Query("fetchUsageHistory", [14], [])
chart = AppChart({labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}]}, "line", false, "currency", "USD")
table = AppTable(historyRows, 14, "pages", false)
Here's your spend and request volume for the last 14 days — a trend chart showing daily cost and a table with all the detail. Let me know if you'd like anything adjusted!
Sure — building that now.
root = AppStack([heading, chart, table], "md")
heading = AppText("Spend and volume over 14 days", "title")
historyRows = Query("fetchUsageHistory", [14], [])
chart = AppChart({labels: historyRows.date, datasets: [{label: "Cost (USD)", data: historyRows.total_cost_usd}, {label: "Requests", data: historyRows.request_count}]}, "line", false, "currency", "USD")
table = AppTable(historyRows, 14, "pages", false, null, null, "No data for the last 14 days")
Here's your 14-day spend and request volume dashboard with a dual-axis chart and sortable table — let me know if you'd like to adjust the timeframe or add anything else!
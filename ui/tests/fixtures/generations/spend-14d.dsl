Sure — building that now.

root = AppStack([heading, historyChart, historyTable], "md")
heading = AppText("Usage over the last 14 days", "title")
historyRows = Query("fetchUsageHistory", [14], [])
historyChart = AppChart({labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}, {label: "Requests", data: historyRows.request_count}]}, "line", false, "currency", "USD")
historyTable = AppTable(historyRows, 14, "pages", false)

Here's a 14-day spend and request volume dashboard with a dual-axis line chart and a sortable data table — let me know if you'd like to adjust the layout or add any other metrics!
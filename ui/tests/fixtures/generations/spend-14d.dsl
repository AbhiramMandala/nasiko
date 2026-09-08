Sure — building that now.

root = AppStack([title, chartsGrid], "md")
title = AppText("Usage over the last 14 days", "title")
historyRows = Query("fetchUsageHistory", [14], [])
chartsGrid = AppGrid([costChart, requestChart], "1fr 1fr", "md")
costChart = AppChart({labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}]}, "line", false, "currency", "USD")
requestChart = AppChart({labels: historyRows.date, datasets: [{label: "Requests", data: historyRows.request_count}]}, "line", false, "number")

Here's a 14-day trend view with spend and request volume side by side — let me know if you'd like to adjust the layout, add a summary row, or drill into different metrics!
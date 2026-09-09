Sure — building that now.
root = AppStack([heading, charts], "md")
heading = AppText("Usage over the last 14 days", "title")
historyRows = Query("fetchUsageHistory", [14], [])
charts = AppGrid([costChart, volumeChart], "1fr 1fr")
costChart = AppChart({labels: historyRows.date, datasets: [{label: "Spend", data: historyRows.total_cost_usd}]}, "line", false, "currency", "USD")
volumeChart = AppChart({labels: historyRows.date, datasets: [{label: "Requests", data: historyRows.request_count}]}, "line", false, "number")
Here's a side-by-side view of your spend and request volume over the last two weeks — let me know if you'd like to adjust the time window or add more detail!
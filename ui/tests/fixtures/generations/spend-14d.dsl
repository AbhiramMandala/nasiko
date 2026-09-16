Sure — building that now.
root = AppStack([heading, spendChart, volumeChart], "md")
heading = AppText("Usage over the last 14 days", "title")
historyQ = Query("fetchUsageHistory", [14], [{date: "", total_cost_usd: 0, request_count: 0}])
spendChart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data for this period")
volumeChart = AppChart({labels: historyQ.date, datasets: [{label: "Requests", data: historyQ.request_count}]}, "line", false, "number", null, null, null, "auto", "No request data for this period")

Here's your 14-day spend and request volume dashboard with two trend lines — let me know if you'd like to adjust the time window or add any other metrics!
Sure — building that now.
root = AppStack([header, charts], "md")
header = AppRow([titleCard], "md")
titleCard = AppCard(null, "Usage over 14 days")
charts = AppRow([costChart, requestChart], "md")
historyQ = Query("fetchUsageHistory", [14], [])
costChart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
requestChart = AppChart({labels: historyQ.date, datasets: [{label: "Requests", data: historyQ.request_count}]}, "line", false, "number")
Here's a 14-day spend and request volume dashboard with two trend charts — let me know if you'd like to adjust the layout, add KPI cards, or drill down further!
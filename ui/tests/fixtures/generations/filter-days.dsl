Sure — building that now.
root = AppStack([rangeRow, chart], "md")
$days = 7
rangeRow = AppRow([sevenBtn, thirtyBtn], "sm")
sevenBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, showSeven)
thirtyBtn = AppButton("30 days", "primary", null, null, null, null, null, null, null, null, showThirty)
showSeven = Action([@Set($days, 7), @Run(historyQ)])
showThirty = Action([@Set($days, 30), @Run(historyQ)])
historyQ = Query("fetchUsageHistory", [$days], [])
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
Here's your history dashboard with a cost chart and toggle buttons for 7 and 30 day views — let me know if you'd like to adjust the timeframe options, add more metrics, or change the chart style!
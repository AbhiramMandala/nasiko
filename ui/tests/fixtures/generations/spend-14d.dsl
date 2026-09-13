Sure — building that now.

root = AppStack([heading, rangeRow, chartsGrid], "md")
heading = AppText("Usage over time", "title")
$range = "7d"
rangeRow = AppRow([sevenBtn, fourteenBtn, thirtyBtn], "sm")
sevenBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, selectSeven)
fourteenBtn = AppButton("14 days", "primary", null, null, null, null, null, null, null, null, selectFourteen)
thirtyBtn = AppButton("30 days", "secondary", null, null, null, null, null, null, null, null, selectThirty)
selectSeven = Action([@Set($range, "7d"), @Run(historyQ)])
selectFourteen = Action([@Set($range, "14d"), @Run(historyQ)])
selectThirty = Action([@Set($range, "30d"), @Run(historyQ)])
historyQ = Query("fetchUsageHistory", [14], [])
costChart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
requestChart = AppChart({labels: historyQ.date, datasets: [{label: "Requests", data: historyQ.request_count}]}, "line", false, "compact")
chartsGrid = AppGrid([costChart, requestChart], "1fr 1fr")

Here's your usage dashboard with cost and request volume over the last 14 days, plus range buttons to explore 7, 14, or 30-day windows — let me know if you'd like to adjust the view!
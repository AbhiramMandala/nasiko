Sure — building that now.
root = AppStack([heading, dateToggle, chartsGrid], "md")
heading = AppText("Usage over time", "title")
$range = "7d"
dateToggle = AppRow([sevenDayBtn, fourteenDayBtn], "sm")
sevenDayBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, showSeven)
fourteenDayBtn = AppButton("14 days", "primary", null, null, null, null, null, null, null, null, showFourteen)
showSeven = Action([@Set($range, "7d"), @Run(historyData)])
showFourteen = Action([@Set($range, "30d"), @Run(historyData)])
historyData = Query("fetchUsageHistory", [14], [])
spendChart = AppChart({labels: historyData.date, datasets: [{label: "Spend (USD)", data: historyData.total_cost_usd}]}, "line", false, "currency", "USD")
volumeChart = AppChart({labels: historyData.date, datasets: [{label: "Requests", data: historyData.request_count}]}, "line", false, "number")
chartsGrid = AppGrid([spendChart, volumeChart])

Here's your 14-day spend and request volume dashboard with toggle controls — let me know if you'd like to adjust the timeframe, add filters, or change the chart types!
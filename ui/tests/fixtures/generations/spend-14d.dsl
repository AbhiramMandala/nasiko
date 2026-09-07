Sure — building that now.
root = AppStack([header, chartRow, table], "md")
header = AppRow([titleSpacer, dateRange], "md", "center")
titleSpacer = AppStack([], "md")
dateRange = AppRow([sevenBtn, fourteenBtn, thirtyBtn], "sm")
sevenBtn = AppButton("7 days", "secondary")
fourteenBtn = AppButton("14 days", "primary")
thirtyBtn = AppButton("30 days", "secondary")
$days = 14
historyQ = Query("fetchUsageHistory", [$days], [])
chartRow = AppRow([costChart, volumeChart], "md")
costChart = AppChart({labels: historyQ.date, datasets: [{label: "Cost", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
volumeChart = AppChart({labels: historyQ.date, datasets: [{label: "Requests", data: historyQ.request_count}]}, "line", false, "number")
table = AppTable(historyQ, 14, "pages", false)
Here's your 14-day spend and request volume dashboard with trend charts and a detailed history table — let me know if you'd like to adjust the time range or add any other metrics!
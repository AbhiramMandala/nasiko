Sure — building that now.
root = AppStack([header, chart, table], "md")
header = AppRow([title, rangeRow], "md", "center", "between")
title = AppCard(null, "Usage by Model")
$days = 7
rangeRow = AppRow([sevenBtn, thirtyBtn], "sm")
sevenBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, showSeven)
thirtyBtn = AppButton("30 days", "primary", null, null, null, null, null, null, null, null, showThirty)
showSeven = Action([@Set($days, 7), @Run(modelDataQ)])
showThirty = Action([@Set($days, 30), @Run(modelDataQ)])
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartData = {labels: modelDataQ.model, datasets: [{label: "Total Cost (USD)", data: modelDataQ.total_cost_usd}]}
chart = AppChart(chartData, "bar", false, "currency", "USD")
table = AppTable(modelDataQ, 50, "pages", true)
Here's your usage-by-model dashboard with a 7-day bar chart and searchable table — let me know if you'd like to adjust the time range, add more metrics, or change the chart type!
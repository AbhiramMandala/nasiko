Sure — building that now.
root = AppStack([header, chart, table], "md")
header = AppRow([title], "md")
title = AppStatCard("Usage by Model", null, null, "neutral")
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartData = {labels: modelDataQ.model, datasets: [{label: "Total Cost (USD)", data: modelDataQ.total_cost_usd}]}
chart = AppChart(chartData, "bar", false, "currency", "USD")
table = AppTable(modelDataQ, 50, "pages", true)
Here's a usage-by-model dashboard with a bar chart showing cost across models and a searchable table below — let me know if you'd like to adjust the chart type, add more metrics, or change anything else!
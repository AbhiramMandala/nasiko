Sure — building that now.
root = AppStack([header, chart, table], "md")
header = AppRow([title], "md")
title = AppStatCard("Model Usage", null, null, "neutral")
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], {data: [], total: 0}, "data")
chartData = {labels: modelDataQ.model, datasets: [{label: "Cost (USD)", data: modelDataQ.total_cost_usd}]}
chart = AppChart(chartData, "bar", false, "currency", "USD")
table = AppTable(modelDataQ, 50, "pages", false)
Here's your model usage dashboard with a bar chart showing cost by model and a detailed table below — let me know if you'd like to add filters, change the chart type, or adjust anything else!
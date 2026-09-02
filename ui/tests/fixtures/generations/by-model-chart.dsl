Sure — building that now.
root = AppStack([header, chartSection, tableSection], "md")
header = AppRow([title], "md")
title = AppStatCard("Usage by Model", null, null, "neutral")
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartDataQ = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartSection = AppStack([chart], "md")
chart = AppChart({labels: chartDataQ.model, datasets: [{label: "Total Cost (USD)", data: chartDataQ.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppStack([table], "md")
table = AppTable(modelDataQ, 50, "pages", true)
Here's a usage-by-model dashboard with a bar chart showing cost per model and a sortable table below — let me know if you'd like to adjust the chart type, add more metrics, or filter the data!
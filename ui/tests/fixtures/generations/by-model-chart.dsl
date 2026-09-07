Sure — building that now.
root = AppStack([header, chartSection, tableSection], "md")
header = AppRow([title], "md")
title = AppStatCard("Usage by Model", null, null, "neutral")
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], {data: [], total: 0}, "data")
chartSection = AppCard(null, "Cost Distribution by Model")
chartData = AppChart({labels: modelDataQ.model, datasets: [{label: "Total Cost (USD)", data: modelDataQ.total_cost_usd}]}, "donut", false, "currency", "USD")
chartContainer = AppStack([chartData], "md")
chartSection = AppCard([chartContainer], "Cost Distribution by Model")
tableSection = AppCard([modelTable], "Usage by Model")
modelTable = AppTable(modelDataQ, 50, "pages", false, null, false, "No model data available")
Here's your usage-by-model dashboard with a donut chart showing cost distribution and a sortable table below — let me know if you'd like filters, different chart types, or additional metrics!
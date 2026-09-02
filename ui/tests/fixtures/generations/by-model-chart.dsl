Got it — building a usage-by-model dashboard with a chart now.

root = AppStack([header, chartSection, tableSection], "md")
header = AppRow([title], "md")
title = AppStatCard("Usage by Model", null, null, "neutral")
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartSection = AppCard(null, "Cost & Token Distribution")
chartRow = AppRow([costChart, tokenChart], "md")
costChart = AppChart({labels: modelDataQ.model, datasets: [{label: "Cost (USD)", data: modelDataQ.total_cost_usd}]}, "bar", false, "currency", "USD")
tokenChart = AppChart({labels: modelDataQ.model, datasets: [{label: "Total Tokens", data: modelDataQ.total_tokens}]}, "bar", false, "compact")
tableSection = AppTable(modelDataQ, 50, "pages", true)

Here's your usage-by-model dashboard with a cost bar chart, token distribution chart, and a sortable table below — let me know if you'd like filters, different chart types, or any other adjustments!
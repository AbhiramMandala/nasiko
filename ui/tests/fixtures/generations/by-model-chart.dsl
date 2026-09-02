Sure — building that now.
root = AppStack([header, chart, table], "md")
header = AppRow([titleCard], "md")
titleCard = AppCard(null, "Usage by Model")
modelQ = Query("fetchUsageByModel", [null, 1, 20], [], "data")
modelSummary = Query("fetchUsageByModel", [null, 1, 100], [], "data")
chart = AppChart({labels: modelSummary.model, datasets: [{label: "Total Cost (USD)", data: modelSummary.total_cost_usd}]}, "bar", false, "currency", "USD")
table = AppTable(modelQ, 20, "pages", true)
Here's a usage-by-model dashboard with a cost breakdown chart and a paginated table — let me know if you'd like to filter, adjust the chart type, or add more metrics!
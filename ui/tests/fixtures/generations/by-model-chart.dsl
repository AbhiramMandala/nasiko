Sure — building that now.
root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
modelUsageQ = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartSection = AppCard([chart], "usage-chart")
chart = AppChart({labels: modelUsageQ.model, datasets: [{label: "Cost (USD)", data: modelUsageQ.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([table], "usage-table")
table = AppTable(modelUsageQ, 50, "pages", true)
Here's your usage-by-model dashboard with a bar chart showing cost per model and a searchable table below — let me know if you'd like to adjust the chart type, add more metrics, or change anything else!
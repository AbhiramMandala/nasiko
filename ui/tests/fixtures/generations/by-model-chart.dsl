Sure — building that now.

root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
chartSection = AppCard([usageChart], "Usage distribution")
usageChart = AppChart({labels: modelRows.model, datasets: [{label: "Cost (USD)", data: modelRows.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([modelTable], "Model details")
modelRows = Query("fetchUsageByModel", ["", 1, 50], [], "data")
modelTable = AppTable(modelRows, 50, "pages", true, "Search models...", false, "No models have been used yet")

Here's your usage-by-model dashboard with a cost distribution chart and a searchable table — let me know if you'd like to adjust the layout or add any other metrics!
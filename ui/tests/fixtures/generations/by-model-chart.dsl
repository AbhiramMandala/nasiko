Sure — building that now.

root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
chartSection = AppCard([modelChart], null, null, null, null, null, false)
modelRows = Query("fetchUsageByModel", ["", 1, 100], [], "data")
modelChart = AppChart({labels: modelRows.model, datasets: [{label: "Cost", data: modelRows.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([modelTable], null, null, null, null, null, false)
modelTable = AppTable(modelRows, 100, "pages", true)

Here's your usage-by-model dashboard with a cost bar chart and a detailed table below — let me know if you'd like to adjust the chart type, add more metrics, or filter by date range!
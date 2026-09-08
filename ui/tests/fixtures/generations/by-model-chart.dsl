Sure — building that now.

root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
modelRows = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartSection = AppCard([costChart], "Cost distribution")
costChart = AppChart({labels: modelRows.model, datasets: [{label: "Cost", data: modelRows.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([table], "Model details")
table = AppTable(modelRows, 50, "pages", true)

Here's your usage-by-model dashboard with a cost distribution chart and a searchable table — let me know if you'd like to add more metrics or adjust the layout!
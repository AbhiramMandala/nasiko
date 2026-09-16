Got it — building a usage breakdown by model with a chart now.

root = AppStack([heading, modelChart, modelTable], "md")
heading = AppText("Usage by model", "title")
modelRows = Query("fetchUsageByModel", ["", 1, 50], [], "data")
modelChart = AppChart({labels: modelRows.model, datasets: [{label: "Cost (USD)", data: modelRows.total_cost_usd}]}, "bar", false, "currency", "USD", null, null, "auto", "No model usage in this period")
modelTable = AppTable(modelRows, 50, "pages", false, null, null, "No model usage in this period")

Here's your usage breakdown by model with a bar chart showing cost across providers and a sortable table underneath — let me know if you'd like to adjust the view or add filters!
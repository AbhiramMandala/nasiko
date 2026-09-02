Sure — building that now.
root = AppStack([modelChart, modelTable], "md")
modelDataQ = Query("fetchUsageByModel", [null, 1, 50], {data: [], total: 0}, "data")
modelChart = AppChart({labels: modelDataQ.model, datasets: [{label: "Cost (USD)", data: modelDataQ.total_cost_usd}]}, "bar", false, "currency", "USD")
modelTable = AppTable(modelDataQ, 50, "pages", false)
Here's your usage-by-model dashboard with a cost chart and a detailed table below — let me know if you'd like to filter, search, or adjust the layout!
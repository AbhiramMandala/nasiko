Sure — building that now.
root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], {data: [], total: 0}, "data")
chartSection = AppCard([chart], "Distribution")
chart = AppChart({labels: modelDataQ.model, datasets: [{label: "Cost (USD)", data: modelDataQ.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([table], "Details")
table = AppTable(modelDataQ, 50, "pages", true)
Here's your usage-by-model dashboard with a cost distribution chart and a searchable table below — let me know if you'd like to adjust the layout or add more metrics!
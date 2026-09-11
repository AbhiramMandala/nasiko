Sure — building that now.
root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], {data: [], total: 0}, "data")
chartSection = AppCard([chart], null, null, null, null, null, false)
chart = AppChart({labels: modelDataQ.model, datasets: [{label: "Cost (USD)", data: modelDataQ.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([table], null, null, null, null, null, false)
table = AppTable(modelDataQ, 50, "pages", false, null, false, "No usage data found")
Here's your usage-by-model dashboard with a cost chart and a detailed table — let me know if you'd like to adjust the layout or add filters!
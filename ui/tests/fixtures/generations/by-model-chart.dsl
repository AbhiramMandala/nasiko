Sure — building that now.
root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
modelDataQ = Query("fetchUsageByModel", [null, 1, 50], {data: [], total: 0}, "data")
chartSection = AppCard([chart], "Usage distribution")
chart = AppChart({labels: modelDataQ.model, datasets: [{label: "Total cost", data: modelDataQ.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([table], "Model details")
table = AppTable(modelDataQ, 50, "pages", false)
Here's your usage-by-model dashboard with a bar chart showing cost distribution and a detailed table below — let me know if you'd like to adjust the chart type, add filters, or highlight different metrics!
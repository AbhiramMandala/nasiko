Sure — building that now.
root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
modelQ = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartSection = AppCard([chart], "Usage distribution")
chart = AppChart({labels: modelQ.model, datasets: [{label: "Total cost (USD)", data: modelQ.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([table], "Models")
table = AppTable(modelQ, 50, "pages", false)
Here's your usage-by-model dashboard with a cost distribution bar chart and a detailed table below — let me know if you'd like to add filters, change the view, or adjust anything else!
Sure — building that now.
root = AppStack([heading, chartSection, tableSection], "md")
heading = AppText("Usage by model", "title")
modelDataQ = Query("fetchUsageByModel", ["", 1, 50], [], "data")
chartSection = AppCard([usageChart], "Model breakdown")
usageChart = AppChart({labels: modelDataQ.model, datasets: [{label: "Cost (USD)", data: modelDataQ.total_cost_usd}]}, "bar", false, "currency", "USD")
tableSection = AppCard([usageTable], "Detailed usage")
usageTable = AppTable(modelDataQ, 50, "pages", false, "Search models...", false, "No usage data for the selected period")
Here's your usage by model dashboard with a cost breakdown chart and a detailed table — let me know if you'd like to filter by time range, add different metrics, or adjust the layout!
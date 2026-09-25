Got it — building a spend dashboard for a specific model with search.

root = AppStack([heading, controls, chart, table], "md")
heading = AppText("Model spend", "title")
$modelQuery = ""
searchBox = AppSearch("md", null, false, false, "Search models...", $modelQuery, null, null, null, null, null, runSearch)
runSearch = Action([@Set($modelQuery, $event), @Run(spendQ)])
spendQ = Query("fetchSpendTimeseries", [{range: "7d", model: $modelQuery}], {points: []})
chart = AppChart({labels: spendQ.points.bucket_start, datasets: [{label: "Spend (USD)", data: spendQ.points.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data for this model in the last 7 days")
modelRows = Query("fetchUsageByModel", [$modelQuery, 1, 50], [], "data")
table = AppTable(modelRows, 50, "pages", false, null, null, "No usage found for this model")

Here's your model spend dashboard with a 7-day trend line and usage table — search for the model name to update both charts. Let me know if you'd like to adjust the layout or add more metrics!
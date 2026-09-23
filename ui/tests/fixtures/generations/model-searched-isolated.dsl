Building that now.

root = AppStack([heading, controls, contentGrid], "md")
heading = AppText("Spend by model", "title")
$modelQuery = ""
modelSearch = AppSearch("md", null, false, false, "Search models...", $modelQuery, null, null, null, null, null, setModel)
setModel = Action([@Set($modelQuery, $event), @Run(spendQ)])
controls = AppRow([modelSearch], "md")
spendQ = Query("fetchSpendTimeseries", [{range: "7d", model: $modelQuery}], {points: []}, "data.points")
spendChart = AppChart({labels: spendQ.bucket_start, datasets: [{label: "Spend (USD)", data: spendQ.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend in the last 7 days for this model")
spendSummary = AppStatCard("Total spend", @Sum(spendQ.spend_usd), null, "neutral", false, "currency", "USD")
contentGrid = AppGrid([spendChart, spendSummary], "2fr 1fr", "md")

Here's a spend dashboard for the last 7 days filtered by model name — the search box reloads the data with each model you select. Let me know if you'd like to adjust the layout or add more metrics!
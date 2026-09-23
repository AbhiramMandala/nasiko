Got it — building a spend dashboard for a single model with a search to find it.

root = AppStack([heading, controls, spendSection], "md")
heading = AppText("Model spend", "title")
$modelSearch = ""
setModel = Action([@Set($modelSearch, $event)])
searchBox = AppSearch("md", null, false, false, "Search models...", $modelSearch, null, null, null, null, null, setModel)
controls = AppRow([searchBox], "md")
timeseriesQ = Query("fetchSpendTimeseries", [{range: "7d", model: $modelSearch}], {data: {points: []}}, "data")
spendChart = AppChart({labels: timeseriesQ.points.bucket_start, datasets: [{label: "Spend (USD)", data: timeseriesQ.points.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data for this model in the last 7 days")
totalSpend = @Sum(timeseriesQ.points.spend_usd)
spendCard = AppStatCard("Total spend", totalSpend, null, "neutral", false, "currency", "USD")
spendSection = AppStack([spendCard, spendChart], "md")

Here's a model spend dashboard with a 7-day trend line, total cost card, and a search box to find the model by name — let me know if you'd like to adjust the layout or add more metrics!
Sure — building that now.
root = AppStack([heading, controls, chart, table], "md")
heading = AppText("Spend by model", "title")
$modelSearch = ""
searchBox = AppSearch("md", null, false, false, "Search models...", $modelSearch, null, null, null, null, null, runSearch)
runSearch = Action([@Set($modelSearch, $event)])
controls = AppRow([searchBox], "md")
spendQ = Query("fetchSpendTimeseries", [{range: "7d"}], {data: {points: []}}, "data")
filteredSpend = @Filter(spendQ.points, "top_agent_name", "contains", $modelSearch)
chart = AppChart({labels: filteredSpend.bucket_start, datasets: [{label: "Spend (USD)", data: filteredSpend.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data for this period")
table = AppTable(filteredSpend, 25, "pages", false, null, null, "No spend data for this period")
Here's a 7-day spend view with a search box to filter by model — the line chart shows the trend and the table below has the details. Let me know if you'd like to adjust the layout or add any other metrics!
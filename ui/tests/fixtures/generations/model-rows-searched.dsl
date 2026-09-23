Sure — building that now.

root = AppStack([heading, controls, table], "md")
heading = AppText("Cost per agent by model", "title")
$modelSearch = ""
searchBox = AppSearch("md", null, false, false, "Search models...", $modelSearch, null, null, null, null, null, updateSearch)
updateSearch = Action([@Set($modelSearch, $event), @Run(attributionsQ)])
controls = AppRow([searchBox], "md")
attributionsQ = Query("fetchFinopsAttributions", [{range: "7d", model: $modelSearch}], {rows: []}, "data")
agentRows = @Sort(attributionsQ.rows, "total_cost", "desc")
table = AppTable(agentRows, 25, "pages", false, null, null, "No agents found for that model")

Here's your cost-per-agent table filtered by model name with a search box — let me know if you'd like to adjust the time window, add more columns, or change the sorting!
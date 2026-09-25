Got it — building that for you now.

root = AppStack([heading, controls, table], "md")
heading = AppText("Cost per agent by model", "title")
$modelSearch = ""
setModel = Action([@Set($modelSearch, $event), @Run(rowsQ)])
searchBox = AppSearch("md", null, false, false, "Search models...", $modelSearch, null, null, null, null, null, setModel)
searchField = AppField([searchBox], "Model")
controls = AppRow([searchField], "md")
rowsQ = Query("fetchFinopsAttributions", [{range: "7d", view: "agent"}], {rows: []}, "data")
filteredRows = @Filter(rowsQ.rows, "agent_name", "contains", $modelSearch)
table = AppTable(filteredRows, 25, "pages", false, null, null, "No agents match that model filter")

Here's a 7-day agent cost table with a model search box — let me know if you'd like to adjust the columns, add a chart above it, or filter by a different field!
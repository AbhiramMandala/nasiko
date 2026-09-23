Sure — building that now.

root = AppStack([heading, controls, agentTable], "md")
heading = AppText("My usage by agent", "title")
$agentSearch = ""
searchBox = AppSearch("md", null, false, false, "Search agents...", $agentSearch, null, null, null, null, null, setSearch)
setSearch = Action([@Set($agentSearch, $event)])
agentRowsQ = Query("fetchUsageByAgent", [$agentSearch, 1, 20], {data: [], total: 0}, "data")
controls = AppRow([searchBox], "md")
filteredRows = @Filter(agentRowsQ, "agent_name", "contains", $agentSearch)
agentTable = AppTable(filteredRows, 20, "pages", false, null, null, "No agents match that search")
totalCount = AppStatCard("Total agents", @Count(agentRowsQ) + @Count(filteredRows) > 0 ? agentRowsQ.total : 0)
root = AppStack([heading, totalCount, controls, agentTable], "md")

Here's your agent usage breakdown with a search box, pagination at 20 rows per page, and a card showing the total agent count — let me know if you'd like any adjustments!
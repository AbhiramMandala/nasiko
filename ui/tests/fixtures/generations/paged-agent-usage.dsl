Sure — building that now.

root = AppStack([heading, controls, stats, table], "md")
heading = AppText("My usage by agent", "title")
$agentSearch = ""
searchBox = AppSearch("md", null, false, false, "Search agents...", $agentSearch, null, null, null, null, null, runSearch)
runSearch = Action([@Set($agentSearch, $event)])
controls = AppRow([searchBox], "md")
agentQ = Query("fetchUsageHistory", [7], [])
agentRows = @Filter(agentQ, "agent_name", "contains", $agentSearch)
totalCount = @Count(agentRows)
stats = AppStatCard("Total agents", totalCount)
table = AppTable(agentRows, 20, "pages", false, null, null, "No agents match that search")

Here's your agent usage breakdown with a search box, total agent count, and 20-row pagination — let me know if you'd like to adjust the time window or add any other metrics!
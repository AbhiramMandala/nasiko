Sure — building that now.

root = AppStack([headerRow, table], "md")
$days = 7
$query = ""
headerRow = AppRow([rangeButtons, searchBox], "md", "center", "between")
rangeButtons = AppRow([sevenBtn, thirtyBtn, ninetyBtn], "sm")
sevenBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, setSeven)
thirtyBtn = AppButton("30 days", "secondary", null, null, null, null, null, null, null, null, setThirty)
ninetyBtn = AppButton("90 days", "secondary", null, null, null, null, null, null, null, null, setNinety)
setSeven = Action([@Set($days, 7), @Run(agentRows)])
setThirty = Action([@Set($days, 30), @Run(agentRows)])
setNinety = Action([@Set($days, 90), @Run(agentRows)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $query, null, null, null, null, null, runSearch)
runSearch = Action([@Set($query, $event), @Run(agentRows)])
agentRows = Query("fetchUsageByAgent", [$query, 1, 20], [], "data")
table = AppTable(agentRows, 20, "pages", true)

Here's your cost dashboard with a 7/30/90-day window selector and agent search — let me know if you'd like to add KPI cards, change the table columns, or adjust anything else!
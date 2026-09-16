Sure — building that now.

root = AppStack([controls, table], "md")
$days = "7"
$search = ""
daysControl = AppSegmentedControl([{value: "7", label: "7 days"}, {value: "30", label: "30 days"}, {value: "90", label: "90 days"}], $days, "md", false, null, "Time range", null, setDays)
setDays = Action([@Set($days, $event), @Run(historyQ)])
searchBox = AppSearch("md", null, false, false, "Search dates...", $search, null, null, null, null, null, setSearch)
setSearch = Action([@Set($search, $event)])
controlRow = AppRow([daysControl, searchBox], "md")
controls = AppToolbar([Slot("start", controlRow)], "Usage history filters")
historyQ = Query("fetchUsageHistory", [$days], [])
filtered = @Filter(historyQ, "date", "contains", $search)
table = AppTable(filtered, 30, "pages", false, null, null, "No usage data in this period")

Here's your daily usage history table with a time-range switcher and search filter — let me know if you'd like to adjust the layout or add any additional columns!
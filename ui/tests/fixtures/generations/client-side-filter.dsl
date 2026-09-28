Sure — building that now.

root = AppStack([heading, controls, table], "md")
heading = AppText("Daily usage history", "title")
$days = "7"
$search = ""
daysControl = AppSegmentedControl([{value: "7", label: "7 days"}, {value: "30", label: "30 days"}, {value: "90", label: "90 days"}], $days, "md", false, null, "Time range", null, changeDays)
changeDays = Action([@Set($days, $event), @Run(historyQ)])
searchBox = AppSearch("md", null, false, false, "Search by date...", $search, null, null, null, null, null, changeSearch)
changeSearch = Action([@Set($search, $event)])
controls = AppRow([daysControl, searchBox], "md")
historyQ = Query("fetchUsageHistory", [$days], [])
filtered = @Filter(historyQ, "date", "contains", $search)
table = AppTable(filtered, 30, "pages", false, null, null, "No usage history for this period")

Here's your daily usage history table with a 7/30/90 day toggle and a search box to narrow rows by date — let me know if you'd like to adjust the layout or add more detail!
Sure — building that now.

root = AppStack([heading, controls, table], "md")
heading = AppText("TokenOps usage", "title")
$agent = ""
$range = "7d"
setAgent = Action([@Set($agent, $event)])
setRange = Action([@Set($range, $event), @Run(rowsQ)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $agent, null, null, null, null, null, setAgent)
searchField = AppField([searchBox], "Agent")
rangePicker = AppSegmentedControl([{value: "24h", label: "24h"}, {value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $range, "md", false, null, "Time range", null, setRange)
rangeField = AppField([rangePicker], "Range")
controlRow = AppRow([searchField, rangeField], "md", "end", "start", null, true)
controls = AppToolbar([Slot("start", controlRow)], "TokenOps usage filters")
filtered = @Filter(rowsQ.attributions.rows, "agent_name", "contains", $agent)
table = AppTable(filtered, 25, "pages", false, null, null, "No agents match that filter")

Here's your TokenOps usage table with agent search and time-range filters grouped in a toolbar above it — let me know if you'd like to adjust the layout or add more columns!
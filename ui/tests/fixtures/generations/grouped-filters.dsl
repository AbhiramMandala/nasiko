Sure — building that now.
root = AppStack([heading, controls, table], "md")
heading = AppText("TokenOps usage", "title")
$agentFilter = ""
$rangeFilter = "7d"
setAgent = Action([@Set($agentFilter, $event)])
setRange = Action([@Set($rangeFilter, $event), @Run(dashboardQ)])
agentSearch = AppSearch("md", null, false, false, "Search agents...", $agentFilter, null, null, null, null, null, setAgent)
agentField = AppField([agentSearch], "Agent")
rangePicker = AppSegmentedControl([{value: "24h", label: "24h"}, {value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $rangeFilter, "md", false, null, "Time range", null, setRange)
rangeField = AppField([rangePicker], "Range")
controlRow = AppRow([agentField, rangeField], "md", "end", "start", null, true)
controls = AppToolbar([Slot("start", controlRow)], "TokenOps usage filters")
dashboardQ = Query("fetchTokenopsDashboard", [{range: $rangeFilter}], {attributions: {rows: []}}, "data")
filtered = @Filter(dashboardQ.attributions.rows, "agent_name", "contains", $agentFilter)
table = AppTable(filtered, 25, "pages", false, null, null, "No agents match that filter")
Here's your TokenOps usage dashboard with agent and date-range filters grouped in a toolbar above the table — let me know if you'd like to adjust the layout or add any metrics!
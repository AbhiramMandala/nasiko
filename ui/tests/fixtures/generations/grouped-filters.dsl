Sure — building that now.

root = AppStack([heading, controls, agentTable], "md")
heading = AppText("TokenOps usage", "title")
$agentFilter = ""
$modelFilter = ""
$rangeFilter = "7d"
setAgent = Action([@Set($agentFilter, $event), @Run(dashboardQ)])
setModel = Action([@Set($modelFilter, $event), @Run(dashboardQ)])
setRange = Action([@Set($rangeFilter, $event), @Run(dashboardQ)])
agentSearch = AppSearch("md", null, false, false, "Search agents...", $agentFilter, null, null, null, null, null, setAgent)
agentField = AppField([agentSearch], "Agent")
modelSearch = AppSearch("md", null, false, false, "Search models...", $modelFilter, null, null, null, null, null, setModel)
modelField = AppField([modelSearch], "Model")
rangePicker = AppSegmentedControl([{value: "24h", label: "24h"}, {value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $rangeFilter, "md", false, null, "Time range", null, setRange)
rangeField = AppField([rangePicker], "Range")
controlRow = AppRow([agentField, modelField, rangeField], "md", "end", "start", null, true)
controls = AppToolbar([Slot("start", controlRow)], "TokenOps usage filters")
dashboardQ = Query("fetchTokenopsDashboard", [{range: $rangeFilter, model: $modelFilter, agentId: $agentFilter}], {attributions: {rows: []}}, "data")
agentTable = AppTable(dashboardQ.attributions.rows, 25, "pages", false, null, null, "No usage data for the selected filters")

Here's your TokenOps usage dashboard with agent, model, and date range filters above a paginated table — let me know if you'd like to adjust the layout or add any metrics!
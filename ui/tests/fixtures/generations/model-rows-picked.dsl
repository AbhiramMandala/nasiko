Sure — building that now.

root = AppStack([heading, modelPicker, table], "md")
heading = AppText("Cost per agent", "title")
$model = "claude-sonnet-4-5"
modelPicker = AppSegmentedControl([{value: "claude-sonnet-4-5", label: "Sonnet"}, {value: "claude-haiku-4-5", label: "Haiku"}, {value: "claude-opus-4-1", label: "Opus"}], $model, "md", false, null, "Model", null, pickModel)
pickModel = Action([@Set($model, $event), @Run(agentCostQ)])
agentCostQ = Query("fetchFinopsAttributions", [{range: "7d", model: $model, view: "agent", sortBy: "cost", sortDir: "desc"}], {rows: []}, "data")
table = AppTable(agentCostQ.rows, 50, "pages", false, null, null, "No agent usage for this model in the last 7 days")

Here's your agent cost table with a model switcher — the table updates whenever you pick a different model. Let me know if you'd like to adjust the sorting, add more detail, or filter further!
Sure — building that now.

root = AppStack([heading, modelPicker, table], "md")
heading = AppText("Cost per agent", "title")
$model = "claude-sonnet-4-5"
modelPicker = AppSegmentedControl([{value: "claude-sonnet-4-5", label: "Sonnet"}, {value: "claude-haiku-4-5", label: "Haiku"}, {value: "claude-opus-4-1", label: "Opus"}], $model, "md", false, null, "Model", null, selectModel)
selectModel = Action([@Set($model, $event), @Run(costQ)])
costQ = Query("fetchFinopsAttributions", [{range: "7d", model: $model, view: "agent"}], {rows: []}, "data")
table = AppTable(costQ.rows, 25, "pages", false, null, null, "No agents used this model in the last 7 days")

Here's a cost table by agent with a model picker — switch between the three models to see how spend breaks down. Let me know if you'd like to add a chart, filters, or anything else!
Sure — building that now.

root = AppStack([heading, controls, chart], "md")
heading = AppText("Spend over the last 7 days", "title")
$model = "claude-sonnet-4-5"
modelPicker = AppSegmentedControl([{value: "claude-sonnet-4-5", label: "Sonnet"}, {value: "claude-haiku-4-5", label: "Haiku"}, {value: "claude-opus-4-1", label: "Opus"}], $model, "md", false, null, "Model", null, selectModel)
selectModel = Action([@Set($model, $event), @Run(spendQ)])
controls = AppRow([modelPicker], "md")
spendQ = Query("fetchSpendTimeseries", [{range: "7d", model: $model}], {data: {points: []}}, "data.points")
chart = AppChart({labels: spendQ.bucket_start, datasets: [{label: "Spend (USD)", data: spendQ.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data for this model in the last 7 days")

Here's a 7-day spend chart with a model picker — select any of the three models to see its trend. Let me know if you'd like to adjust the layout or add more details!
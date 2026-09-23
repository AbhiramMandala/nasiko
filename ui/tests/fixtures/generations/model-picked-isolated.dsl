Sure — building that now.

root = AppStack([heading, controls, chart, table], "md")
heading = AppText("Spend over the last 7 days", "title")
$model = "claude-sonnet-4-5"
modelPicker = AppSegmentedControl([{value: "claude-sonnet-4-5", label: "Sonnet 4.5"}, {value: "claude-haiku-4-5", label: "Haiku 4.5"}, {value: "claude-opus-4-1", label: "Opus 4.1"}], $model, "md", false, null, "Model", null, selectModel)
selectModel = Action([@Set($model, $event), @Run(seriesQ)])
controls = AppRow([modelPicker], "md")
seriesQ = Query("fetchSpendTimeseries", [{range: "7d", model: $model}], {points: []}, "data")
chart = AppChart({labels: seriesQ.points.bucket_start, datasets: [{label: "Spend (USD)", data: seriesQ.points.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend for this model in the last 7 days")
table = AppTable(seriesQ.points, 50, "pages", false, null, null, "No spend for this model in the last 7 days")

Here's a spend dashboard for the last 7 days with a model selector — the line chart shows the trend and the table below has the day-by-day breakdown. Let me know if you'd like to adjust the time window or add additional metrics!
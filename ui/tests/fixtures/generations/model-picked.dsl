Sure — building that now.

root = AppStack([heading, controls, chart], "md")
heading = AppText("Spend by model", "title")
$model = "claude-sonnet-4-5"
modelPicker = AppSegmentedControl([{value: "claude-sonnet-4-5", label: "Sonnet 4.5"}, {value: "claude-haiku-4-5", label: "Haiku 4.5"}, {value: "claude-opus-4-1", label: "Opus 4.1"}], $model, "md", false, null, "Model", null, selectModel)
selectModel = Action([@Set($model, $event), @Run(spendQ)])
controls = AppRow([modelPicker], "md")
spendQ = Query("fetchSpendTimeseries", [{range: "7d", model: $model}], {points: []}, "data.points")
chart = AppChart({labels: spendQ.bucket_start, datasets: [{label: "Spend (USD)", data: spendQ.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data for this model in the last 7 days")

Here's a 7-day spend chart for your selected Claude model with a segmented control to switch between Sonnet, Haiku, and Opus — let me know if you'd like to adjust the timeframe or add any other metrics!
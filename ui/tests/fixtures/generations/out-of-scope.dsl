Sure — building that now.

root = AppStack([header, billByService], "md")
header = AppRow([title], "md")
title = AppStatCard("AWS Bill by Service", null, null, "neutral")
billByService = AppTable(serviceRows, 20, "pages", false)
serviceRows = Query("fetchUsageByModel", ["", 1, 20], [], "data")

Here's a table showing usage by model — this is the closest match to your AWS bill request. The available data sources don't yet include a dedicated AWS billing breakdown by service, so this table shows cost and token usage grouped by model instead. Let me know if you'd like a different view, or if you'd like me to add filters, charts, or additional metrics!
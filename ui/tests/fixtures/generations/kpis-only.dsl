Sure — building that now.
root = AppStack([kpis], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_cost_usd: 0})
kpis = AppRow([requestsCard, costCard], "md")
requestsCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
Here's your headline numbers — requests and cost. Let me know if you'd like to add more metrics or any detail!
Sure — building that now.

root = AppStack([heading, emptyState], "md")
heading = AppText("AWS bill by service", "title")
emptyState = AppEmptyState("No AWS billing data available", "The data sources in scope don't include AWS service-level billing. Available sources cover TokenOps usage (agents, models, tokens, latency) but not AWS infrastructure costs by service.")

Here's what I found: the data sources available to this dashboard cover TokenOps agent usage, token consumption, and cost metrics — but not AWS billing broken down by service. To show you "AWS bill by service," I'd need access to a real data source that returns that shape (e.g., a `fetchAWSBillingByService()` endpoint connected to your actual AWS Cost Explorer data). If that source exists and should be added to the platform, let me know and I can rebuild this dashboard to use it — otherwise, I can show you TokenOps cost metrics by agent or model instead.
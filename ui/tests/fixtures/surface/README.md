# Deterministic surface regressions

`grouped-filters-clean.dsl` is a **hand-repaired regression fixture**, not a new model sample. It starts from the unchanged recorded `../generations/grouped-filters.dsl`, supplies the missing `rowsQ` using the approved `fetchFinopsAttributions` source, selects `data.rows` with an array default, updates the local filter to that selected value and sets the local page size to 10.

The broken original and its `knownFailure` remain. The clean draw does not establish that the generator stopped losing statement names. In the September 25 candidate-image check, 0/3 fresh grouped-filter generations were contract-clean, including after one repair round. This fixture tests the runtime's intended composition and interaction independently of that failure.

//! PACMS context selector — a budget-aware, coverage-diversified replacement
//! for plain recency ("last-k") truncation of session history.
//!
//! Ported from `pacms/pacms-py/pacms/pacms_selector.py` (itself extracted
//! verbatim, algorithmically, from `PACMSEvaluator.pacms_v2`). Embeddings and
//! cosine similarity are delegated to `VectorStore` instead of Ollama/numpy.
//!
//! Algorithm (`select_pacms`):
//!   - embed every candidate + the query
//!   - relevance(i) = max(0, cosine(candidate_i, query))
//!   - coverage weight w[i][j] = relevance(i) * max(0, cosine(i, j))
//!   - monotone submodular facility-location objective F(S) = sum_i max_{j in S} w[i][j]
//!   - CELF lazy-greedy selection under a token (knapsack) budget, with
//!     mandatory indices seeded first
//!
//! `select_lastk` is also ported as a query-blind, embedding-free recency
//! baseline — usable as a fallback strategy (e.g. when embeddings are
//! disabled) without pulling in a second implementation of "keep the most
//! recent items that fit".
//!
//! This module is self-contained: it operates on `Vec<String>` candidates and
//! returns selected indices, mirroring the Python contract. Wiring it into
//! `SessionHistory` (formatting `ChatMessage`s into candidate strings, mapping
//! selected indices back, and restoring chronological order) is a separate
//! step.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};

use crate::error::RouterError;
use crate::vector_store::VectorStore;

/// Default token estimator: ~4 characters per token. Callers with a real
/// tokenizer should pass their own via `PacmsSelector::with_token_estimator`.
fn default_token_estimator(text: &str) -> usize {
    text.len() / 4
}

pub struct PacmsSelector<'a> {
    vector_store: &'a VectorStore,
    /// Fixed relevance/coverage tradeoff, used when `adaptive_lam` is false.
    lam: f64,
    /// When true, `lam` is derived per-call from `budget / total_tokens`
    /// (low budget -> favor relevance, high budget -> favor coverage),
    /// clamped to [0.01, 0.99] so neither term ever fully vanishes.
    adaptive_lam: bool,
    token_estimator: Box<dyn Fn(&str) -> usize + Send + Sync + 'a>,
}

impl<'a> PacmsSelector<'a> {
    pub fn new(vector_store: &'a VectorStore) -> Self {
        Self {
            vector_store,
            lam: 1.0,
            adaptive_lam: true,
            token_estimator: Box::new(default_token_estimator),
        }
    }

    pub fn with_lam(mut self, lam: f64) -> Self {
        self.lam = lam;
        self
    }

    pub fn with_adaptive_lam(mut self, adaptive: bool) -> Self {
        self.adaptive_lam = adaptive;
        self
    }

    pub fn with_token_estimator(
        mut self,
        estimator: impl Fn(&str) -> usize + Send + Sync + 'a,
    ) -> Self {
        self.token_estimator = Box::new(estimator);
        self
    }

    fn estimate_tokens(&self, text: &str) -> usize {
        (self.token_estimator)(text)
    }

    async fn embed_all(
        &self,
        candidates: &[String],
        query: &str,
    ) -> Result<(Vec<Vec<f32>>, Vec<f64>), RouterError> {
        let mut embeddings = Vec::with_capacity(candidates.len());
        for c in candidates {
            embeddings.push(self.vector_store.embed(c).await?);
        }
        let query_emb = self.vector_store.embed(query).await?;

        let relevance = embeddings
            .iter()
            .map(|e| cosine_similarity(e, &query_emb).max(0.0) as f64)
            .collect();

        Ok((embeddings, relevance))
    }

    fn seed_mandatory(
        &self,
        candidates: &[String],
        mandatory: &HashSet<usize>,
        n: usize,
    ) -> (Vec<usize>, usize) {
        let mut kept = Vec::new();
        let mut tok_total = 0;
        let mut sorted_mandatory: Vec<usize> =
            mandatory.iter().copied().filter(|&i| i < n).collect();
        sorted_mandatory.sort_unstable();
        for j in sorted_mandatory {
            tok_total += self.estimate_tokens(&candidates[j]);
            kept.push(j);
        }
        (kept, tok_total)
    }

    /// Recency baseline: keep the most-recent candidates that fit the token
    /// budget. No embeddings, no query — topic-blind, used as a fallback when
    /// embeddings are disabled/unavailable, or for comparison.
    pub fn select_lastk(
        &self,
        candidates: &[String],
        budget: usize,
        mandatory: Option<&HashSet<usize>>,
    ) -> Vec<usize> {
        let empty = HashSet::new();
        let mandatory = mandatory.unwrap_or(&empty);
        let n = candidates.len();
        if n == 0 {
            return vec![];
        }

        let (mut kept, mut tok) = self.seed_mandatory(candidates, mandatory, n);
        let mut kept_set: HashSet<usize> = kept.iter().copied().collect();

        for i in (0..n).rev() {
            if kept_set.contains(&i) {
                continue;
            }
            let t = self.estimate_tokens(&candidates[i]);
            if t == 0 {
                continue;
            }
            if tok + t <= budget {
                kept.push(i);
                kept_set.insert(i);
                tok += t;
            }
        }

        let mut plan: Vec<usize> = kept
            .iter()
            .copied()
            .filter(|i| mandatory.contains(i))
            .collect();
        let mut rest: Vec<usize> = kept
            .iter()
            .copied()
            .filter(|i| !mandatory.contains(i))
            .collect();
        plan.sort_unstable();
        rest.sort_unstable();
        plan.extend(rest);
        plan
    }

    /// Budget-aware submodular coverage selection (CELF lazy-greedy). See
    /// module docs for the objective.
    pub async fn select_pacms(
        &self,
        candidates: &[String],
        query: &str,
        budget: usize,
        mandatory: Option<&HashSet<usize>>,
    ) -> Result<Vec<usize>, RouterError> {
        let empty = HashSet::new();
        let mandatory = mandatory.unwrap_or(&empty);
        let n = candidates.len();
        if n == 0 {
            return Ok(vec![]);
        }

        let mut plan_idx: Vec<usize> = mandatory.iter().copied().filter(|&i| i < n).collect();
        plan_idx.sort_unstable();
        let plan_set: HashSet<usize> = plan_idx.iter().copied().collect();

        let total_tok: usize = candidates.iter().map(|c| self.estimate_tokens(c)).sum();
        let total_tok = total_tok.max(1);
        let lam = if self.adaptive_lam {
            (1.0 - (budget as f64 / total_tok as f64)).clamp(0.01, 0.99)
        } else {
            self.lam
        };

        let (embeddings, rel) = self.embed_all(candidates, query).await?;

        // Coverage weight w[i][j] = rel[i] * cos(i,j): how well j "covers" i,
        // weighted by i's own query relevance (facility-location form).
        let mut sim = vec![vec![0.0f64; n]; n];
        for (i, row) in sim.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                let s = if i == j {
                    1.0
                } else {
                    cosine_similarity(&embeddings[i], &embeddings[j]).max(0.0) as f64
                };
                *cell = rel[i] * s;
            }
        }

        let mut cover = vec![0.0f64; n];
        let mut selected: HashSet<usize> = HashSet::new();
        let mut selected_tok = 0usize;

        let commit = |j: usize,
                      selected: &mut HashSet<usize>,
                      selected_tok: &mut usize,
                      cover: &mut [f64]| {
            selected.insert(j);
            *selected_tok += self.estimate_tokens(&candidates[j]);
            for i in 0..n {
                if sim[i][j] > cover[i] {
                    cover[i] = sim[i][j];
                }
            }
        };

        // Seed mandatory items (respecting budget).
        for &j in &plan_idx {
            let tok = self.estimate_tokens(&candidates[j]);
            if selected_tok + tok <= budget {
                commit(j, &mut selected, &mut selected_tok, &mut cover);
            }
        }

        let marginal_gain = |j: usize, cover: &[f64]| -> f64 {
            let mut cov = 0.0;
            for i in 0..n {
                let d = sim[i][j] - cover[i];
                if d > 0.0 {
                    cov += d;
                }
            }
            lam * rel[j] + (1.0 - lam) * cov
        };

        // CELF lazy-greedy: heap entries carry (ratio, the round they were
        // last evaluated at, candidate index). A popped entry whose
        // `last_eval` matches the current round has a fresh, up-to-date gain
        // and can be committed immediately; otherwise it's stale and gets
        // recomputed and re-pushed. This lazy re-evaluation is what makes
        // greedy submodular selection fast in practice without changing the
        // final selection.
        let mut heap: BinaryHeap<HeapEntry> = BinaryHeap::new();
        for (j, candidate) in candidates.iter().enumerate() {
            if selected.contains(&j) {
                continue;
            }
            let tok = self.estimate_tokens(candidate);
            if tok == 0 || selected_tok + tok > budget {
                continue;
            }
            let ratio = marginal_gain(j, &cover) / tok as f64;
            heap.push(HeapEntry {
                ratio,
                last_eval: 0,
                idx: j,
            });
        }

        let mut round = 1u64;
        while let Some(top) = heap.pop() {
            if selected_tok >= budget {
                break;
            }
            let tok = self.estimate_tokens(&candidates[top.idx]);
            if selected.contains(&top.idx) || selected_tok + tok > budget {
                continue;
            }
            if top.last_eval == round {
                if top.ratio <= 1e-9 {
                    break;
                }
                commit(top.idx, &mut selected, &mut selected_tok, &mut cover);
                round += 1;
            } else {
                let ratio = marginal_gain(top.idx, &cover) / tok as f64;
                heap.push(HeapEntry {
                    ratio,
                    last_eval: round,
                    idx: top.idx,
                });
            }
        }

        let mut plan_first: Vec<usize> = selected
            .iter()
            .copied()
            .filter(|i| plan_set.contains(i))
            .collect();
        let mut others: Vec<usize> = selected
            .iter()
            .copied()
            .filter(|i| !plan_set.contains(i))
            .collect();
        plan_first.sort_unstable();
        others.sort_unstable();
        plan_first.extend(others);
        Ok(plan_first)
    }
}

/// Heap entry for the CELF lazy-greedy loop. `BinaryHeap` in Rust is a
/// max-heap (Python's `heapq` is a min-heap), so `Ord` here is defined
/// directly on "highest ratio wins, ties broken by lowest index" — the
/// equivalent of Python's `(-ratio, last_eval, idx)` min-heap tuple, without
/// needing to negate the ratio a second time.
struct HeapEntry {
    ratio: f64,
    last_eval: u64,
    idx: usize,
}

impl PartialEq for HeapEntry {
    fn eq(&self, other: &Self) -> bool {
        self.ratio == other.ratio && self.last_eval == other.last_eval && self.idx == other.idx
    }
}
impl Eq for HeapEntry {}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        // Matches Python's tuple comparison (-ratio, last_eval, idx) on a
        // min-heap: highest ratio first, ties broken by lowest last_eval,
        // remaining ties broken by lowest idx. Each "lowest wins" step is
        // inverted here (other.cmp(&self)) because BinaryHeap pops the
        // greatest element first.
        self.ratio
            .partial_cmp(&other.ratio)
            .unwrap_or(Ordering::Equal)
            .then_with(|| other.last_eval.cmp(&self.last_eval))
            .then_with(|| other.idx.cmp(&self.idx))
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a * norm_b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lastk_keeps_most_recent_within_budget() {
        let vs = VectorStore::disabled();
        let selector = PacmsSelector::new(&vs).with_token_estimator(|s: &str| s.len());
        let candidates: Vec<String> = vec!["a".into(), "bb".into(), "ccc".into(), "dddd".into()];
        // Walking from most recent: "dddd" (4) fits (tok=4); "ccc" (3) would
        // overflow (7>5) so it's skipped; "bb" (2) would also overflow (6>5);
        // "a" (1) fits (tok=5). Selected = {3, 0}, returned in index order.
        let selected = selector.select_lastk(&candidates, 5, None);
        assert_eq!(selected, vec![0, 3]);
    }

    #[test]
    fn lastk_seeds_mandatory_first() {
        let vs = VectorStore::disabled();
        let selector = PacmsSelector::new(&vs).with_token_estimator(|s: &str| s.len());
        let candidates: Vec<String> = vec!["a".into(), "bb".into(), "ccc".into(), "dddd".into()];
        let mandatory: HashSet<usize> = [0].into_iter().collect();
        let selected = selector.select_lastk(&candidates, 5, Some(&mandatory));
        // mandatory (0, cost 1) + most recent that fits in remaining budget 4 -> index 3 (cost 4)
        assert_eq!(selected, vec![0, 3]);
    }

    #[test]
    fn lastk_empty_candidates() {
        let vs = VectorStore::disabled();
        let selector = PacmsSelector::new(&vs);
        let selected = selector.select_lastk(&[], 100, None);
        assert!(selected.is_empty());
    }

    #[test]
    fn heap_entry_orders_by_ratio_then_lowest_index() {
        let mut heap: BinaryHeap<HeapEntry> = BinaryHeap::new();
        heap.push(HeapEntry {
            ratio: 1.0,
            last_eval: 0,
            idx: 5,
        });
        heap.push(HeapEntry {
            ratio: 2.0,
            last_eval: 0,
            idx: 1,
        });
        heap.push(HeapEntry {
            ratio: 2.0,
            last_eval: 0,
            idx: 0,
        });
        // Highest ratio first; ties broken by lowest index.
        assert_eq!(heap.pop().unwrap().idx, 0);
        assert_eq!(heap.pop().unwrap().idx, 1);
        assert_eq!(heap.pop().unwrap().idx, 5);
    }
}

// Fixture for the faithfulness/citation-grounding eval (R11, 2026-07-01 RAG backlog).
//
// Each case is a recorded (query, retrievedChunks, answer) tuple — NOT a live retrieval + LLM
// call. The `answer` strings are hand-authored to exercise both the PASS and FAIL paths of each
// deterministic check (grounded citations / fabricated citations, supported numerics /
// hallucinated numerics) so the scorer's behavior is pinned regardless of any real LLM's output.

import type { FaithfulnessCase } from "../../scripts/eval/faithfulness";

export const RAG_FAITHFULNESS_FIXTURE: FaithfulnessCase[] = [
  {
    id: "grounded-citation-and-numeric",
    query: "What was Apple's Q2 revenue?",
    retrievedChunks: [
      { chunk_id: "AAPL-10Q#c001", text: "Apple reported total net sales of $90.8 billion for the quarter, up 5% year over year." }
    ],
    answer: "Apple reported revenue of $90.8 billion, up 5% year over year [AAPL-10Q#c001]."
  },
  {
    id: "fabricated-citation",
    query: "What was Apple's Q2 revenue?",
    retrievedChunks: [
      { chunk_id: "AAPL-10Q#c001", text: "Apple reported total net sales of $90.8 billion for the quarter, up 5% year over year." }
    ],
    // Cites a chunk id that was never retrieved — a fabricated source.
    answer: "Apple reported revenue of $90.8 billion [AAPL-10Q#c999]."
  },
  {
    id: "hallucinated-numeric",
    query: "What was Apple's Q2 revenue?",
    retrievedChunks: [
      { chunk_id: "AAPL-10Q#c001", text: "Apple reported total net sales of $90.8 billion for the quarter, up 5% year over year." }
    ],
    // States a dollar figure that appears nowhere in the retrieved text.
    answer: "Apple reported revenue of $120.4 billion [AAPL-10Q#c001]."
  },
  {
    id: "grounded-percentage-claim",
    query: "How much did AMZN's fulfillment costs grow?",
    retrievedChunks: [
      { chunk_id: "AMZN-10K#c014", text: "Fulfillment costs increased 12% as we expanded our logistics network." }
    ],
    answer: "AMZN's fulfillment costs grew 12% due to logistics expansion [AMZN-10K#c014]."
  },
  {
    id: "no-citations-no-numerics-trivially-grounded",
    query: "What sector is MSFT in?",
    retrievedChunks: [
      { chunk_id: "MSFT-10K#c002", text: "Microsoft operates in the technology sector, focusing on cloud, productivity, and gaming." }
    ],
    // No bracket citation, no numeric claim — trivially passes both checks (nothing to fabricate).
    answer: "Microsoft operates primarily in the technology sector, with a focus on cloud and productivity software."
  },
  {
    id: "multi-chunk-grounded",
    query: "Compare AAPL and MSFT revenue growth.",
    retrievedChunks: [
      { chunk_id: "AAPL-10Q#c001", text: "Apple reported total net sales of $90.8 billion for the quarter, up 5% year over year." },
      { chunk_id: "MSFT-10Q#c007", text: "Microsoft reported revenue of $61.9 billion, up 17% year over year, driven by cloud growth." }
    ],
    answer: "Apple grew revenue 5% to $90.8 billion [AAPL-10Q#c001], while Microsoft grew 17% to $61.9 billion [MSFT-10Q#c007]."
  },
  {
    id: "source-paren-citation-style",
    query: "What did the 8-K disclose for NVDA?",
    retrievedChunks: [
      { chunk_id: "NVDA-8K#c003", text: "NVIDIA disclosed a new supply agreement expected to add $2.1 billion in annual revenue." }
    ],
    answer: "NVIDIA's new supply agreement is expected to add $2.1 billion in annual revenue (source: NVDA-8K#c003)."
  }
];

/**
 * Exhaustive unit tests for the Pinecone -> Qdrant filter translator
 * (src/lib/vector-store/pinecone-filter-to-qdrant.ts) — STAGE-1 read cutover.
 *
 * The translator's safety contract is refuse-loudly: any operator or shape it does not implement
 * must THROW rather than silently dropping a clause (a dropped clause can leak cross-tenant data).
 * Pure module — no DB, no network.
 */
import { describe, expect, it } from "vitest";
import {
  ABSENT_FIELD_SENTINELS,
  UnsupportedPineconeFilterError,
  pineconeFilterToQdrant,
  qdrantTenantFilter
} from "../src/lib/vector-store/pinecone-filter-to-qdrant";

describe("scalar operators", () => {
  it("$eq -> match value", () => {
    expect(pineconeFilterToQdrant({ symbol: { $eq: "AAPL" } })).toEqual({
      key: "symbol",
      match: { value: "AAPL" }
    });
  });

  it("implicit-$eq scalar shorthand -> match value", () => {
    expect(pineconeFilterToQdrant({ symbol: "AAPL" })).toEqual({ key: "symbol", match: { value: "AAPL" } });
    expect(pineconeFilterToQdrant({ receipt_required: false })).toEqual({
      key: "receipt_required",
      match: { value: false }
    });
  });

  it("$eq boolean and numeric values survive verbatim", () => {
    expect(pineconeFilterToQdrant({ receipt_required: { $eq: true } })).toEqual({
      key: "receipt_required",
      match: { value: true }
    });
    expect(pineconeFilterToQdrant({ as_of_epoch_ms: { $eq: 1700000000000 } })).toEqual({
      key: "as_of_epoch_ms",
      match: { value: 1700000000000 }
    });
  });

  it("$in -> match any", () => {
    expect(pineconeFilterToQdrant({ doc_type: { $in: ["10-K", "10-k", "10-Q"] } })).toEqual({
      key: "doc_type",
      match: { any: ["10-K", "10-k", "10-Q"] }
    });
  });

  it("$ne -> must_not match", () => {
    expect(pineconeFilterToQdrant({ source: { $ne: "fmp" } })).toEqual({
      must_not: [{ key: "source", match: { value: "fmp" } }]
    });
  });

  it("$lte on as_of_epoch_ms -> range lte", () => {
    expect(pineconeFilterToQdrant({ as_of_epoch_ms: { $lte: 1700000000000 } })).toEqual({
      key: "as_of_epoch_ms",
      range: { lte: 1700000000000 }
    });
  });

  it("combined range operators fold into one range condition", () => {
    expect(pineconeFilterToQdrant({ as_of_epoch_ms: { $gte: 5, $lte: 10 } })).toEqual({
      key: "as_of_epoch_ms",
      range: { gte: 5, lte: 10 }
    });
  });
});

describe("$exists", () => {
  it("$exists: true -> must_not is_empty", () => {
    expect(pineconeFilterToQdrant({ tenant_scope: { $exists: true } })).toEqual({
      must_not: [{ is_empty: { key: "tenant_scope" } }]
    });
  });

  it("$exists: false on a sentinel field -> should[is_empty, sentinel match] (both arms)", () => {
    expect(pineconeFilterToQdrant({ scope: { $exists: false } })).toEqual({
      should: [
        { is_empty: { key: "scope" } },
        { key: "scope", match: { value: "__absent__" } }
      ]
    });
    expect(pineconeFilterToQdrant({ tenant_scope: { $exists: false } })).toEqual({
      should: [
        { is_empty: { key: "tenant_scope" } },
        { key: "tenant_scope", match: { value: "__absent__" } }
      ]
    });
    expect(pineconeFilterToQdrant({ receipt_required: { $exists: false } })).toEqual({
      should: [
        { is_empty: { key: "receipt_required" } },
        { key: "receipt_required", match: { value: false } }
      ]
    });
    expect(pineconeFilterToQdrant({ as_of_epoch_ms: { $exists: false } })).toEqual({
      should: [
        { is_empty: { key: "as_of_epoch_ms" } },
        { key: "as_of_epoch_ms", match: { value: 0 } }
      ]
    });
  });

  it("$exists: false on a field with no catalogued sentinel -> is_empty alone", () => {
    expect(ABSENT_FIELD_SENTINELS.some_uncatalogued_field).toBeUndefined();
    expect(pineconeFilterToQdrant({ some_uncatalogued_field: { $exists: false } })).toEqual({
      is_empty: { key: "some_uncatalogued_field" }
    });
  });
});

describe("boolean composition", () => {
  it("multiple field keys AND-combine (Pinecone top-level semantics)", () => {
    expect(
      pineconeFilterToQdrant({ symbol: { $eq: "AAPL" }, userId: { $eq: "user-1" } })
    ).toEqual({
      must: [
        { key: "symbol", match: { value: "AAPL" } },
        { key: "userId", match: { value: "user-1" } }
      ]
    });
  });

  it("fields + $or at the same level -> must[fields..., {should: [...]}] (vector-db tier-filter shape)", () => {
    const filter = {
      symbol: { $eq: "AAPL" },
      $or: [
        { scope: { $eq: "shared" } },
        { $and: [{ userId: { $eq: "local" } }, { scope: { $exists: false } }] }
      ]
    };
    expect(pineconeFilterToQdrant(filter)).toEqual({
      must: [
        { key: "symbol", match: { value: "AAPL" } },
        {
          should: [
            { key: "scope", match: { value: "shared" } },
            {
              must: [
                { key: "userId", match: { value: "local" } },
                {
                  should: [
                    { is_empty: { key: "scope" } },
                    { key: "scope", match: { value: "__absent__" } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    });
  });

  it("top-level $and of $or-blocks -> must[should[...], should[...]] (vector-db.ts mergeAsOfEpoch shape)", () => {
    // The exact shape withCommittedVectorFilter(mergeAsOfEpoch(base, epochOr)) produces:
    // $and: [ $and: [base, epochOr], committedOr ].
    const asOfMs = 1700000000000;
    const filter = {
      $and: [
        {
          $and: [
            { symbol: { $eq: "AAPL" }, $or: [{ scope: { $eq: "shared" } }] },
            { $or: [{ as_of_epoch_ms: { $lte: asOfMs } }, { as_of_epoch_ms: { $exists: false } }] }
          ]
        },
        {
          $or: [
            { receipt_required: { $exists: false } },
            { receipt_required: { $eq: false } },
            { ingest_state: { $eq: "committed" } }
          ]
        }
      ]
    };
    expect(pineconeFilterToQdrant(filter)).toEqual({
      must: [
        {
          must: [
            {
              must: [
                { key: "symbol", match: { value: "AAPL" } },
                { should: [{ key: "scope", match: { value: "shared" } }] }
              ]
            },
            {
              should: [
                { key: "as_of_epoch_ms", range: { lte: asOfMs } },
                {
                  should: [
                    { is_empty: { key: "as_of_epoch_ms" } },
                    { key: "as_of_epoch_ms", match: { value: 0 } }
                  ]
                }
              ]
            }
          ]
        },
        {
          should: [
            {
              should: [
                { is_empty: { key: "receipt_required" } },
                { key: "receipt_required", match: { value: false } }
              ]
            },
            { key: "receipt_required", match: { value: false } },
            { key: "ingest_state", match: { value: "committed" } }
          ]
        }
      ]
    });
  });

  it("empty / absent filter -> undefined (query everything, like Pinecone no-filter)", () => {
    expect(pineconeFilterToQdrant(undefined)).toBeUndefined();
    expect(pineconeFilterToQdrant(null)).toBeUndefined();
    expect(pineconeFilterToQdrant({})).toBeUndefined();
  });
});

describe("refuse-loudly on anything not implemented", () => {
  it("throws on an unimplemented field operator ($nin)", () => {
    expect(() => pineconeFilterToQdrant({ doc_type: { $nin: ["x"] } })).toThrow(UnsupportedPineconeFilterError);
  });

  it("throws on an unknown top-level operator ($nor)", () => {
    expect(() => pineconeFilterToQdrant({ $nor: [{ a: 1 }] })).toThrow(UnsupportedPineconeFilterError);
  });

  it("throws on malformed operator payloads instead of guessing", () => {
    expect(() => pineconeFilterToQdrant({ symbol: { $eq: { nested: true } } })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ doc_type: { $in: "not-an-array" } })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ doc_type: { $in: [] } })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ as_of_epoch_ms: { $lte: "soon" } })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ scope: { $exists: "false" } })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ $and: [] })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ $or: [] })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ $or: [{}] })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ symbol: null })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant({ symbol: {} })).toThrow(UnsupportedPineconeFilterError);
    expect(() => pineconeFilterToQdrant([{ symbol: "AAPL" }] as unknown as Record<string, unknown>)).toThrow(
      UnsupportedPineconeFilterError
    );
  });
});

describe("qdrantTenantFilter", () => {
  it("always pins ns first, then AND-combines the translated filter", () => {
    expect(qdrantTenantFilter("socratic-abc123", { symbol: { $eq: "AAPL" } })).toEqual({
      must: [
        { key: "ns", match: { value: "socratic-abc123" } },
        { key: "symbol", match: { value: "AAPL" } }
      ]
    });
  });

  it("ns clause alone when the filter is empty — the tenant pin is never optional", () => {
    expect(qdrantTenantFilter("", {})).toEqual({ must: [{ key: "ns", match: { value: "" } }] });
    expect(qdrantTenantFilter("", undefined)).toEqual({ must: [{ key: "ns", match: { value: "" } }] });
  });
});

describe("production composite shapes (review pin)", () => {
  // The EXACT shared-tier filter retrieveContextDetailed builds:
  //   withCommittedVectorFilter(mergeAsOfEpoch({...symbol/extra, $or: scope-coexistence}, asOfFailOpenOr))
  // Keep this literal in sync with vector-db.ts — it pins that every clause of the deepest
  // real production shape survives translation (nothing throws, nothing is dropped).
  const asOfMs = 1719792000000;
  const sharedTierFilter = {
    $and: [
      {
        $and: [
          {
            symbol: { $eq: "AAPL" },
            doc_type: { $in: ["10-k", "10-K"] },
            embed_model: { $in: ["baai/bge-m3", "BAAI/bge-m3"] },
            $or: [
              { scope: { $eq: "shared" } },
              { $and: [{ userId: { $eq: "local" } }, { scope: { $exists: false } }] }
            ]
          },
          { $or: [{ as_of_epoch_ms: { $lte: asOfMs } }, { as_of_epoch_ms: { $exists: false } }] }
        ]
      },
      {
        $or: [
          { receipt_required: { $exists: false } },
          { receipt_required: { $eq: false } },
          { ingest_state: { $eq: "committed" } }
        ]
      }
    ]
  };

  it("translates the shared-tier committed+asOf composite with every clause intact", () => {
    expect(pineconeFilterToQdrant(sharedTierFilter)).toEqual({
      must: [
        {
          must: [
            {
              must: [
                { key: "symbol", match: { value: "AAPL" } },
                { key: "doc_type", match: { any: ["10-k", "10-K"] } },
                { key: "embed_model", match: { any: ["baai/bge-m3", "BAAI/bge-m3"] } },
                {
                  should: [
                    { key: "scope", match: { value: "shared" } },
                    {
                      must: [
                        { key: "userId", match: { value: "local" } },
                        {
                          should: [
                            { is_empty: { key: "scope" } },
                            { key: "scope", match: { value: "__absent__" } }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            {
              should: [
                { key: "as_of_epoch_ms", range: { lte: asOfMs } },
                {
                  should: [
                    { is_empty: { key: "as_of_epoch_ms" } },
                    { key: "as_of_epoch_ms", match: { value: 0 } }
                  ]
                }
              ]
            }
          ]
        },
        {
          should: [
            {
              should: [
                { is_empty: { key: "receipt_required" } },
                { key: "receipt_required", match: { value: false } }
              ]
            },
            { key: "receipt_required", match: { value: false } },
            { key: "ingest_state", match: { value: "committed" } }
          ]
        }
      ]
    });
  });

  it("translates the managed-tier wrapper ({$and: [tierFilter, managedAuthorityClause]}) without throwing", () => {
    const managedSharedFilter = {
      $and: [
        sharedTierFilter,
        {
          ledger_authority: { $eq: "164c2691b903641db7ff" },
          provider_authority: { $eq: "pa-1" },
          receipt_required: { $eq: true },
          ingest_state: { $eq: "committed" }
        }
      ]
    };
    const translated = pineconeFilterToQdrant(managedSharedFilter);
    expect(translated).toBeDefined();
    // No clause dropped: every field key present somewhere in the translated tree.
    const flat = JSON.stringify(translated);
    for (const key of ["ledger_authority", "provider_authority", "receipt_required", "ingest_state", "symbol", "embed_model"]) {
      expect(flat).toContain(`"${key}"`);
    }
  });

  it("translates the user-tier private-visibility composite (tenant_scope arms) without throwing", () => {
    const userTierFilter = {
      $and: [
        {
          symbol: { $eq: "AAPL" },
          userId: { $eq: "user-1" },
          $or: [
            { tenant_scope: { $eq: "private:user-1" } },
            { $and: [{ tenant_scope: { $exists: false } }, { scope: { $eq: "private" } }] },
            { $and: [{ tenant_scope: { $exists: false } }, { scope: { $exists: false } }] }
          ]
        },
        {
          $or: [
            { receipt_required: { $exists: false } },
            { receipt_required: { $eq: false } },
            { ingest_state: { $eq: "committed" } }
          ]
        }
      ]
    };
    const flat = JSON.stringify(pineconeFilterToQdrant(userTierFilter));
    for (const key of ["tenant_scope", "scope", "userId", "symbol"]) {
      expect(flat).toContain(`"${key}"`);
    }
    // Both $exists:false arms must include the sentinel match (backfill parity).
    expect(flat).toContain('"__absent__"');
  });
});

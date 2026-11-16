import { afterEach, describe, expect, it, vi } from "vitest";
import { savePolicy } from "../app/console/lib/api";

afterEach(() => vi.unstubAllGlobals());

function jsonPolicyResponse(): Response {
  return new Response(JSON.stringify({ systemState: "halted" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("console policy write queue", () => {
  it("serializes writes across callers and carries the originating account target", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          void input;
          void init;
          resolvers.push(resolve);
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = savePolicy({ maxOrderNotional: 100 }, "account-a");
    const second = savePolicy({ maxOrderNotional: 200 }, "account-b");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const firstInit = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(String(firstInit.body))).toEqual({
      maxOrderNotional: 100,
      targetConnectedAccountId: "account-a"
    });

    resolvers[0]?.(jsonPolicyResponse());
    await first;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondInit = fetchMock.mock.calls[1]![1]!;
    expect(JSON.parse(String(secondInit.body))).toEqual({
      maxOrderNotional: 200,
      targetConnectedAccountId: "account-b"
    });

    resolvers[1]?.(jsonPolicyResponse());
    await second;
  });

  it("continues the queue after a rejected write", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("refused", { status: 400 }))
      .mockResolvedValueOnce(jsonPolicyResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(savePolicy({ maxOrderNotional: -1 }, "account-a")).rejects.toMatchObject({ status: 400 });
    await expect(savePolicy({ maxOrderNotional: 250 }, "account-a")).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

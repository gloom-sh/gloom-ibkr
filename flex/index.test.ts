import { afterEach, describe, expect, test } from "bun:test";
import { setHttpFetchTransport } from "gloomberb/utils";
import {
  parseFlexAccounts,
  parseFlexPortfolioPerformance,
  parseFlexPositions,
  requestFlexStatement,
} from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  setHttpFetchTransport(null);
  globalThis.fetch = originalFetch;
});

describe("parseFlexPositions", () => {
  test("declares percentage-of-par bond prices while retaining nominal quantity, totals and raw multiplier", () => {
    const xml='<OpenPosition symbol="CONTROLLED" assetCategory="BOND" currency="USD" position="1000" costBasisPrice="87.7420" markPrice="86.359375" positionValue="863.59" fifoPnlUnrealized="-13.83" multiplier="1" />';
    const [bond]=parseFlexPositions(xml);
    expect(bond).toMatchObject({shares:1000,avgCost:87.742,markPrice:86.359375,marketValue:863.59,unrealizedPnl:-13.83,multiplier:1,priceBasis:"percent-of-par"});
    expect(bond?.brokerContract?.multiplier).toBe("1");
    for(const asset of ["STK","ETF","OPT","FUT",""]) {
      const [other]=parseFlexPositions(xml.replace('assetCategory="BOND"',`assetCategory="${asset}"`));
      expect(other?.priceBasis).toBeUndefined();
      expect(other).toMatchObject({shares:1000,avgCost:87.742,markPrice:86.359375,multiplier:1});
    }
  });

  test("rejects incomplete position rows instead of inventing a currency or an empty holding", () => {
    for (const attributes of [
      'symbol="TEST" position="10"',
      'symbol="TEST" position="10" currency="   "',
      'symbol="TEST" currency="USD"',
      'symbol="TEST" position="invalid" currency="USD"',
      'symbol="TEST" position="Infinity" currency="USD"',
      'symbol="TEST" position="   " currency="USD"',
      'position="10" currency="USD"',
    ]) {
      expect(() => parseFlexPositions(`<OpenPositions><OpenPosition ${attributes} /></OpenPositions>`)).toThrow("IBKR Flex");
    }
    expect(parseFlexPositions('<OpenPositions />')).toEqual([]);
    expect(parseFlexPositions('<OpenPositions><OpenPosition symbol="TEST" position="0" /></OpenPositions>')).toEqual([]);
    const [short] = parseFlexPositions('<OpenPositions><OpenPosition symbol="TEST" position=" " quantity="-2.5" currency="EUR" /></OpenPositions>');
    expect(short).toMatchObject({ ticker: "TEST", shares: 2.5, side: "short", currency: "EUR" });
  });

  test("keeps unavailable source cost distinct from explicit zero and legacy cost", () => {
    for (const [attributes, expected] of [
      ["", undefined],
      ['costBasisPrice=""', undefined],
      ['costBasisPrice="   "', undefined],
      ['costBasisPrice="not-a-number"', undefined],
      ['costBasisPrice="NaN"', undefined],
      ['costBasisPrice="Infinity"', undefined],
      ['costBasisPrice="0" costPrice="100"', 0],
      ['costBasisPrice="100"', 100],
      ['costPrice="100"', 100],
      ['costBasisPrice="  " costPrice="100"', 100],
      ['costBasisPrice="invalid" costPrice="100"', undefined],
    ] as const) {
      const xml = `<OpenPosition accountId="CONTROLLED" symbol="TEST" position="10" currency="USD" ${attributes} markPrice="120" positionValue="1200" fifoPnlUnrealized="200" />`;
      const [position] = parseFlexPositions(xml);
      expect(position?.avgCost).toBe(expected);
      expect(position).toMatchObject({ shares: 10, markPrice: 120, marketValue: 1200, unrealizedPnl: 200 });
      const persisted = JSON.parse(JSON.stringify(position));
      expect(persisted.avgCost).toBe(expected);
    }
    const [blank] = parseFlexPositions('<OpenPosition symbol="TEST" position="10" currency="USD" costBasisPrice="100" markPrice=" " positionValue=" " fifoPnlUnrealized=" " />');
    expect(blank).toMatchObject({ shares: 10, avgCost: 100 });
    expect(blank?.markPrice).toBeUndefined();
    expect(blank?.marketValue).toBeUndefined();
    expect(blank?.unrealizedPnl).toBeUndefined();
  });

  test("parses option positions with broker contract metadata", () => {
    const xml = `
      <FlexQueryResponse>
        <OpenPositions>
          <OpenPosition accountId="DU12345" symbol="SPY  260619C00500000" description="SPY Jun19'26 500 Call" assetCategory="OPT" position="2" costBasisPrice="4.25" currency="USD" exchange="SMART" conid="123456" listingExchange="SMART" multiplier="100" expiry="20260619" strike="500" putCall="CALL" localSymbol="SPY  260619C00500000" tradingClass="SPY" />
        </OpenPositions>
      </FlexQueryResponse>
    `;

    const positions = parseFlexPositions(xml);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.ticker).toBe("SPY  260619C00500000");
    expect(positions[0]?.side).toBe("long");
    expect(positions[0]?.brokerContract).toEqual({
      brokerId: "ibkr",
      conId: 123456,
      symbol: "SPY  260619C00500000",
      localSymbol: "SPY  260619C00500000",
      secType: "OPT",
      exchange: "SMART",
      primaryExchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: "20260619",
      right: "C",
      strike: 500,
      multiplier: "100",
      tradingClass: "SPY",
    });
  });

  test("treats a negative Flex position without a side attribute as a short", () => {
    const xml = `
      <FlexQueryResponse>
        <OpenPositions>
          <OpenPosition accountId="DU12345" symbol="TSLA" assetCategory="STK" position="-50" costBasisPrice="200" currency="USD" listingExchange="NASDAQ" />
        </OpenPositions>
      </FlexQueryResponse>
    `;

    const positions = parseFlexPositions(xml);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      ticker: "TSLA",
      shares: 50,
      side: "short",
    });
  });
});

describe("parseFlexAccounts", () => {
  test("parses cash balances and summary values from a flex statement", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="1">
          <FlexStatement accountId="DU12345" fromDate="20260327" toDate="20260327" whenGenerated="20260328;102707">
            <ChangeInNAV accountId="DU12345" acctAlias="Main" currency="USD" endingValue="764713.626876249" />
            <CashReport>
              <CashReportCurrency accountId="DU12345" currency="BASE_SUMMARY" endingCash="-1050953.720462251" endingSettledCash="-917604.448220862" />
            </CashReport>
            <FxPositions>
              <FxPosition accountId="DU12345" assetCategory="CASH" functionalCurrency="USD" fxCurrency="USD" quantity="-303029.144938754" value="-303029.144938754" />
              <FxPosition accountId="DU12345" assetCategory="CASH" functionalCurrency="USD" fxCurrency="EUR" quantity="-351957.025" value="-405102.535775" />
            </FxPositions>
            <OpenPositions>
              <OpenPosition accountId="DU12345" symbol="AAPL" assetCategory="STK" position="100" currency="USD" positionValue="100000" fxRateToBase="1" />
              <OpenPosition accountId="DU12345" symbol="ASML" assetCategory="STK" position="10" currency="EUR" positionValue="50000" fxRateToBase="1.2" />
            </OpenPositions>
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    const accounts = parseFlexAccounts(xml);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      accountId: "DU12345",
      name: "Main",
      currency: "USD",
      source: "flex",
      asOfDate: "2026-03-27",
      netLiquidation: 764713.626876249,
      grossPositionValue: 160000,
      totalCashValue: -1050953.720462251,
      settledCash: -917604.448220862,
      cashBalances: [
        {
          currency: "USD",
          quantity: -303029.144938754,
          baseValue: -303029.144938754,
          baseCurrency: "USD",
        },
        {
          currency: "EUR",
          quantity: -351957.025,
          baseValue: -405102.535775,
          baseCurrency: "USD",
        },
      ],
    });
    expect(accounts[0]?.updatedAt).toBe(new Date(2026, 2, 28, 10, 27, 7).getTime());
  });

  test("handles missing cash sections gracefully", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="1">
          <FlexStatement accountId="DU12345" fromDate="20260327" toDate="20260327">
            <ChangeInNAV accountId="DU12345" currency="USD" endingValue="12345.67" />
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    expect(parseFlexAccounts(xml)).toEqual([
      {
        accountId: "DU12345",
        name: "DU12345",
        currency: "USD",
        source: "flex",
        updatedAt: new Date(2026, 2, 27).getTime(),
        asOfDate: "2026-03-27",
        netLiquidation: 12345.67,
        grossPositionValue: undefined,
        totalCashValue: undefined,
        settledCash: undefined,
        cashBalances: undefined,
      },
    ]);
  });
});

describe("parseFlexPortfolioPerformance", () => {
  test("parses historical NAV rows when a Flex query includes them", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="2">
          <FlexStatement accountId="DU12345" fromDate="20260514" toDate="20260514">
            <ChangeInNAV accountId="DU12345" currency="USD" endingValue="100000" cumulativeReturn="0" />
          </FlexStatement>
          <FlexStatement accountId="DU12345" fromDate="20260515" toDate="20260515">
            <ChangeInNAV accountId="DU12345" currency="USD" endingValue="101500" cumulativeReturn="1.5" />
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    expect(parseFlexPortfolioPerformance(xml, "DU12345", 123)).toEqual({
      accountId: "DU12345",
      source: "flex",
      period: "FLEX",
      currency: "USD",
      fetchedAt: 123,
      startDate: "2026-05-14",
      endDate: "2026-05-15",
      points: [
        { date: "2026-05-14", value: 100000, cumulativeReturn: 0 },
        { date: "2026-05-15", value: 101500, cumulativeReturn: 0.015 },
      ],
    });
  });

  test("matches account aliases in single-account Flex history statements", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="1">
          <FlexStatement accountId="U12345" acctAlias="alias-account" fromDate="20260514" toDate="20260515">
            <ChangeInNAV accountId="U12345" currency="USD" reportDate="20260514" endingValue="100000" cumulativeReturn="0" />
            <ChangeInNAV accountId="U12345" currency="USD" reportDate="20260515" endingValue="101000" cumulativeReturn="1.5" />
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    const performance = parseFlexPortfolioPerformance(xml, "alias-account", 123);

    expect(performance?.accountId).toBe("alias-account");
    expect(performance?.points).toEqual([
      { date: "2026-05-14", value: 100000, cumulativeReturn: 0 },
      { date: "2026-05-15", value: 101000, cumulativeReturn: 0.015 },
    ]);
  });

  test("does not match a different account in multi-account Flex history statements", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="2">
          <FlexStatement accountId="U12345" fromDate="20260514" toDate="20260514">
            <ChangeInNAV accountId="U12345" currency="USD" endingValue="100000" />
          </FlexStatement>
          <FlexStatement accountId="U67890" fromDate="20260514" toDate="20260514">
            <ChangeInNAV accountId="U67890" currency="USD" endingValue="200000" />
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    expect(parseFlexPortfolioPerformance(xml, "alias-account", 123)).toBeNull();
  });

  test("requires a declared identity and rejects foreign child rows regardless of statement count", () => {
    const matching = `<FlexStatement accountId="U111"><ChangeInNAV reportDate="20260901" endingValue="10000" /></FlexStatement>`;
    for (const candidate of [
      `<FlexStatement accountId="U222"><ChangeInNAV accountId="U222" reportDate="20260901" endingValue="99999" /></FlexStatement>`,
      `<FlexStatement><ChangeInNAV reportDate="20260901" endingValue="99999" /></FlexStatement>`,
      `<FlexStatement><ChangeInNAV accountId="U222" reportDate="20260901" endingValue="99999" /></FlexStatement>`,
      `<FlexStatement accountId="U111"><ChangeInNAV accountId="U222" acctAlias="U111" reportDate="20260901" endingValue="99999" /></FlexStatement>`,
    ]) {
      expect(parseFlexPortfolioPerformance(`<FlexStatements>${candidate}</FlexStatements>`, "U111")).toBeNull();
      const selected = parseFlexPortfolioPerformance(`<FlexStatements>${matching}${candidate}</FlexStatements>`, "U111");
      expect(selected?.points).toEqual([{ date: "2026-09-01", value: 10000, cumulativeReturn: undefined }]);
    }
    expect(parseFlexPortfolioPerformance(matching, "undeclared-alias")).toBeNull();
  });

  test("selects declared row aliases under consistent parents with one or multiple statements", () => {
    const other = `<FlexStatement accountId="U222"><ChangeInNAV accountId="U222" reportDate="20260901" endingValue="99999" /></FlexStatement>`;
    for (const alias of ["acctAlias", "accountAlias", "alias", "name"]) {
      const matching = `<FlexStatement accountId="U111"><ChangeInNAV accountId="U111" ${alias}="Personal" reportDate="20260901" endingValue="10000" /></FlexStatement>`;
      for (const tail of ["", other]) {
        const selected = parseFlexPortfolioPerformance(`<FlexStatements>${matching}${tail}</FlexStatements>`, "Personal");
        expect(selected?.accountId).toBe("Personal");
        expect(selected?.points[0]?.value).toBe(10000);
      }
    }
  });

  test("inherits matched parent identity or accepts an explicit row match without inventing an alias mapping", () => {
    const cases = [
      { statement: 'accountId="U111"', row: "", request: "U111", accepted: true },
      { statement: "", row: 'accountId="U111"', request: "U111", accepted: true },
      { statement: 'acctAlias="Personal"', row: "", request: "Personal", accepted: true },
      { statement: "", row: 'acctAlias="Personal"', request: "Personal", accepted: true },
      { statement: 'acctAlias="Personal"', row: 'accountId="U111"', request: "Personal", accepted: false },
    ];
    for (const entry of cases) {
      const xml = `<FlexStatement ${entry.statement}><ChangeInNAV ${entry.row} reportDate="20260901" endingValue="10000" /></FlexStatement>`;
      const selected = parseFlexPortfolioPerformance(xml, entry.request);
      expect(selected?.points[0]?.value ?? null).toBe(entry.accepted ? 10000 : null);
    }
  });

  test("rejects a shared alias spanning canonical accounts before daily deduplication", () => {
    for (const secondDate of ["20260901", "20260902"]) {
      const xml = `<FlexStatements>
        <FlexStatement accountId="U111" acctAlias="Personal"><ChangeInNAV reportDate="20260901" endingValue="10000" /></FlexStatement>
        <FlexStatement accountId="U222" acctAlias="Personal"><ChangeInNAV reportDate="${secondDate}" endingValue="20000" /></FlexStatement>
      </FlexStatements>`;
      expect(parseFlexPortfolioPerformance(xml, "Personal")).toBeNull();
      expect(parseFlexPortfolioPerformance(xml, "U111")?.points.map((point) => point.value)).toEqual([10000]);
      expect(parseFlexPortfolioPerformance(xml, "U222")?.points.map((point) => point.value)).toEqual([20000]);
    }
  });

  test("rejects row-alias and canonical-token collisions while preserving repeated history for one account", () => {
    const row = (accountId: string, date: string, alias: string) => `<ChangeInNAV accountId="${accountId}" acctAlias="${alias}" reportDate="${date}" endingValue="10000" />`;
    const anonymousParent = (rows: string) => `<FlexStatement>${rows}</FlexStatement>`;
    expect(parseFlexPortfolioPerformance(anonymousParent(row("U111", "20260901", "Personal") + row("U222", "20260902", "Personal")), "Personal")).toBeNull();
    expect(parseFlexPortfolioPerformance(anonymousParent(row("U111", "20260901", "Personal") + row("U222", "20260902", "U111")), "U111")).toBeNull();
    for (const useStatementAlias of [false, true]) {
      const xml = ["20260901", "20260902"].map((date) => useStatementAlias
        ? `<FlexStatement accountId="U111" acctAlias="Personal"><ChangeInNAV reportDate="${date}" endingValue="10000" /></FlexStatement>`
        : anonymousParent(row("U111", date, "Personal"))).join("");
      const selected = parseFlexPortfolioPerformance(xml, "Personal");
      expect(selected?.points.map((point) => point.date)).toEqual(["2026-09-01", "2026-09-02"]);
      expect(selected?.points.map((point) => point.value)).toEqual([10000, 10000]);
    }
  });

  test("matches decoded XML identity attributes once without treating encoded requests as aliases", () => {
    for (const [encoded, decoded] of [
      ["Personal &amp; Joint", "Personal & Joint"],
      ["Personal &lt;Joint&gt;", "Personal <Joint>"],
      ["Personal &quot;Joint&quot; &apos;Alias&apos;", `Personal "Joint" 'Alias'`],
      ["Personal &#38; Joint", "Personal & Joint"],
      ["Personal &#x26; Joint", "Personal & Joint"],
      ["Joint &#x1F600;", "Joint 😀"],
      ["Personal &amp;amp; Joint", "Personal &amp; Joint"],
    ]) {
      for (const statementAlias of [true, false]) {
        const xml = `<FlexStatement accountId="U&#49;11" ${statementAlias ? `acctAlias="${encoded}"` : ""}>
          <ChangeInNAV accountId="U111" ${statementAlias ? "" : `acctAlias="${encoded}"`} reportDate="20260901" endingValue="10000" />
        </FlexStatement>`;
        expect(parseFlexPortfolioPerformance(xml, decoded!)?.points[0]?.value).toBe(10000);
        expect(parseFlexPortfolioPerformance(xml, encoded!)).toBeNull();
      }
    }
  });

  test("compares decoded canonical IDs and shared aliases consistently", () => {
    const statement = (accountId: string, alias: string, date: string) => `<FlexStatement accountId="${accountId}" acctAlias="${alias}"><ChangeInNAV reportDate="${date}" endingValue="10000" /></FlexStatement>`;
    const first = statement("U&#49;11", "Personal &amp; Joint", "20260901");
    const repeated = first + statement("U111", "Personal &#38; Joint", "20260902");
    expect(parseFlexPortfolioPerformance(repeated, "Personal & Joint")?.points).toHaveLength(2);
    expect(parseFlexPortfolioPerformance(repeated, "U111")?.points).toHaveLength(2);
    expect(parseFlexPortfolioPerformance(first + statement("U222", "Personal &#x26; Joint", "20260902"), "Personal & Joint")).toBeNull();
  });

  test("detects declared statement alias collisions even when the other account has no usable history", () => {
    const statement = (accountId: string, alias: string, body: string) => `<FlexStatement accountId="${accountId}" acctAlias="${alias}">${body}</FlexStatement>`;
    const known = statement("U111", "Personal", '<ChangeInNAV reportDate="20260901" endingValue="10000" />');
    for (const body of [
      "",
      '<ChangeInNAV reportDate="20260902" />',
      '<ChangeInNAV endingValue="20000" />',
      '<ChangeInNAV reportDate="20260902" twr="1" />',
    ]) {
      const ambiguous = statement("U222", "Personal", body);
      for (const xml of [known + ambiguous, ambiguous + known]) {
        expect(parseFlexPortfolioPerformance(xml, "Personal")).toBeNull();
        expect(parseFlexPortfolioPerformance(xml, "U111")?.points[0]?.value).toBe(10000);
      }
      expect(parseFlexPortfolioPerformance(known + statement("U222", "Other", body), "Personal")?.points[0]?.value).toBe(10000);
      expect(parseFlexPortfolioPerformance(known + statement("U111", "Personal", body), "Personal")?.points[0]?.value).toBe(10000);
    }
  });

  test("detects consistent matched row identities before date and value parsing", () => {
    const known = '<FlexStatement><ChangeInNAV accountId="U111" acctAlias="Personal" reportDate="20260901" endingValue="10000" /></FlexStatement>';
    for (const fields of ["", 'reportDate="20260902"', 'endingValue="20000"', 'reportDate="20260902" twr="1"']) {
      const row = `<ChangeInNAV accountId="U222" acctAlias="Personal" ${fields} />`;
      const ambiguous = `<FlexStatement>${row}</FlexStatement>`;
      for (const xml of [known + ambiguous, ambiguous + known]) {
        expect(parseFlexPortfolioPerformance(xml, "Personal")).toBeNull();
        expect(parseFlexPortfolioPerformance(xml, "U111")?.points[0]?.value).toBe(10000);
      }
      // An inconsistent child does not establish a second identity.
      expect(parseFlexPortfolioPerformance(known + `<FlexStatement accountId="U333">${row}</FlexStatement>`, "Personal")?.points[0]?.value).toBe(10000);
    }
  });
});

describe("requestFlexStatement", () => {
  test("decodes XML response references once and retains invalid character references", async () => {
    for (const [encoded, decoded] of [
      ["&amp; &lt; &gt; &quot; &apos;", `& < > " '`],
      ["&#38; &#x26; &#x1F600;", "& & 😀"],
      ["&amp;lt; &amp;#38;", "&lt; &#38;"],
      ["&#9;&#10;&#13;", "\t\n\r"],
      ["&#0; &#x1F; &#xD800; &#xDFFF; &#xFFFE; &#xFFFF; &#x110000;", "&#0; &#x1F; &#xD800; &#xDFFF; &#xFFFE; &#xFFFF; &#x110000;"],
      ["&#-1; &#xZZ; &#; &unknown; &amp", "&#-1; &#xZZ; &#; &unknown; &amp"],
    ]) {
      setHttpFetchTransport(async () => new Response(`<FlexStatementResponse><ReferenceCode>${encoded}</ReferenceCode></FlexStatementResponse>`));
      expect(await requestFlexStatement({ token: "fixture", queryId: "fixture", endpoint: "https://fixture.invalid/SendRequest" })).toBe(decoded!);
    }
  });

  test("uses the configured HTTP transport for statement requests", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    setHttpFetchTransport(async (url, init) => {
      requests.push({ url, init });
      return new Response(
        "<FlexStatementResponse><ReferenceCode>987654</ReferenceCode></FlexStatementResponse>",
        { status: 200 },
      );
    });

    await expect(requestFlexStatement({
      token: "secret-flex-token",
      queryId: "12345",
      endpoint: "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest",
    })).resolves.toBe("987654");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("q=12345");
    expect((requests[0]?.init?.headers as Record<string, string> | undefined)?.["User-Agent"]).toBeTruthy();
  });

  test("adds request context to vague IBKR Flex errors without exposing the token", async () => {
    globalThis.fetch = (async () => new Response(
      "<FlexStatementResponse><ErrorCode>1001</ErrorCode><ErrorMessage>Load failed</ErrorMessage></FlexStatementResponse>",
      { status: 200 },
    )) as unknown as typeof fetch;

    let message = "";
    try {
      await requestFlexStatement({
        token: "secret-flex-token",
        queryId: "12345",
        endpoint: "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("IBKR Flex request failed while requesting the statement: IBKR error 1001: Load failed.");
    expect(message).toContain("Endpoint SendRequest");
    expect(message).toContain("query ID 12345");
    expect(message).toContain("token configured");
    expect(message).toContain("Flex Web Service is enabled");
    expect(message).not.toContain("secret-flex-token");
  });
});

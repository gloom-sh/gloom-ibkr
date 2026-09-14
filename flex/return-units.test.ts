import { expect, test } from "bun:test";
import { parseFlexPortfolioPerformance } from "./index";

const statement = (attributes: string) => `<FlexStatements><FlexStatement accountId="CONTROLLED"><ChangeInNAV accountId="CONTROLLED" reportDate="20260901" currency="USD" ${attributes}/></FlexStatement></FlexStatements>`;

test.each(["cumulativeReturn", "timeWeightedReturnCumulative", "twrCumulative"])("%s uses the accepted cumulative percentage-point contract on both sides of one", (alias) => {
  for (const [raw, expected] of [[-150, -1.5], [-1.01, -.0101], [-1, -.01], [-.99, -.0099],
    [0, 0], [.5, .005], [.99, .0099], [1, .01], [1.01, .0101], [1.5, .015], [150, 1.5]] as const) {
    const point = parseFlexPortfolioPerformance(statement(`${alias}="${raw}" endingValue="21000" deposits="10000"`), "CONTROLLED", 1)?.points[0];
    expect(point).toMatchObject({ date: "2026-09-01", value: 21000 });
    expect(point?.cumulativeReturn).toBeCloseTo(expected, 12);
  }
});

test("period TWR and MWR do not become cumulative returns or suppress independently supplied NAV", () => {
  for (const returns of ['twr="0.5"', 'mwr="150"', 'twr="1" mwr="2"']) {
    expect(parseFlexPortfolioPerformance(statement(returns), "CONTROLLED", 1)).toBeNull();
    const performance = parseFlexPortfolioPerformance(statement(`${returns} endingValue="21000" deposits="10000"`), "CONTROLLED", 1);
    expect(performance?.points).toEqual([{ date: "2026-09-01", value: 21000, cumulativeReturn: undefined }]);
    expect(performance?.currency).toBe("USD");
  }
  expect(parseFlexPortfolioPerformance(statement('cumulativeReturn="0.5" twr="10" mwr="20"'), "CONTROLLED", 1)?.points[0]?.cumulativeReturn).toBe(.005);
  expect(parseFlexPortfolioPerformance(statement('cumulativeReturn="0" timeWeightedReturnCumulative="20"'), "CONTROLLED", 1)?.points[0]?.cumulativeReturn).toBe(0);
});

test("unavailable cumulative fields cannot borrow a period return", () => {
  for (const value of ["", " ", "invalid", "NaN", "Infinity"]) {
    expect(parseFlexPortfolioPerformance(statement(`cumulativeReturn="${value}" twr="1.5" mwr="2"`), "CONTROLLED", 1)).toBeNull();
    expect(parseFlexPortfolioPerformance(statement(`cumulativeReturn="${value}" endingValue="0"`), "CONTROLLED", 1)?.points[0]?.value).toBe(0);
  }
});

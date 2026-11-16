import SwiftUI
import XCTest
@testable import SocraticTrade

/// The login wordmark sat frozen on one frame while the website's identical ticker moved.
/// The cause was the SCHEDULE (`.periodic(from: .now, …)` re-anchoring on every body
/// evaluation), which no unit test can observe — but these pin the half that a test can:
/// that advancing the tick genuinely changes what gets drawn, so the schedule is the only
/// remaining variable, and that the model matches the web ticker it is a port of.
final class CandleWordmarkTests: XCTestCase {
    private var model: (wm: Wordmark, units: [TickerUnit]) { CandleWordmarkModel.shared }

    func testWordmarkSamplesIntoRealCells() {
        XCTAssertFalse(model.wm.cells.isEmpty, "the wordmark rasterized to nothing")
        XCTAssertGreaterThan(model.wm.ncol, 1)
        XCTAssertEqual(model.wm.hcol.count, model.wm.cells.count)
        XCTAssertEqual(model.wm.hshort.count, model.wm.cells.count)
        XCTAssertGreaterThan(model.wm.ar, 0)
    }

    func testTickerUnitsAreVariedRatherThanOneFlatBlock() {
        let units = model.units
        XCTAssertGreaterThan(units.count, 1)
        // A ticker where every unit matched would still "animate" and look static.
        XCTAssertGreaterThan(Set(units.map { $0.frac }).count, 1, "all body fractions identical")
        XCTAssertGreaterThan(Set(units.map { $0.off }).count, 1, "all candles the same direction")
    }

    /// Column index for cell `j` at `tick` — the exact expression `drawTicker` uses, and
    /// the same one as `drawTicker` in app/ui/brand/candle-ticker.ts.
    private func unitIndex(cell j: Int, tick: Int) -> Int {
        let p = model.units.count
        return ((model.wm.hcol[j] + tick) % p + p) % p
    }

    private func frame(at tick: Int) -> [Int] {
        (0..<model.wm.cells.count).map { unitIndex(cell: $0, tick: tick) }
    }

    func testEverySuccessiveTickDrawsADifferentFrame() {
        // If this ever passed trivially, the "animation" would be a no-op no matter how
        // often the schedule fired.
        for tick in 0..<model.units.count {
            XCTAssertNotEqual(frame(at: tick), frame(at: tick + 1), "tick \(tick) -> \(tick + 1) drew the same frame")
        }
    }

    func testTheTickerMarchesExactlyOneColumnPerTick() {
        // Advancing the tick by one shifts every cell's unit by one — that is what makes it
        // read as a ticker scrolling left rather than as random recolouring.
        let p = model.units.count
        for j in 0..<model.wm.cells.count {
            XCTAssertEqual(unitIndex(cell: j, tick: 1), (unitIndex(cell: j, tick: 0) + 1) % p)
        }
    }

    func testTheCycleClosesSoTheMarkNeverJumps() {
        XCTAssertEqual(frame(at: 0), frame(at: model.units.count), "wrap-around is not seamless")
    }

    func testNegativeAndLargeTicksStayInRange() {
        // `Int(date.timeIntervalSince(start))` is negative for one frame if the clock steps
        // backwards; the modulo has to survive it rather than trap.
        for tick in [-7, -1, 0, 1, 10_000] {
            for j in 0..<model.wm.cells.count {
                let index = unitIndex(cell: j, tick: tick)
                XCTAssertTrue(model.units.indices.contains(index), "tick \(tick) produced index \(index)")
            }
        }
    }
}

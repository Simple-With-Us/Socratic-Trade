import XCTest
@testable import SocraticTrade

/// Pure layout math for the whole app, kept out of SwiftUI so it can be asserted directly:
/// `WrappingHStackLayout` (watchlist chip wrap), `ContentColumns` + `CardColumnsLayout` (the
/// iPad / Mac dashboard card flow), and `AppMetricGridColumns` (metric tiles per card).
///
/// File is `LayoutMathTests.swift` (renamed from `WrappingHStackTests.swift`).  XCTest class
/// names stay so `-only-testing:SocraticTradeTests/WrappingHStackTests` (and the sibling
/// classes in this file) keep working.
final class WrappingHStackTests: XCTestCase {
    func testKeepsItemsOnOneLineWhenTheyFit() {
        let result = WrappingHStackLayout.place(
            widths: [100, 100],
            heights: [44, 44],
            containerWidth: 250,
            spacing: 8,
            lineSpacing: 8
        )

        XCTAssertEqual(result.origins, [CGPoint(x: 0, y: 0), CGPoint(x: 108, y: 0)])
        XCTAssertEqual(result.size, CGSize(width: 208, height: 44))
    }

    func testWrapsWhenARowWouldOverflow() {
        let result = WrappingHStackLayout.place(
            widths: [120, 120],
            heights: [44, 44],
            containerWidth: 200,
            spacing: 8,
            lineSpacing: 8
        )

        XCTAssertEqual(result.origins, [CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 52)])
        XCTAssertEqual(result.size, CGSize(width: 120, height: 96))
    }

    func testUnlimitedWidthNeverWraps() {
        let result = WrappingHStackLayout.place(
            widths: [180, 180, 180],
            heights: [40, 40, 40],
            containerWidth: .infinity,
            spacing: 8,
            lineSpacing: 8
        )

        XCTAssertEqual(result.origins.map(\.y), [0, 0, 0])
        XCTAssertEqual(result.size, CGSize(width: 556, height: 40))
    }

    func testWatchlistChipBudgetDoesNotFitTheOldAdaptiveMinimum() {
        // logo 18 + gaps 12 + 4-letter ticker ~40 + 44pt remove + leading 10 + trailing 2
        let fourLetterChip: CGFloat = 18 + 6 + 40 + 6 + 44 + 10 + 2
        XCTAssertGreaterThan(
            fourLetterChip,
            92,
            "The retired GridItem(.adaptive(minimum: 92)) was narrower than a logo+SPCX+remove chip, which is why tickers wrapped mid-symbol."
        )
        XCTAssertLessThan(
            fourLetterChip,
            180,
            "Two typical chips plus the 8pt gutter still fit a phone-width watchlist card."
        )
    }

    func testEmptySubviewsHaveZeroSize() {
        let result = WrappingHStackLayout.place(
            widths: [],
            heights: [],
            containerWidth: 320,
            spacing: 8,
            lineSpacing: 8
        )
        XCTAssertEqual(result.size, .zero)
        XCTAssertTrue(result.origins.isEmpty)
    }
}

// MARK: - Dashboard card flow (iPad Air 11" / Mac)

/// iPad Air 11" is 820pt wide in portrait and 1180pt in landscape; `SnapshotScaffold` takes
/// 16pt of padding off each side before the cards see the width.
final class ContentColumnsTests: XCTestCase {
    private let portraitCardArea: CGFloat = 820 - 32
    private let landscapeCardArea: CGFloat = 1180 - 32

    func testCompactWidthAlwaysGetsOneColumn() {
        XCTAssertEqual(ContentColumns.count(width: 390 - 32, isRegularWidth: false), 1)
        // Wide but compact — an iPad in Slide Over — still renders the phone stack.
        XCTAssertEqual(ContentColumns.count(width: landscapeCardArea, isRegularWidth: false), 1)
    }

    func testIPadAir11PortraitGetsTwoColumnsAndLandscapeThree() {
        XCTAssertEqual(ContentColumns.count(width: portraitCardArea, isRegularWidth: true), 2)
        XCTAssertEqual(ContentColumns.count(width: landscapeCardArea, isRegularWidth: true), 3)
    }

    func testEveryColumnStaysWiderThanAPhoneCard() {
        // The point of the breakpoints: no column may end up narrower than the ~326pt a phone
        // card already gets, or the split makes the app harder to read rather than easier.
        let phoneCard: CGFloat = 390 - 32
        for width in [portraitCardArea, landscapeCardArea, ContentColumns.maximumContentWidth - 32] {
            let columns = ContentColumns.count(width: width, isRegularWidth: true)
            let column = CardColumnsLayout.columnWidth(containerWidth: width, columns: columns, columnSpacing: 14)
            XCTAssertGreaterThan(column, phoneCard, "column at \(width)pt across \(columns) columns")
        }
    }

    func testNarrowMacWindowFallsBackToOneColumn() {
        XCTAssertEqual(ContentColumns.count(width: 600, isRegularWidth: true), 1)
        XCTAssertEqual(ContentColumns.count(width: ContentColumns.twoColumnMinimum, isRegularWidth: true), 2)
        XCTAssertEqual(ContentColumns.count(width: ContentColumns.threeColumnMinimum, isRegularWidth: true), 3)
    }

    func testUnmeasuredWidthGetsOneColumn() {
        XCTAssertEqual(ContentColumns.count(width: 0, isRegularWidth: true), 1)
        XCTAssertEqual(ContentColumns.count(width: .infinity, isRegularWidth: true), 1)
    }
}

final class CardColumnsLayoutTests: XCTestCase {
    func testColumnWidthSplitsTheGutters() {
        XCTAssertEqual(CardColumnsLayout.columnWidth(containerWidth: 788, columns: 2, columnSpacing: 14), 387)
        XCTAssertEqual(
            CardColumnsLayout.columnWidth(containerWidth: 1148, columns: 3, columnSpacing: 14),
            (1148 - 28) / 3,
            accuracy: 0.001
        )
        XCTAssertEqual(CardColumnsLayout.columnWidth(containerWidth: 326, columns: 1, columnSpacing: 14), 326)
    }

    func testOneColumnIsAPlainStack() {
        let result = CardColumnsLayout.place(
            heights: [100, 50],
            spans: [false, false],
            containerWidth: 300,
            columns: 1,
            spacing: 14,
            columnSpacing: 14
        )
        XCTAssertEqual(result.frames, [
            CGRect(x: 0, y: 0, width: 300, height: 100),
            CGRect(x: 0, y: 114, width: 300, height: 50)
        ])
        // The trailing gap after the last card is not part of the content height.
        XCTAssertEqual(result.size, CGSize(width: 300, height: 164))
    }

    func testCardsDropIntoTheShortestColumn() {
        let result = CardColumnsLayout.place(
            heights: [100, 40, 40],
            spans: [false, false, false],
            containerWidth: 214,
            columns: 2,
            spacing: 14,
            columnSpacing: 14
        )
        XCTAssertEqual(result.frames, [
            CGRect(x: 0, y: 0, width: 100, height: 100),
            CGRect(x: 114, y: 0, width: 100, height: 40),
            // Not under the 100pt card — the right column is still shorter.
            CGRect(x: 114, y: 54, width: 100, height: 40)
        ])
        XCTAssertEqual(result.size.height, 100)
    }

    func testASpanningCardClearsEveryColumnAndStartsAFreshRow() {
        let result = CardColumnsLayout.place(
            heights: [30, 100, 40],
            spans: [true, false, false],
            containerWidth: 214,
            columns: 2,
            spacing: 14,
            columnSpacing: 14
        )
        XCTAssertEqual(result.frames[0], CGRect(x: 0, y: 0, width: 214, height: 30))
        XCTAssertEqual(result.frames[1], CGRect(x: 0, y: 44, width: 100, height: 100))
        XCTAssertEqual(result.frames[2], CGRect(x: 114, y: 44, width: 100, height: 40))
        XCTAssertEqual(result.size.height, 144)
    }

    func testASpanningCardWaitsForTheTallestColumn() {
        let result = CardColumnsLayout.place(
            heights: [80, 20, 30],
            spans: [false, false, true],
            containerWidth: 214,
            columns: 2,
            spacing: 14,
            columnSpacing: 14
        )
        // Columns sit at 94 and 34; the banner has to start below BOTH.
        XCTAssertEqual(result.frames[2], CGRect(x: 0, y: 94, width: 214, height: 30))
        XCTAssertEqual(result.size.height, 124)
    }

    func testTiesKeepReadingOrderByStayingLeft() {
        let result = CardColumnsLayout.place(
            heights: [40, 40, 40],
            spans: [false, false, false],
            containerWidth: 214,
            columns: 2,
            spacing: 14,
            columnSpacing: 14
        )
        XCTAssertEqual(result.frames.map(\.minX), [0, 114, 0])
    }

    func testEmptyContentHasZeroSize() {
        let result = CardColumnsLayout.place(
            heights: [],
            spans: [],
            containerWidth: 788,
            columns: 2,
            spacing: 14,
            columnSpacing: 14
        )
        XCTAssertEqual(result.size, .zero)
        XCTAssertTrue(result.frames.isEmpty)
    }
}

final class AppMetricGridColumnsTests: XCTestCase {
    private let spacing: CGFloat = 10
    private let tile: CGFloat = 178

    func testPhoneCardKeepsTwoTilesAcross() {
        // 390pt phone, 16pt scaffold padding and 16pt card padding on each side.
        XCTAssertEqual(AppMetricGridColumns.count(width: 390 - 64, minimumTileWidth: tile, spacing: spacing), 2)
    }

    func testUnmeasuredWidthAnswersTwoSoNothingReflowsAfterTheFirstPass() {
        XCTAssertEqual(AppMetricGridColumns.count(width: 0, minimumTileWidth: tile, spacing: spacing), 2)
    }

    func testATwoColumnIPadCardStillHoldsTwoTiles() {
        // 387pt column, less the card's own 16pt padding on each side.
        XCTAssertEqual(AppMetricGridColumns.count(width: 387 - 32, minimumTileWidth: tile, spacing: spacing), 2)
    }

    func testAFullWidthCardOnAWideWindowHoldsFour() {
        XCTAssertEqual(AppMetricGridColumns.count(width: 1148 - 32, minimumTileWidth: tile, spacing: spacing), 4)
        XCTAssertEqual(
            AppMetricGridColumns.count(width: 4000, minimumTileWidth: tile, spacing: spacing),
            AppMetricGridColumns.maximum
        )
    }
}

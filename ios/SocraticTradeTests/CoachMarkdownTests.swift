import XCTest
@testable import SocraticTrade

/// Coach replies arrive as markdown.  `Text(someString)` does not parse markdown —
/// SwiftUI only does that for `LocalizedStringKey` literals — so every reply used to
/// print its own syntax at the owner: `## Risk Check`, `- Trim`, `**NVDA**`, pipe tables.
///
/// These tests assert the two things that matter: the markers never reach the screen,
/// and the untrusted-content properties the web renderer documents hold here too.
final class CoachMarkdownTests: XCTestCase {

    // MARK: - Markers never reach the reader

    func testHeadingBulletAndBoldNeverPrintTheirMarkers() {
        let reply = """
        ## Risk Check

        Position **NVDA** is oversized.

        - Trim to 4% of NAV
        - Keep the protective exit
        """

        // The raw reply really does carry the syntax this renderer has to absorb.
        XCTAssertTrue(reply.contains("## "))
        XCTAssertTrue(reply.contains("**"))
        XCTAssertTrue(reply.contains("- "))

        XCTAssertEqual(
            CoachMarkdown.blocks(from: reply),
            [
                .heading(level: 2, text: "Risk Check"),
                .paragraph(text: "Position **NVDA** is oversized."),
                .bullet(text: "Trim to 4% of NAV"),
                .bullet(text: "Keep the protective exit")
            ]
        )

        let rendered = CoachMarkdown.plainText(from: reply)
        XCTAssertFalse(rendered.contains("#"), rendered)
        XCTAssertFalse(rendered.contains("**"), rendered)
        XCTAssertFalse(rendered.contains("- "), rendered)
        for line in rendered.components(separatedBy: "\n") {
            XCTAssertFalse(line.hasPrefix("-"), line)
            XCTAssertFalse(line.hasPrefix("*"), line)
        }
        // The words themselves survive.
        XCTAssertTrue(rendered.contains("Risk Check"), rendered)
        XCTAssertTrue(rendered.contains("Position NVDA is oversized."), rendered)
        XCTAssertTrue(rendered.contains("\u{2022} Trim to 4% of NAV"), rendered)
    }

    func testDeepHeadingsStillLoseTheirHashes() {
        // Only 1...3 get their own type ramp, but 4...6 must not leak "####" either.
        let rendered = CoachMarkdown.plainText(from: "#### Detail")
        XCTAssertEqual(rendered, "Detail")
        XCTAssertEqual(CoachMarkdown.blocks(from: "#### Detail"), [.heading(level: 3, text: "Detail")])
    }

    func testHashWithoutASpaceIsOrdinaryText() {
        // "#1 holding" is prose, not a heading.
        XCTAssertEqual(CoachMarkdown.blocks(from: "#1 holding"), [.paragraph(text: "#1 holding")])
    }

    func testOrderedListsKeepTheirNumbers() {
        XCTAssertEqual(
            CoachMarkdown.blocks(from: "1. Cut the position\n2. Re-check the stop"),
            [
                .ordered(number: "1", text: "Cut the position"),
                .ordered(number: "2", text: "Re-check the stop")
            ]
        )
        XCTAssertEqual(
            CoachMarkdown.plainText(from: "1. Cut the position\n2. Re-check the stop"),
            "1. Cut the position\n2. Re-check the stop"
        )
    }

    func testFencedCodeKeepsItsLinesAndDropsTheFence() {
        let reply = """
        ```swift
        let cap = 4
        ```
        """
        XCTAssertEqual(CoachMarkdown.blocks(from: reply), [.code("let cap = 4")])
        let rendered = CoachMarkdown.plainText(from: reply)
        XCTAssertEqual(rendered, "let cap = 4")
        XCTAssertFalse(rendered.contains("```"), rendered)
    }

    func testUnterminatedFenceStillRendersAsCode() {
        XCTAssertEqual(CoachMarkdown.blocks(from: "```\nlet cap = 4"), [.code("let cap = 4")])
    }

    func testPipeTableBecomesRowsNotPipes() {
        let reply = """
        | Symbol | Score |
        | --- | --- |
        | NVDA | 8.1 |
        | AMD | 6.4 |
        """
        XCTAssertEqual(
            CoachMarkdown.blocks(from: reply),
            [.table(header: ["Symbol", "Score"], rows: [["NVDA", "8.1"], ["AMD", "6.4"]])]
        )
        let rendered = CoachMarkdown.plainText(from: reply)
        XCTAssertFalse(rendered.contains("|"), rendered)
        XCTAssertFalse(rendered.contains("---"), rendered)
        XCTAssertTrue(rendered.contains("NVDA"), rendered)
    }

    func testPipesWithoutADelimiterRowStayProse() {
        // A lone pipe line is not a table; it must not silently lose its text.
        let reply = "| not a table"
        XCTAssertEqual(CoachMarkdown.blocks(from: reply), [.paragraph(text: "| not a table")])
    }

    // MARK: - Untrusted content (Coach text can carry RAG / tool output)

    func testRemoteImagesAreNeverLoadedOrLinked() {
        let reply = "Chart: ![NVDA chart](https://attacker.example/pixel.png)"
        let rendered = CoachMarkdown.plainText(from: reply)
        XCTAssertEqual(rendered, "Chart: [image: NVDA chart]")
        XCTAssertFalse(rendered.contains("https"), rendered)
        XCTAssertFalse(rendered.contains("attacker.example"), rendered)

        let attributed = CoachMarkdown.inline(reply)
        for run in attributed.runs {
            XCTAssertNil(run.imageURL, "an image URL survived into a run")
            XCTAssertNil(run.link, "an image became a link")
        }
    }

    func testImageWithNoAltStillCollapsesToAnInertLabel() {
        XCTAssertEqual(
            CoachMarkdown.plainText(from: "![](https://attacker.example/p.png)"),
            "[image]"
        )
    }

    func testImageAltCannotBreakOutIntoMarkup() {
        // Alt text is attacker-controlled too — it must not re-open a link or emphasis.
        let rendered = CoachMarkdown.plainText(from: "![a](https://x.example/1.png)(https://y.example/2.png)")
        XCTAssertFalse(rendered.contains("https://x.example"), rendered)
        let attributed = CoachMarkdown.inline("![](https://x.example/1.png)")
        for run in attributed.runs {
            XCTAssertNil(run.imageURL)
            XCTAssertNil(run.link)
        }
    }

    func testRawHtmlIsNeverInterpreted() {
        // There is no HTML engine in this path, so the assertion that matters is that
        // no HTML ever produces a fetching or navigable attribute.
        for reply in [
            "<img src=\"https://attacker.example/pixel.png\">",
            "<a href=\"https://attacker.example\">click me</a>",
            "<script>doSomething()</script>"
        ] {
            let attributed = CoachMarkdown.inline(reply)
            for run in attributed.runs {
                XCTAssertNil(run.imageURL, reply)
                XCTAssertNil(run.link, reply)
            }
        }
    }

    func testPlainProseIsUntouched() {
        let reply = "Nothing is staged right now.  Ask again after the next scan."
        XCTAssertEqual(CoachMarkdown.plainText(from: reply), reply)
    }
}

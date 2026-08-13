import XCTest
import UIKit
@testable import SocraticTrade

/// Guards the Lato bundling, which fails in a uniquely quiet way: if a UIAppFonts path is wrong,
/// a PostScript name is misspelled, or a .ttf stops being copied into the bundle, iOS registers
/// nothing, `UIFont(name:)` returns nil, SwiftUI substitutes SF Pro, and NOTHING is logged. The
/// app looks fine in a screenshot at a glance, so only an assertion catches it.
final class AppTypographyTests: XCTestCase {
    private let expectedFaces = [
        AppFont.regular,
        AppFont.bold,
        AppFont.black,
        "Lato-Italic"
    ]

    func testAppFontsAreRegistered() {
        for name in expectedFaces {
            XCTAssertNotNil(
                UIFont(name: name, size: 17),
                "\(name) did not register. Check UIAppFonts in Info.plist uses BARE filenames "
                    + "(no Fonts/ prefix — XcodeGen copies them to the bundle root) and that the "
                    + "PostScript name still matches the shipped TTF."
            )
        }
    }

    func testAppFontsAreLatoAndNotASystemFallback() {
        // UIFont(name:) returning non-nil is necessary but NOT sufficient — the real regression to
        // catch is a silent substitution, so assert the family that actually came back.
        for name in expectedFaces {
            XCTAssertEqual(UIFont(name: name, size: 17)?.familyName, "Lato", "\(name) resolved to the wrong family")
        }
    }

    func testUIFontHelperFallsBackInsteadOfCrashing() {
        // AppFont.uiFont must never force-unwrap: a typeface problem should degrade to the system
        // face, not take the app's chrome down at launch.
        XCTAssertEqual(AppFont.uiFont(17, weight: .bold).pointSize, 17)
        XCTAssertEqual(AppFont.uiFont(34, weight: .black).pointSize, 34)
    }
}

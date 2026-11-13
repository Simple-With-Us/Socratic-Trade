import SwiftUI
import UIKit

/// Lato everywhere — the same typeface the website loads (`app/fonts/lato.ts`), so the two
/// clients read as one product.  The faces are bundled under `Fonts/` and declared in
/// `UIAppFonts` (Info.plist + project.yml); SIL Open Font License 1.1, text in
/// `Fonts/LATO-OFL.txt`.
///
/// Why this file exists rather than a one-line global override: SwiftUI has no hook for
/// "replace the system face app-wide".  `.font(.caption)` and friends resolve to SF Pro
/// inside SwiftUI itself, so every semantic style needs a Lato twin, and the call sites use
/// it instead.  Each twin is built with `Font.custom(_:size:relativeTo:)`, NOT a fixed size,
/// so Dynamic Type still scales the whole app — a plain `.custom(_:size:)` would have frozen
/// text at one size and broken accessibility for the sake of a typeface.
///
/// Sizes are the stock iOS text-style sizes at the default content-size category, so swapping
/// `.caption` for `.appCaption` changes the face and nothing else.
enum AppFont {
    /// Family faces as registered by UIAppFonts.  These are PostScript names, not filenames —
    /// `UIFont(name:)` and `Font.custom` both key off the PostScript name, and getting it wrong
    /// fails SILENTLY back to the system font (the classic "my custom font didn't apply" bug).
    /// Verified against the shipped TTFs; `SocraticTradeTests` asserts each one still resolves.
    static let regular = "Lato-Regular"
    static let bold = "Lato-Bold"
    static let black = "Lato-Black"

    /// Lato at an explicit point size that still honours Dynamic Type, for the handful of places
    /// that need a specific size (icon-adjacent glyph rows, the login mark) rather than a style.
    static func sized(_ size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(regular, size: size, relativeTo: style)
    }

    /// UIKit twin of `sized`, for the appearance proxies below.
    static func uiFont(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        let name = weight == .regular ? regular : (weight == .black ? black : bold)
        guard let font = UIFont(name: name, size: size) else {
            // Never crash over a typeface: if registration failed, keep the system face.
            return UIFont.systemFont(ofSize: size, weight: weight)
        }
        return font
    }
}

/// UIKit chrome fonts scaled for Dynamic Type with a ceiling so nav/tab chrome stays usable.
enum AppChromeFontScaling {
    struct ChromeFontSpec {
        let basePointSize: CGFloat
        let textStyle: UIFont.TextStyle
        let weight: UIFont.Weight
        let maximumPointSize: CGFloat

        static let navigationTitle = ChromeFontSpec(
            basePointSize: 17,
            textStyle: .headline,
            weight: .bold,
            maximumPointSize: 23
        )
        static let navigationLargeTitle = ChromeFontSpec(
            basePointSize: 34,
            textStyle: .largeTitle,
            weight: .bold,
            maximumPointSize: 41
        )
        static let tabBarItem = ChromeFontSpec(
            basePointSize: 10,
            textStyle: .caption2,
            weight: .regular,
            maximumPointSize: 13
        )
        static let segmentedControl = ChromeFontSpec(
            basePointSize: 13,
            textStyle: .footnote,
            weight: .regular,
            maximumPointSize: 17
        )
    }

    static let navigationTitle = ChromeFontSpec.navigationTitle
    static let navigationLargeTitle = ChromeFontSpec.navigationLargeTitle
    static let tabBarItem = ChromeFontSpec.tabBarItem
    static let segmentedControl = ChromeFontSpec.segmentedControl

    static func scaledUIFont(
        _ spec: ChromeFontSpec,
        contentSizeCategory: UIContentSizeCategory = UIApplication.shared.preferredContentSizeCategory
    ) -> UIFont {
        let base = AppFont.uiFont(spec.basePointSize, weight: spec.weight)
        let metrics = UIFontMetrics(forTextStyle: spec.textStyle)
        let traits = UITraitCollection(preferredContentSizeCategory: contentSizeCategory)
        return metrics.scaledFont(
            for: base,
            maximumPointSize: spec.maximumPointSize,
            compatibleWith: traits
        )
    }
}

extension Font {
    static let appLargeTitle = Font.custom(AppFont.regular, size: 34, relativeTo: .largeTitle)
    static let appTitle = Font.custom(AppFont.regular, size: 28, relativeTo: .title)
    static let appTitle2 = Font.custom(AppFont.regular, size: 22, relativeTo: .title2)
    static let appTitle3 = Font.custom(AppFont.regular, size: 20, relativeTo: .title3)
    /// `.headline` is semibold in the system stack; Lato's nearest face is Bold, so this twin
    /// carries the weight itself — otherwise every headline would have quietly gone regular.
    static let appHeadline = Font.custom(AppFont.bold, size: 17, relativeTo: .headline)
    static let appSubheadline = Font.custom(AppFont.regular, size: 15, relativeTo: .subheadline)
    static let appBody = Font.custom(AppFont.regular, size: 17, relativeTo: .body)
    static let appCallout = Font.custom(AppFont.regular, size: 16, relativeTo: .callout)
    static let appFootnote = Font.custom(AppFont.regular, size: 13, relativeTo: .footnote)
    static let appCaption = Font.custom(AppFont.regular, size: 12, relativeTo: .caption)
    static let appCaption2 = Font.custom(AppFont.regular, size: 11, relativeTo: .caption2)
}

/// Bars and tab items are drawn by UIKit, which never sees SwiftUI's `.font` — without these
/// proxies the nav title and tab labels would stay on SF while the content switched to Lato,
/// which is more jarring than not switching at all.  Called once at launch; a Dynamic Type
/// change re-applies the proxies and restyles the bars already on screen.
///
/// Only the title/label fonts are touched; colours, materials, and scroll-edge behaviour are
/// left to the system so this cannot regress the glass tab bar.
enum AppAppearance {
    private static var contentSizeObserver: NSObjectProtocol?
    private static var didInstallContentSizeObserver = false

    static func applyFonts() {
        applyChromeFonts()
        installContentSizeObserverIfNeeded()
    }

    private static func installContentSizeObserverIfNeeded() {
        guard !didInstallContentSizeObserver else { return }
        didInstallContentSizeObserver = true
        contentSizeObserver = NotificationCenter.default.addObserver(
            forName: UIContentSizeCategory.didChangeNotification,
            object: nil,
            queue: .main
        ) { _ in
            applyChromeFonts()
        }
    }

    private static func applyChromeFonts() {
        let nav = UINavigationBarAppearance()
        nav.configureWithDefaultBackground()
        nav.titleTextAttributes = [.font: AppChromeFontScaling.scaledUIFont(.navigationTitle)]
        nav.largeTitleTextAttributes = [.font: AppChromeFontScaling.scaledUIFont(.navigationLargeTitle)]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav

        let tabFont = AppChromeFontScaling.scaledUIFont(.tabBarItem)
        let segmentedFont = AppChromeFontScaling.scaledUIFont(.segmentedControl)
        for state in [UIControl.State.normal, .selected, .highlighted, .disabled] {
            UITabBarItem.appearance().setTitleTextAttributes([.font: tabFont], for: state)
            UISegmentedControl.appearance().setTitleTextAttributes([.font: segmentedFont], for: state)
        }

        refreshLiveChrome(nav: nav, tabFont: tabFont, segmentedFont: segmentedFont)
    }

    /// `UIAppearance` only styles views created after the proxy changes.  The root navigation
    /// and tab bars live for the whole session, so a Dynamic Type change must also restyle the
    /// bars already on screen or they keep the old size until relaunch.
    private static func refreshLiveChrome(
        nav: UINavigationBarAppearance,
        tabFont: UIFont,
        segmentedFont: UIFont
    ) {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows {
                restyle(view: window, nav: nav, tabFont: tabFont, segmentedFont: segmentedFont)
            }
        }
    }

    /// Copies an existing bar appearance and changes only the title fonts, so a Dynamic Type
    /// restyle cannot replace the live bar's background, material, or scroll-edge settings.
    private static func appearanceByUpdatingFonts(
        _ appearance: UINavigationBarAppearance,
        titleFont: UIFont,
        largeTitleFont: UIFont
    ) -> UINavigationBarAppearance {
        // copy() returns Any; unwrap that optional cast before subscripting attributes.
        // UINavigationBarAppearance titleTextAttributes and largeTitleTextAttributes
        // are non-optional dictionaries.
        guard let copy = appearance.copy() as? UINavigationBarAppearance else {
            return appearance
        }
        var titleAttributes: [NSAttributedString.Key: Any] = copy.titleTextAttributes
        titleAttributes[.font] = titleFont
        copy.titleTextAttributes = titleAttributes
        var largeTitleAttributes: [NSAttributedString.Key: Any] = copy.largeTitleTextAttributes
        largeTitleAttributes[.font] = largeTitleFont
        copy.largeTitleTextAttributes = largeTitleAttributes
        return copy
    }

    private static func restyle(
        view: UIView,
        nav: UINavigationBarAppearance,
        tabFont: UIFont,
        segmentedFont: UIFont
    ) {
        let states: [UIControl.State] = [.normal, .selected, .highlighted, .disabled]
        if let bar = view as? UINavigationBar {
            // Subscript the non-optional dictionaries; as? unwraps the Any font value.
            let titleFont = nav.titleTextAttributes[.font] as? UIFont
                ?? AppChromeFontScaling.scaledUIFont(.navigationTitle)
            let largeTitleFont = nav.largeTitleTextAttributes[.font] as? UIFont
                ?? AppChromeFontScaling.scaledUIFont(.navigationLargeTitle)
            bar.standardAppearance = appearanceByUpdatingFonts(
                bar.standardAppearance,
                titleFont: titleFont,
                largeTitleFont: largeTitleFont
            )
            if let compactAppearance = bar.compactAppearance {
                bar.compactAppearance = appearanceByUpdatingFonts(
                    compactAppearance,
                    titleFont: titleFont,
                    largeTitleFont: largeTitleFont
                )
            }
            if let scrollEdgeAppearance = bar.scrollEdgeAppearance {
                bar.scrollEdgeAppearance = appearanceByUpdatingFonts(
                    scrollEdgeAppearance,
                    titleFont: titleFont,
                    largeTitleFont: largeTitleFont
                )
            }
            if let compactScrollEdgeAppearance = bar.compactScrollEdgeAppearance {
                bar.compactScrollEdgeAppearance = appearanceByUpdatingFonts(
                    compactScrollEdgeAppearance,
                    titleFont: titleFont,
                    largeTitleFont: largeTitleFont
                )
            }
            bar.setNeedsLayout()
        } else if let bar = view as? UITabBar {
            for item in bar.items ?? [] {
                for state in states {
                    item.setTitleTextAttributes([.font: tabFont], for: state)
                }
            }
            bar.setNeedsLayout()
        } else if let control = view as? UISegmentedControl {
            for state in states {
                control.setTitleTextAttributes([.font: segmentedFont], for: state)
            }
        }
        for subview in view.subviews {
            restyle(view: subview, nav: nav, tabFont: tabFont, segmentedFont: segmentedFont)
        }
    }
}

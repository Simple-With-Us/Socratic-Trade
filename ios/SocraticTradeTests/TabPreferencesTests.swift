import XCTest
@testable import SocraticTrade

/// Contract for the width-aware tab bar (`MobileControlView.swift`):
///   - Home is chrome, not a preference — always pinned, always first, never toggleable.
///   - How many slots exist comes from the window, so an iPad or a wide Mac window shows more
///     than the four an iPhone shows.
///   - A window too narrow for the owner's chosen set renders the DEFAULTS instead, without
///     touching what they stored.
///   - The slot before More is borrowed: opening a screen that is not on the bar puts it there.
@MainActor
final class TabPreferencesTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suiteName = "TabPreferencesTests"

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    // MARK: - Stored membership

    func testDefaultsWhenNothingStored() {
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned, TabPreferences.defaultTabs)
        XCTAssertEqual(prefs.barTabs, [.home, .proposals, .markets, .activity])
        XCTAssertEqual(prefs.visibleTabs, [.home, .proposals, .markets, .activity])
        XCTAssertNil(prefs.dynamicTab)
    }

    func testUnpinPersistsAndSurvivesReload() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.toggle(.activity)
        XCTAssertFalse(prefs.isPinned(.activity))

        let reloaded = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(reloaded.barTabs, [.home, .proposals, .markets])
    }

    func testBarRendersCanonicalOrderNotPinOrder() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.toggle(.proposals) // unpin proposals (4 -> 3)
        prefs.toggle(.insights)  // pin insights   (3 -> 4)
        prefs.toggle(.activity)  // unpin activity (4 -> 3)
        prefs.toggle(.proposals) // re-pin         (3 -> 4) — appends LAST in `pinned`
        XCTAssertEqual(prefs.pinned.last, .proposals)
        // …but the bar must render declaration order, regardless of pin sequence.
        XCTAssertEqual(prefs.barTabs, [.home, .proposals, .markets, .insights])
    }

    func testStaleAndInvalidStoredValuesRecoverSafely() {
        // A removed screen name and `more` (never pinnable) must both be dropped;
        // dropping below the minimum resets to defaults rather than a broken bar.
        defaults.set(["home", "renamed_screen_that_no_longer_exists", "more"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned, TabPreferences.defaultTabs)
    }

    func testDuplicateStoredValuesCollapse() {
        defaults.set(["home", "home", "proposals", "proposals", "markets"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned, [.home, .proposals, .markets])
    }

    func testStoredSelectionAboveMaxIsClamped() {
        defaults.set(
            ["home", "proposals", "markets", "activity", "insights", "coach", "scan", "guardrails", "results"],
            forKey: "mobileTabs.v1"
        )
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned.count, TabPreferences.maxTabs)
    }

    // MARK: - Home is required

    func testHomeIsNeverToggleable() {
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertFalse(prefs.canToggle(.home))
        prefs.toggle(.home) // must be a no-op, even with slots to spare
        XCTAssertTrue(prefs.isPinned(.home))
        XCTAssertEqual(prefs.pinned, TabPreferences.defaultTabs)
        XCTAssertFalse(prefs.hasCustomSelection, "a refused toggle is not a choice")
    }

    func testStoredSelectionWithoutHomeGetsHomeBackFirst() {
        defaults.set(["proposals", "markets"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned.first, .home)
        XCTAssertEqual(prefs.barTabs, [.home, .proposals, .markets])
    }

    func testMinimumBoundBlocksUnpin() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.toggle(.activity)
        prefs.toggle(.markets)
        XCTAssertEqual(prefs.pinned.count, TabPreferences.minTabs)
        XCTAssertFalse(prefs.canToggle(.proposals))
        prefs.toggle(.proposals) // must be a no-op at the floor
        XCTAssertTrue(prefs.isPinned(.proposals))
        XCTAssertEqual(prefs.pinned.count, TabPreferences.minTabs)
    }

    func testMoreIsNeverCustomizable() {
        XCTAssertFalse(AppTab.customizable.contains(.more))
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.toggle(.activity) // free a slot so a pin would otherwise succeed
        prefs.toggle(.more)
        XCTAssertFalse(prefs.isPinned(.more))
    }

    // MARK: - Capacity comes from the window

    func testCompactWidthAlwaysKeepsTheFourTabPhoneBar() {
        XCTAssertEqual(TabBarCapacity.fits(width: 390, isRegularWidth: false), 4)
        // An iPad in Slide Over is wide in points and still compact — it keeps the phone bar.
        XCTAssertEqual(TabBarCapacity.fits(width: 1180, isRegularWidth: false), 4)
    }

    func testIPadAir11GetsMoreThanFourTabs() {
        // iPad Air 11": 820pt portrait, 1180pt landscape.
        XCTAssertEqual(TabBarCapacity.fits(width: 820, isRegularWidth: true), 6)
        XCTAssertEqual(TabBarCapacity.fits(width: 1180, isRegularWidth: true), TabBarCapacity.maximum)
    }

    func testNarrowMacWindowShrinksTheBar() {
        XCTAssertEqual(TabBarCapacity.fits(width: 900, isRegularWidth: true), 7)
        XCTAssertEqual(TabBarCapacity.fits(width: 700, isRegularWidth: true), 5)
        XCTAssertEqual(TabBarCapacity.fits(width: 500, isRegularWidth: true), 3)
        // However far the window is dragged in, Home plus one slot survives.
        XCTAssertEqual(TabBarCapacity.fits(width: 200, isRegularWidth: true), TabBarCapacity.minimum)
    }

    func testUnmeasuredWidthFallsBackToThePhoneBar() {
        XCTAssertEqual(TabBarCapacity.fits(width: 0, isRegularWidth: true), TabBarCapacity.compact)
        XCTAssertEqual(TabBarCapacity.fits(width: .infinity, isRegularWidth: true), TabBarCapacity.compact)
    }

    func testPinCeilingFollowsTheWindow() {
        // A stored choice, so auto-fill is off and the ceiling is the only thing under test.
        defaults.set(["home", "proposals", "markets", "activity"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertTrue(prefs.hasCustomSelection)
        XCTAssertEqual(prefs.pinLimit, 4)
        XCTAssertFalse(prefs.canToggle(.insights)) // four pinned, four slots

        prefs.setCapacity(6)
        XCTAssertEqual(prefs.pinLimit, 6)
        XCTAssertTrue(prefs.canToggle(.insights))
        prefs.toggle(.insights)
        prefs.toggle(.coach)
        XCTAssertEqual(prefs.visibleTabs, [.home, .proposals, .markets, .activity, .insights, .coach])
        XCTAssertFalse(prefs.canToggle(.scan)) // six pinned, six slots
    }

    // MARK: - Auto-fill before the owner has a preference

    func testFreshInstallFillsTheBarToWhateverTheWindowFits() {
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertFalse(prefs.hasCustomSelection)
        XCTAssertEqual(prefs.visibleTabs, TabPreferences.defaultTabs)

        prefs.setCapacity(6) // iPad Air 11" portrait
        XCTAssertEqual(prefs.visibleTabs, [.home, .proposals, .markets, .activity, .insights, .coach])

        prefs.setCapacity(TabBarCapacity.maximum) // landscape, or a wide Mac window
        XCTAssertEqual(prefs.visibleTabs.count, TabBarCapacity.maximum)
        XCTAssertEqual(prefs.visibleTabs.first, .home)

        prefs.setCapacity(4) // back to a phone-width window
        XCTAssertEqual(prefs.visibleTabs, TabPreferences.defaultTabs)
    }

    func testAutoFillPutsTheDefaultsFirst() {
        XCTAssertEqual(TabPreferences.autoFill(capacity: 4), TabPreferences.defaultTabs)
        XCTAssertEqual(
            TabPreferences.autoFill(capacity: 5),
            TabPreferences.defaultTabs + [.insights]
        )
        XCTAssertEqual(TabPreferences.autoFill(capacity: 1).count, TabPreferences.minTabs)
        XCTAssertEqual(TabPreferences.autoFill(capacity: 99).count, TabPreferences.maxTabs)
    }

    func testAutoFillPutsAdminInTheFirstExtraSlotForOperators() {
        XCTAssertEqual(
            TabPreferences.autoFill(capacity: 6, isAdmin: true),
            [.home, .proposals, .markets, .activity, .admin, .insights]
        )
        XCTAssertEqual(
            TabPreferences.autoFill(capacity: 4, isAdmin: true),
            TabPreferences.defaultTabs
        )
        XCTAssertFalse(TabPreferences.autoFill(capacity: 8, isAdmin: false).contains(.admin))
    }

    func testAdminTabAppearsOnlyAfterTheSessionIsMarkedAdmin() {
        let prefs = TabPreferences(userDefaults: defaults, capacity: 6)
        XCTAssertFalse(prefs.visibleTabs.contains(.admin))
        prefs.setShowsAdminTab(true)
        XCTAssertEqual(prefs.visibleTabs, [.home, .proposals, .markets, .activity, .admin, .insights])
        prefs.setShowsAdminTab(false)
        XCTAssertFalse(prefs.visibleTabs.contains(.admin))
    }

    func testPromoteAdminIsANoOpWithoutAdminAccess() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.promote(.admin)
        XCTAssertNil(prefs.dynamicTab)
        XCTAssertFalse(prefs.visibleTabs.contains(.admin))
    }

    func testTheFirstPinOrUnpinStopsTheAutoFill() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.setCapacity(6)
        prefs.toggle(.coach) // the owner takes the bar over by dropping one
        XCTAssertTrue(prefs.hasCustomSelection)
        XCTAssertEqual(prefs.pinned.count, 5)

        prefs.setCapacity(TabBarCapacity.maximum)
        XCTAssertEqual(prefs.pinned.count, 5, "a wider window must not re-fill a bar the owner has edited")

        XCTAssertTrue(TabPreferences(userDefaults: defaults).hasCustomSelection)
    }

    func testResizingAloneNeverCountsAsCustomizing() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.setCapacity(6)
        prefs.setCapacity(3)
        XCTAssertFalse(prefs.hasCustomSelection)
        XCTAssertNil(defaults.stringArray(forKey: "mobileTabs.v1"))
    }

    func testCapacityIsClampedToTheBarBounds() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.setCapacity(99)
        XCTAssertEqual(prefs.capacity, TabBarCapacity.maximum)
        prefs.setCapacity(0)
        XCTAssertEqual(prefs.capacity, TabBarCapacity.minimum)
    }

    // MARK: - Narrow fallback

    func testTooNarrowForTheChosenSetRendersTheDefaults() {
        let chosen: [AppTab] = [.home, .markets, .insights, .coach, .scan, .guardrails]
        XCTAssertEqual(
            TabPreferences.resolve(barTabs: chosen, dynamicTab: nil, capacity: 4),
            TabPreferences.defaultTabs
        )
        // Narrower still: the defaults, trimmed — Home is first, so it is never the one cut.
        XCTAssertEqual(
            TabPreferences.resolve(barTabs: chosen, dynamicTab: nil, capacity: 3),
            [.home, .proposals, .markets]
        )
        XCTAssertEqual(
            TabPreferences.resolve(barTabs: chosen, dynamicTab: nil, capacity: 1),
            [.home, .proposals]
        )
    }

    func testFallbackDoesNotTouchTheStoredChoice() {
        defaults.set(
            ["home", "proposals", "markets", "activity", "insights", "coach"],
            forKey: "mobileTabs.v1"
        )
        let prefs = TabPreferences(userDefaults: defaults, capacity: 6)
        let chosen = prefs.pinned
        XCTAssertEqual(chosen.count, 6)

        prefs.setCapacity(4) // window dragged narrower
        XCTAssertEqual(prefs.visibleTabs, TabPreferences.defaultTabs)
        XCTAssertEqual(prefs.pinned, chosen)

        prefs.setCapacity(6) // …and back out again
        XCTAssertEqual(prefs.visibleTabs, [.home, .proposals, .markets, .activity, .insights, .coach])
        XCTAssertEqual(TabPreferences(userDefaults: defaults).pinned, chosen)
    }

    // MARK: - The borrowed slot before More

    func testOpeningAnUnpinnedScreenTakesTheSlotBeforeMore() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.promote(.coach)
        // Activity — the tab right before More — is the one displaced.  Home is not.
        XCTAssertEqual(prefs.visibleTabs, [.home, .proposals, .markets, .coach])
        XCTAssertEqual(prefs.dynamicTab, .coach)
    }

    func testTheBorrowedOccupantIsAlwaysLast() {
        // Even when the borrowed screen sorts EARLIER than a pinned one, it renders in the
        // slot immediately before More.
        XCTAssertEqual(
            TabPreferences.resolve(barTabs: [.home, .markets, .insights], dynamicTab: .proposals, capacity: 3),
            [.home, .markets, .proposals]
        )
    }

    func testTheBorrowedSlotNeverDisplacesHome() {
        let bar = TabPreferences.resolve(barTabs: [.home, .proposals], dynamicTab: .scan, capacity: 2)
        XCTAssertEqual(bar, [.home, .scan])
        XCTAssertEqual(bar.first, .home)
    }

    func testPromotingAVisibleTabChangesNothing() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.promote(.activity)
        XCTAssertNil(prefs.dynamicTab)
        XCTAssertEqual(prefs.visibleTabs, TabPreferences.defaultTabs)

        prefs.promote(.coach)
        prefs.promote(.coach) // already borrowed — still just the one
        XCTAssertEqual(prefs.dynamicTab, .coach)
    }

    func testPinningTheBorrowedScreenGivesTheSlotBack() {
        defaults.set(["home", "proposals", "markets", "activity"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults, capacity: 6)
        prefs.promote(.coach)
        XCTAssertEqual(prefs.dynamicTab, .coach)

        prefs.toggle(.coach) // pin it for good
        XCTAssertNil(prefs.dynamicTab)
        XCTAssertEqual(prefs.visibleTabs, [.home, .proposals, .markets, .activity, .coach])
    }

    func testTheBorrowedSlotSurvivesRelaunch() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.promote(.scan)

        let reloaded = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(reloaded.dynamicTab, .scan)
        XCTAssertEqual(reloaded.visibleTabs, [.home, .proposals, .markets, .scan])

        reloaded.clearDynamicTab()
        XCTAssertNil(TabPreferences(userDefaults: defaults).dynamicTab)
    }

    func testTheBorrowedSlotSurvivesTheNarrowFallback() {
        XCTAssertEqual(
            TabPreferences.resolve(
                barTabs: [.home, .markets, .insights, .coach, .scan, .guardrails],
                dynamicTab: .results,
                capacity: 4
            ),
            [.home, .proposals, .markets, .results]
        )
    }

    func testAPinnedScreenIsNeverBorrowedTwice() {
        XCTAssertEqual(
            TabPreferences.resolve(barTabs: TabPreferences.defaultTabs, dynamicTab: .activity, capacity: 4),
            TabPreferences.defaultTabs
        )
    }
}

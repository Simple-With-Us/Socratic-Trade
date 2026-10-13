import Foundation

/// Client-side US equity session classifier (mirrors `src/lib/market-hours.ts` `currentMarketSession`).
/// Used when the mobile snapshot is stale so the UI does not trust a cached `marketSession`.
enum NYSEMarketSession {
    typealias SessionKey = String

    static func sessionKey(now: Date = Date()) -> SessionKey? {
        let parts = etParts(now)
        if parts.weekday == .saturday || parts.weekday == .sunday { return "closed" }

        let dateKey = etDateKey(parts)
        if marketHolidays(year: parts.year).contains(dateKey) { return "closed" }

        let totalMinutes = parts.hour * 60 + parts.minute
        let preOpen = 4 * 60
        let open = 9 * 60 + 30
        let close = marketCloseMinutes(parts)
        let postClose = 20 * 60

        if totalMinutes >= open && totalMinutes < close { return "regular" }
        if totalMinutes >= preOpen && totalMinutes < open { return "pre" }
        if totalMinutes >= close && totalMinutes < postClose { return "post" }
        return "closed"
    }

    // MARK: - ET wall clock

    private struct EtParts {
        let year: Int
        let month: Int
        let day: Int
        let hour: Int
        let minute: Int
        let weekday: Weekday
    }

    private enum Weekday: Int {
        case sunday = 1
        case monday
        case tuesday
        case wednesday
        case thursday
        case friday
        case saturday
    }

    private static func etParts(_ date: Date) -> EtParts {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(identifier: "America/New_York")
        fmt.dateFormat = "yyyy-MM-dd HH:mm EEE"
        let formatted = fmt.string(from: date)
        let bits = formatted.split(separator: " ")
        let ymd = bits[0].split(separator: "-")
        let hm = bits[1].split(separator: ":")
        let weekdayToken = String(bits[2])
        let weekday: Weekday
        switch weekdayToken {
        case "Sun": weekday = .sunday
        case "Mon": weekday = .monday
        case "Tue": weekday = .tuesday
        case "Wed": weekday = .wednesday
        case "Thu": weekday = .thursday
        case "Fri": weekday = .friday
        default: weekday = .saturday
        }
        return EtParts(
            year: Int(ymd[0]) ?? 0,
            month: Int(ymd[1]) ?? 0,
            day: Int(ymd[2]) ?? 0,
            hour: Int(hm[0]) ?? 0,
            minute: Int(hm[1]) ?? 0,
            weekday: weekday
        )
    }

    private static func etDateKey(_ parts: EtParts) -> String {
        String(format: "%04d-%02d-%02d", parts.year, parts.month, parts.day)
    }

    private static func marketCloseMinutes(_ parts: EtParts) -> Int {
        if let early = earlyCloses(year: parts.year)[etDateKey(parts)] {
            return early.hour * 60 + early.minute
        }
        return 16 * 60
    }

    // MARK: - Calendar (NYSE holidays + early closes)

    private struct Clock {
        let hour: Int
        let minute: Int
    }

    private static func marketHolidays(year: Int) -> Set<String> {
        var holidays = Set<String>()
        holidays.insert(etDateKey(utcYMD: observedHoliday(year: year, month: 1, day: 1)))
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        if cal.component(.weekday, from: cal.date(from: DateComponents(year: year + 1, month: 1, day: 1))!) == 7 {
            holidays.insert(String(format: "%04d-12-31", year))
        }
        holidays.insert(etDateKey(utcYMD: nthWeekdayOfMonth(year: year, month: 1, weekday: 2, n: 3)))
        holidays.insert(etDateKey(utcYMD: nthWeekdayOfMonth(year: year, month: 2, weekday: 2, n: 3)))
        holidays.insert(etDateKey(utcYMD: goodFriday(year: year)))
        holidays.insert(etDateKey(utcYMD: lastWeekdayOfMonth(year: year, month: 5, weekday: 2)))
        holidays.insert(etDateKey(utcYMD: observedHoliday(year: year, month: 6, day: 19)))
        holidays.insert(etDateKey(utcYMD: observedHoliday(year: year, month: 7, day: 4)))
        holidays.insert(etDateKey(utcYMD: nthWeekdayOfMonth(year: year, month: 9, weekday: 2, n: 1)))
        holidays.insert(etDateKey(utcYMD: nthWeekdayOfMonth(year: year, month: 11, weekday: 5, n: 4)))
        holidays.insert(etDateKey(utcYMD: observedHoliday(year: year, month: 12, day: 25)))
        return holidays
    }

    private static func earlyCloses(year: Int) -> [String: Clock] {
        var closes: [String: Clock] = [:]
        let half = Clock(hour: 13, minute: 0)
        let holidays = marketHolidays(year: year)
        let thanksgiving = nthWeekdayOfMonth(year: year, month: 11, weekday: 5, n: 4)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let dayAfter = cal.date(byAdding: .day, value: 1, to: thanksgiving)!
        let dayAfterKey = etDateKey(utcYMD: dayAfter)
        if !holidays.contains(dayAfterKey) { closes[dayAfterKey] = half }
        let christmasEveKey = String(format: "%04d-12-24", year)
        let july3Key = String(format: "%04d-07-03", year)
        if !holidays.contains(christmasEveKey) {
            let dow = cal.component(.weekday, from: cal.date(from: DateComponents(year: year, month: 12, day: 24))!)
            if (2...6).contains(dow) { closes[christmasEveKey] = half }
        }
        if !holidays.contains(july3Key) {
            let dow = cal.component(.weekday, from: cal.date(from: DateComponents(year: year, month: 7, day: 3))!)
            if (2...6).contains(dow) { closes[july3Key] = half }
        }
        return closes
    }

    private static func etDateKey(utcYMD date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let y = cal.component(.year, from: date)
        let m = cal.component(.month, from: date)
        let d = cal.component(.day, from: date)
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    private static func observedHoliday(year: Int, month: Int, day: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        var date = cal.date(from: DateComponents(year: year, month: month, day: day))!
        let dow = cal.component(.weekday, from: date)
        if dow == 1 { date = cal.date(byAdding: .day, value: 1, to: date)! }
        if dow == 7 { date = cal.date(byAdding: .day, value: -1, to: date)! }
        return date
    }

    private static func nthWeekdayOfMonth(year: Int, month: Int, weekday: Int, n: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        var date = cal.date(from: DateComponents(year: year, month: month, day: 1))!
        var count = 0
        while cal.component(.month, from: date) == month {
            if cal.component(.weekday, from: date) == weekday {
                count += 1
                if count == n { return date }
            }
            date = cal.date(byAdding: .day, value: 1, to: date)!
        }
        fatalError("nth weekday not found")
    }

    private static func lastWeekdayOfMonth(year: Int, month: Int, weekday: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        var date = cal.date(from: DateComponents(year: year, month: month + 1, day: 0))!
        while cal.component(.month, from: date) == month {
            if cal.component(.weekday, from: date) == weekday { return date }
            date = cal.date(byAdding: .day, value: -1, to: date)!
        }
        fatalError("last weekday not found")
    }

    private static func goodFriday(year: Int) -> Date {
        let a = year % 19
        let b = year / 100
        let c = year % 100
        let d = b / 4
        let e = b % 4
        let f = (b + 8) / 25
        let g = (b - f + 1) / 3
        let h = (19 * a + b - d - g + 15) % 30
        let i = c / 4
        let k = c % 4
        let l = (32 + 2 * e + 2 * i - h - k) % 7
        let m = (a + 11 * h + 22 * l) / 451
        let month = (h + l - 7 * m + 114) / 31
        let day = ((h + l - 7 * m + 114) % 31) + 1
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        var easter = cal.date(from: DateComponents(year: year, month: month, day: day))!
        easter = cal.date(byAdding: .day, value: -2, to: easter)!
        return easter
    }
}

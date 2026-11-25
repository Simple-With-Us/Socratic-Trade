import Foundation

/// Day grouping for the Audit Log's unified feed.  Pure: the calendar is injected so
/// tests can pin a time zone instead of depending on the device's, and the timestamp
/// parse reuses `AppFormat.date` (the same ISO-8601 rules every row stamp uses).
enum AuditDayGrouping {
    struct DayGroup: Identifiable, Equatable {
        /// `nil` marks the trailing group of items with no parseable timestamp.
        let day: Date?
        let items: [ActivityAuditItem]

        var id: String { day.map { String($0.timeIntervalSince1970) } ?? "undated" }
    }

    /// Groups by `calendar.startOfDay`, preserving the feed's order: days appear in the
    /// order their first item appears, and items keep their relative order inside a day.
    /// Items with no parseable timestamp collect into one trailing undated group rather
    /// than being dropped or scattered.
    static func groups(_ items: [ActivityAuditItem], calendar: Calendar = .current) -> [DayGroup] {
        var dayOrder: [Date] = []
        var byDay: [Date: [ActivityAuditItem]] = [:]
        var undated: [ActivityAuditItem] = []
        for item in items {
            guard let date = AppFormat.date(item.updatedAt) else {
                undated.append(item)
                continue
            }
            let day = calendar.startOfDay(for: date)
            if byDay[day] == nil { dayOrder.append(day) }
            byDay[day, default: []].append(item)
        }
        var result = dayOrder.map { DayGroup(day: $0, items: byDay[$0] ?? []) }
        if !undated.isEmpty {
            result.append(DayGroup(day: nil, items: undated))
        }
        return result
    }
}
import EventKit
import Foundation
import AppKit

struct BridgeError: LocalizedError {
    let message: String

    var errorDescription: String? { message }
}

let store = EKEventStore()
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let resultPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let inputPath = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
let syncConflictTolerance: TimeInterval = 2
let eventImportFutureDays = 90

func emit(_ value: Any) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"error\":\"無法輸出行事曆資料。\"}")
        return
    }
    if !resultPath.isEmpty {
        try? text.write(toFile: resultPath, atomically: true, encoding: .utf8)
    }
    print(text)
    fflush(stdout)
}

func authorizationName(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: return "unknown"
    }
}

func sourceTypeName(_ type: EKSourceType) -> String {
    switch type {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "calDAV"
    case .mobileMe: return "iCloud"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "other"
    }
}

func calendarDictionary(_ calendar: EKCalendar) -> [String: Any] {
    [
        "id": calendar.calendarIdentifier,
        "title": calendar.title,
        "source": calendar.source.title,
        "sourceType": sourceTypeName(calendar.source.sourceType),
        "writable": calendar.allowsContentModifications
    ]
}

func statusPayload() -> [String: Any] {
    let eventStatus = EKEventStore.authorizationStatus(for: .event)
    let reminderStatus = EKEventStore.authorizationStatus(for: .reminder)
    let eventAllowed: Bool
    let reminderAllowed: Bool
    if #available(macOS 14.0, *) {
        eventAllowed = eventStatus == .fullAccess || eventStatus == .writeOnly
        reminderAllowed = reminderStatus == .fullAccess
    } else {
        eventAllowed = eventStatus == .authorized
        reminderAllowed = reminderStatus == .authorized
    }

    return [
        "ok": true,
        "authorization": [
            "events": authorizationName(eventStatus),
            "reminders": authorizationName(reminderStatus)
        ],
        "bundle": [
            "id": Bundle.main.bundleIdentifier ?? "",
            "path": Bundle.main.bundlePath
        ],
        "calendars": eventAllowed
            ? store.calendars(for: .event).filter(\.allowsContentModifications).map(calendarDictionary)
            : [],
        "reminderLists": reminderAllowed
            ? store.calendars(for: .reminder).filter(\.allowsContentModifications).map(calendarDictionary)
            : []
    ]
}

func requestAccess() {
    var eventGranted = false
    var reminderGranted = false
    var accessErrors: [String] = []

    let finish = {
        var payload = statusPayload()
        payload["granted"] = ["events": eventGranted, "reminders": reminderGranted]
        payload["accessErrors"] = accessErrors
        emit(payload)
        exit(EXIT_SUCCESS)
    }

    let requestReminders = {
        if #available(macOS 14.0, *) {
            store.requestFullAccessToReminders { granted, error in
                reminderGranted = granted
                if let error { accessErrors.append("reminders: \(error.localizedDescription)") }
                DispatchQueue.main.async(execute: finish)
            }
        } else {
            store.requestAccess(to: .reminder) { granted, error in
                reminderGranted = granted
                if let error { accessErrors.append("reminders: \(error.localizedDescription)") }
                DispatchQueue.main.async(execute: finish)
            }
        }
    }

    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()

    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 390, height: 150),
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
    )
    window.title = "貼身小秘書同步"
    let label = NSTextField(labelWithString: "正在連接行事曆與提醒事項…\n請在接下來的系統視窗中按「允許」。")
    label.alignment = .center
    label.font = NSFont.systemFont(ofSize: 15, weight: .medium)
    label.textColor = .labelColor
    label.frame = NSRect(x: 25, y: 43, width: 340, height: 58)
    label.maximumNumberOfLines = 2
    window.contentView?.addSubview(label)
    window.center()
    window.makeKeyAndOrderFront(nil)
    application.activate()

    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { granted, error in
                eventGranted = granted
                if let error { accessErrors.append("events: \(error.localizedDescription)") }
                DispatchQueue.main.async(execute: requestReminders)
            }
        } else {
            store.requestAccess(to: .event) { granted, error in
                eventGranted = granted
                if let error { accessErrors.append("events: \(error.localizedDescription)") }
                DispatchQueue.main.async(execute: requestReminders)
            }
        }
    }

    RunLoop.main.run()
}

func readInput() throws -> [String: Any] {
    let data: Data
    if !inputPath.isEmpty {
        data = try Data(contentsOf: URL(fileURLWithPath: inputPath))
    } else {
        data = FileHandle.standardInput.readDataToEndOfFile()
    }
    guard !data.isEmpty,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw BridgeError(message: "同步資料格式不正確。")
    }
    return object
}

let dateFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter
}()

let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

let isoFormatterWithoutFractionalSeconds: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

func dateFromISO(_ value: String) -> Date? {
    isoFormatter.date(from: value) ?? isoFormatterWithoutFractionalSeconds.date(from: value)
}

func isoString(_ date: Date?) -> String {
    guard let date else { return "" }
    return isoFormatter.string(from: date)
}

func dateFrom(date: String, time: String?) -> Date? {
    guard let day = dateFormatter.date(from: date) else { return nil }
    guard let time, !time.isEmpty else { return day }
    let parts = time.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2 else { return day }
    return Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: day)
}

func dateParts(_ date: Date) -> (String, String) {
    let day = dateFormatter.string(from: date)
    let components = Calendar.current.dateComponents([.hour, .minute], from: date)
    let time = String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    return (day, time)
}

func responseStatusName(_ status: EKParticipantStatus) -> String {
    switch status {
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .pending, .unknown: return "needsAction"
    case .delegated, .completed, .inProcess: return "accepted"
    @unknown default: return "needsAction"
    }
}

func eventResponseStatus(_ event: EKEvent) -> String {
    if let attendee = event.attendees?.first(where: { $0.isCurrentUser }) {
        return responseStatusName(attendee.participantStatus)
    }
    if event.organizer?.isCurrentUser == true {
        return "accepted"
    }
    if event.status == .tentative {
        return "tentative"
    }
    if event.attendees?.isEmpty == false {
        return "needsAction"
    }
    return ""
}

func eventLink(localId: String, event: EKEvent, stableIdentifier: String? = nil) -> [String: Any] {
    let responseStatus = eventResponseStatus(event)
    return [
        "localId": localId,
        "external": [
            "provider": "eventkit",
            "type": "event",
            "id": stableIdentifier ?? event.eventIdentifier ?? event.calendarItemIdentifier,
            "calendarId": event.calendar.calendarIdentifier,
            "calendarTitle": event.calendar.title,
            "source": event.calendar.source.title,
            "modifiedAt": isoString(event.lastModifiedDate),
            "responseStatus": responseStatus
        ]
    ]
}

func taskExternal(_ task: [String: Any]) -> [String: Any]? {
    task["external"] as? [String: Any]
}

func selectedCalendar(_ id: String?, type: EKEntityType) -> EKCalendar? {
    guard let id, !id.isEmpty else { return nil }
    return store.calendars(for: type).first { $0.calendarIdentifier == id }
}

enum EventMatchResult {
    case found(EKEvent)
    case notFound
    case ambiguous(Int)
    case unsafe(String)
}

struct EventMatchDetails {
    let calendar: EKCalendar
    let date: String
    let day: Date
    let title: String
    let time: String
    let isAllDay: Bool
}

func eventWithIdentifier(_ identifier: String) -> EKEvent? {
    store.event(withIdentifier: identifier)
        ?? (store.calendarItem(withIdentifier: identifier) as? EKEvent)
}

func eventMatchDetails(for item: [String: Any]) -> EventMatchDetails? {
    let external = taskExternal(item)
    guard
        let calendarId = (item["calendarId"] as? String) ?? (external?["calendarId"] as? String),
        let calendar = selectedCalendar(calendarId, type: .event),
        let date = item["date"] as? String,
        let day = dateFormatter.date(from: date),
        let rawTitle = item["title"] as? String,
        let time = item["reminderTime"] as? String
    else { return nil }

    let isAllDay = (item["isAllDay"] as? Bool) ?? time.isEmpty
    guard isAllDay == time.isEmpty else { return nil }
    return EventMatchDetails(
        calendar: calendar,
        date: date,
        day: day,
        title: rawTitle.trimmingCharacters(in: .whitespacesAndNewlines),
        time: time,
        isAllDay: isAllDay
    )
}

func eventMatches(_ event: EKEvent, details: EventMatchDetails) -> Bool {
    let parts = dateParts(event.startDate)
    return event.calendar.calendarIdentifier == details.calendar.calendarIdentifier
        && event.title?.trimmingCharacters(in: .whitespacesAndNewlines) == details.title
        && parts.0 == details.date
        && event.isAllDay == details.isAllDay
        && (details.isAllDay || parts.1 == details.time)
}

func fallbackEventMatch(details: EventMatchDetails) -> EventMatchResult {
    let start = Calendar.current.startOfDay(for: details.day)
    let end = Calendar.current.date(byAdding: .day, value: 1, to: start) ?? start
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: [details.calendar])
    let matches = store.events(matching: predicate).filter { eventMatches($0, details: details) }

    if matches.count == 1 { return .found(matches[0]) }
    if matches.count > 1 { return .ambiguous(matches.count) }
    return .notFound
}

func matchingEvent(for item: [String: Any], identifier: String) -> EventMatchResult {
    if let direct = eventWithIdentifier(identifier) { return .found(direct) }
    guard let details = eventMatchDetails(for: item) else { return .notFound }
    return fallbackEventMatch(details: details)
}

func matchingEventForDeletion(_ item: [String: Any], identifier: String) -> EventMatchResult {
    let direct = eventWithIdentifier(identifier)
    guard let details = eventMatchDetails(for: item) else {
        return .unsafe("刪除資料缺少完整的日曆、標題、日期或時間")
    }

    if let direct, eventMatches(direct, details: details) {
        return .found(direct)
    }

    let fallback = fallbackEventMatch(details: details)
    if case .notFound = fallback, direct != nil {
        return .unsafe("識別碼對應的行程與待刪除日期、時間或全天狀態不一致")
    }
    return fallback
}

func removePendingItems(_ deletes: [[String: Any]], warnings: inout [String]) -> [[String: Any]] {
    var removed: [[String: Any]] = []
    for item in deletes {
        guard let id = item["id"] as? String,
              let type = item["type"] as? String else { continue }
        let title = (item["title"] as? String) ?? "行程"
        do {
            if type == "event" {
                let match = matchingEventForDeletion(item, identifier: id)
                switch match {
                case .found(let event):
                    try store.remove(event, span: .thisEvent, commit: true)
                case .notFound:
                    if item["date"] != nil { removed.append(item) }
                    continue
                case .ambiguous(let count):
                    warnings.append("「\(title)」找到 \(count) 筆完全相同的行程，為避免刪錯，這次沒有刪除。")
                    continue
                case .unsafe(let reason):
                    warnings.append("「\(title)」未刪除：\(reason)。")
                    continue
                }
            } else if type == "reminder" {
                guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
                    removed.append(item)
                    continue
                }
                try store.remove(reminder, commit: true)
            } else {
                continue
            }
            removed.append(item)
        } catch {
            warnings.append("「\(title)」刪除失敗：\(error.localizedDescription)")
            fputs("CalendarBridge delete warning: \(error.localizedDescription)\n", stderr)
        }
    }
    return removed
}

func applyPendingEventActions(_ actions: [[String: Any]], warnings: inout [String]) -> ([[String: Any]], [[String: Any]]) {
    var removed: [[String: Any]] = []
    var links: [[String: Any]] = []

    for action in actions {
        guard let actionType = action["action"] as? String else { continue }
        let external = action["external"] as? [String: Any]
        guard let externalId = (action["externalId"] as? String) ?? (external?["id"] as? String) else {
            removed.append(action)
            continue
        }
        let title = (action["title"] as? String) ?? "行程"

        if actionType == "respond" {
            let status = (action["responseStatus"] as? String) ?? "needsAction"
            warnings.append("「\(title)」已在小秘書標記為 \(status)；macOS EventKit 只能讀取 RSVP，無法代送正式回覆。")
            removed.append(action)
            continue
        }

        guard actionType == "reschedule" else {
            removed.append(action)
            continue
        }

        guard let nextDate = action["nextDate"] as? String else {
            removed.append(action)
            continue
        }

        let event: EKEvent
        switch matchingEvent(for: action, identifier: externalId) {
        case .found(let matched):
            event = matched
        case .notFound:
            removed.append(action)
            continue
        case .ambiguous(let count):
            warnings.append("「\(title)」找到 \(count) 筆完全相同的行程，為避免改錯，這次沒有改期。")
            continue
        case .unsafe(let reason):
            warnings.append("「\(title)」未改期：\(reason)。")
            continue
        }

        do {
            let nextTime = action["nextReminderTime"] as? String
            guard let startDate = dateFrom(date: nextDate, time: nextTime) else {
                removed.append(action)
                continue
            }
            let originalDuration = max(event.endDate.timeIntervalSince(event.startDate), 60 * 60)
            event.startDate = startDate
            event.isAllDay = nextTime?.isEmpty != false
            if event.isAllDay {
                event.endDate = Calendar.current.date(byAdding: .day, value: 1, to: startDate) ?? startDate
            } else if let nextEndTime = action["nextEndTime"] as? String,
                      !nextEndTime.isEmpty,
                      let nextEndDate = (action["nextEndDate"] as? String) ?? (action["nextDate"] as? String),
                      let parsedEnd = dateFrom(date: nextEndDate, time: nextEndTime) {
                event.endDate = parsedEnd > startDate
                    ? parsedEnd
                    : Calendar.current.date(byAdding: .day, value: 1, to: parsedEnd) ?? parsedEnd
            } else {
                event.endDate = Date(timeInterval: originalDuration, since: startDate)
            }
            try store.save(event, span: .thisEvent, commit: true)
            removed.append(action)
            if let localId = action["localId"] as? String {
                links.append(eventLink(localId: localId, event: event))
            }
        } catch {
            warnings.append("「\(title)」改期失敗：\(error.localizedDescription)")
        }
    }

    return (removed, links)
}

func localShouldOverwriteRemote(
    task: [String: Any],
    item: EKCalendarItem?,
    warnings: inout [String]
) -> Bool {
    guard let item else { return true }
    let title = (task["title"] as? String) ?? "事項"
    guard let externalValue = taskExternal(task)?["modifiedAt"] as? String,
          !externalValue.isEmpty else {
        warnings.append("「\(title)」缺少上次同步時間，為避免覆蓋其他裝置的修改，這次未回寫。")
        return false
    }
    guard let externalSnapshot = dateFromISO(externalValue) else {
        warnings.append("「\(title)」的上次同步時間格式無法解析，為避免覆蓋其他裝置的修改，這次未回寫。")
        return false
    }
    guard let localValue = (task["updatedAt"] as? String) ?? (task["createdAt"] as? String),
          !localValue.isEmpty else {
        warnings.append("「\(title)」缺少本機修改時間，為避免覆蓋其他裝置的修改，這次未回寫。")
        return false
    }
    guard let localModified = dateFromISO(localValue) else {
        warnings.append("「\(title)」的本機修改時間格式無法解析，為避免覆蓋其他裝置的修改，這次未回寫。")
        return false
    }
    guard localModified.timeIntervalSince(externalSnapshot) > syncConflictTolerance else {
        return false
    }
    guard let remoteModified = item.lastModifiedDate else {
        warnings.append("「\(title)」缺少行事曆端修改時間，為避免覆蓋其他裝置的修改，這次未回寫。")
        return false
    }
    return localModified.timeIntervalSince(remoteModified) > syncConflictTolerance
}

func retryEventLink(localId: String, task: [String: Any]) -> [String: Any]? {
    guard var external = taskExternal(task) else { return nil }
    external["modifiedAt"] = ""
    return ["localId": localId, "external": external]
}

func upsertEvent(
    task: [String: Any],
    calendar: EKCalendar,
    warnings: inout [String]
) throws -> [String: Any]? {
    guard let localId = task["id"] as? String,
          let title = task["title"] as? String,
          let date = task["date"] as? String else { return nil }

    let external = taskExternal(task)
    let externalId = external?["id"] as? String
    let existing: EKEvent?
    if let externalId {
        switch matchingEvent(for: task, identifier: externalId) {
        case .found(let event):
            existing = event
        case .notFound:
            existing = nil
        case .ambiguous(let count):
            throw BridgeError(message: "「\(title)」找到 \(count) 筆完全相同的行程，為避免改錯，這次未同步。")
        case .unsafe(let reason):
            throw BridgeError(message: "「\(title)」未同步：\(reason)。")
        }
    } else {
        existing = nil
    }
    // App 自己建立的行程（有 origin）若被綁在跟目前選定不同的日曆上，自動搬家：
    // 先在新日曆建立成功，再刪除舊行程；建立失敗時原行程完全不動。
    let isAppOwned = (task["origin"] as? String).map { !$0.isEmpty } ?? false
    let onWrongCalendar = isAppOwned && existing != nil
        && existing!.calendar.calendarIdentifier != calendar.calendarIdentifier

    if !onWrongCalendar,
       !localShouldOverwriteRemote(task: task, item: existing, warnings: &warnings) { return nil }

    let event = onWrongCalendar ? EKEvent(eventStore: store) : (existing ?? EKEvent(eventStore: store))
    let time = task["reminderTime"] as? String
    let endTime = task["endTime"] as? String
    let endDate = (task["endDate"] as? String) ?? date
    guard let startDate = dateFrom(date: date, time: time) else { return nil }
    event.title = title
    event.notes = task["notes"] as? String
    event.calendar = calendar
    event.isAllDay = time?.isEmpty != false
    event.startDate = startDate
    if event.isAllDay {
        event.endDate = Calendar.current.date(byAdding: .day, value: 1, to: startDate) ?? startDate
    } else if let endTime, !endTime.isEmpty, let parsedEnd = dateFrom(date: endDate, time: endTime) {
        event.endDate = parsedEnd > startDate
            ? parsedEnd
            : Calendar.current.date(byAdding: .day, value: 1, to: parsedEnd) ?? parsedEnd
    } else {
        event.endDate = Calendar.current.date(byAdding: .hour, value: 1, to: startDate) ?? startDate
    }
    if onWrongCalendar, let oldEvent = existing {
        do {
            try store.save(event, span: .thisEvent, commit: true)
        } catch {
            warnings.append("「\(title)」搬移行事曆失敗，原行程已保留，稍後會重試：\(error.localizedDescription)")
            return retryEventLink(localId: localId, task: task)
        }

        do {
            try store.remove(oldEvent, span: .thisEvent, commit: true)
        } catch {
            let removalError = error
            do {
                try store.remove(event, span: .thisEvent, commit: true)
                warnings.append("「\(title)」無法從舊日曆移除；新行程已回滾、原行程仍保留，稍後會重試：\(removalError.localizedDescription)")
                return retryEventLink(localId: localId, task: task)
            } catch {
                warnings.append("「\(title)」已建立到新日曆，但舊行程與回滾都失敗，兩個日曆可能各留一筆：\(removalError.localizedDescription)；回滾：\(error.localizedDescription)")
                return eventLink(localId: localId, event: event)
            }
        }
    } else {
        try store.save(event, span: .thisEvent, commit: true)
    }
    let stableIdentifier = onWrongCalendar
        ? (event.eventIdentifier ?? event.calendarItemIdentifier)
        : (externalId ?? event.eventIdentifier ?? event.calendarItemIdentifier)
    return eventLink(localId: localId, event: event, stableIdentifier: stableIdentifier)
}

func upsertReminder(
    task: [String: Any],
    calendar: EKCalendar,
    warnings: inout [String]
) throws -> [String: Any]? {
    guard let localId = task["id"] as? String,
          let title = task["title"] as? String,
          let date = task["date"] as? String else { return nil }

    let external = taskExternal(task)
    let externalId = external?["id"] as? String
    let existing = externalId.flatMap { store.calendarItem(withIdentifier: $0) as? EKReminder }
    guard localShouldOverwriteRemote(task: task, item: existing, warnings: &warnings) else { return nil }

    let reminder = existing ?? EKReminder(eventStore: store)
    let time = task["reminderTime"] as? String
    guard let dueDate = dateFrom(date: date, time: time) else { return nil }
    reminder.title = title
    reminder.notes = task["notes"] as? String
    reminder.calendar = calendar
    reminder.isCompleted = (task["completed"] as? Bool) ?? false
    var components = Calendar.current.dateComponents([.year, .month, .day], from: dueDate)
    if let time, !time.isEmpty {
        let clock = Calendar.current.dateComponents([.hour, .minute], from: dueDate)
        components.hour = clock.hour
        components.minute = clock.minute
        components.timeZone = .current
        reminder.alarms = [EKAlarm(absoluteDate: dueDate)]
    } else {
        reminder.alarms = nil
    }
    reminder.dueDateComponents = components
    try store.save(reminder, commit: true)
    return [
        "localId": localId,
        "external": [
            "provider": "eventkit",
            "type": "reminder",
            "id": reminder.calendarItemIdentifier,
            "calendarId": calendar.calendarIdentifier,
            "calendarTitle": calendar.title,
            "source": calendar.source.title,
            "modifiedAt": isoString(reminder.lastModifiedDate)
        ]
    ]
}

func eventDictionary(_ event: EKEvent) -> [String: Any] {
    let start = dateParts(event.startDate)
    let end = dateParts(event.endDate)
    let responseStatus = eventResponseStatus(event)
    return [
        "title": event.title ?? "未命名行程",
        "date": start.0,
        "reminderTime": event.isAllDay ? "" : start.1,
        "endDate": end.0,
        "endTime": event.isAllDay ? "" : end.1,
        "isAllDay": event.isAllDay,
        "kind": "event",
        "notes": event.notes ?? "",
        "completed": false,
        "responseStatus": responseStatus,
        "updatedAt": isoString(event.lastModifiedDate),
        "external": [
            "provider": "eventkit",
            "type": "event",
            "id": event.eventIdentifier ?? event.calendarItemIdentifier,
            "calendarId": event.calendar.calendarIdentifier,
            "calendarTitle": event.calendar.title,
            "source": event.calendar.source.title,
            "modifiedAt": isoString(event.lastModifiedDate),
            "responseStatus": responseStatus
        ]
    ]
}

func reminderDictionary(_ reminder: EKReminder) -> [String: Any]? {
    guard let components = reminder.dueDateComponents,
          let dueDate = Calendar.current.date(from: components) else { return nil }
    let due = dateParts(dueDate)
    let hasTime = components.hour != nil
    return [
        "title": reminder.title ?? "未命名提醒",
        "date": due.0,
        "reminderTime": hasTime ? due.1 : "",
        "endTime": "",
        "kind": "reminder",
        "notes": reminder.notes ?? "",
        "completed": reminder.isCompleted,
        "completedAt": isoString(reminder.completionDate),
        "updatedAt": isoString(reminder.lastModifiedDate),
        "external": [
            "provider": "eventkit",
            "type": "reminder",
            "id": reminder.calendarItemIdentifier,
            "calendarId": reminder.calendar.calendarIdentifier,
            "calendarTitle": reminder.calendar.title,
            "source": reminder.calendar.source.title,
            "modifiedAt": isoString(reminder.lastModifiedDate)
        ]
    ]
}

func fetchReminders(calendar: EKCalendar) -> [EKReminder] {
    let semaphore = DispatchSemaphore(value: 0)
    var reminders: [EKReminder] = []
    let predicate = store.predicateForReminders(in: [calendar])
    store.fetchReminders(matching: predicate) { result in
        reminders = result ?? []
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 20)
    return reminders
}

func runSync() throws {
    let payload = try readInput()
    let settings = (payload["settings"] as? [String: Any]) ?? [:]
    let tasks = (payload["tasks"] as? [[String: Any]]) ?? []
    let pendingDeletes = (payload["pendingDeletes"] as? [[String: Any]]) ?? []
    let pendingEventActions = (payload["pendingEventActions"] as? [[String: Any]]) ?? []
    let syncEvents = (settings["calendarSyncEnabled"] as? Bool) ?? false
    let syncReminders = (settings["reminderSyncEnabled"] as? Bool) ?? false
    let calendar = selectedCalendar(settings["calendarId"] as? String, type: .event)
    let reminderList = selectedCalendar(settings["reminderListId"] as? String, type: .reminder)
    var links: [[String: Any]] = []
    var warnings: [String] = []

    let removedDeletes = removePendingItems(pendingDeletes, warnings: &warnings)
    let actionResult = applyPendingEventActions(pendingEventActions, warnings: &warnings)
    let removedEventActions = actionResult.0
    links.append(contentsOf: actionResult.1)

    for task in tasks {
        let kind = (task["kind"] as? String) ?? "reminder"
        do {
            if kind == "event", syncEvents, let calendar,
               let link = try upsertEvent(task: task, calendar: calendar, warnings: &warnings) {
                links.append(link)
            } else if kind != "event", syncReminders, let reminderList,
                      let link = try upsertReminder(task: task, calendar: reminderList, warnings: &warnings) {
                links.append(link)
            }
        } catch {
            warnings.append("\((task["title"] as? String) ?? "事項")：\(error.localizedDescription)")
        }
    }

    var externalItems: [[String: Any]] = []
    let now = Date()
    let start = Calendar.current.date(byAdding: .day, value: -30, to: now) ?? now
    let end = Calendar.current.date(byAdding: .day, value: eventImportFutureDays, to: now) ?? now

    if syncEvents, let calendar {
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: [calendar])
        externalItems.append(contentsOf: store.events(matching: predicate).map(eventDictionary))
    }
    if syncReminders, let reminderList {
        externalItems.append(contentsOf: fetchReminders(calendar: reminderList).compactMap(reminderDictionary))
    }

    var response = statusPayload()
    response["links"] = links
    response["externalItems"] = externalItems
    response["removedDeletes"] = removedDeletes
    response["removedEventActions"] = removedEventActions
    response["warnings"] = warnings
    response["synced"] = [
        "events": syncEvents && calendar != nil,
        "reminders": syncReminders && reminderList != nil
    ]
    response["syncWindow"] = [
        "eventsStart": dateFormatter.string(from: start),
        "eventsEnd": dateFormatter.string(from: end)
    ]
    emit(response)
}

let command = CommandLine.arguments.dropFirst().first ?? "status"

switch command {
case "status":
    emit(statusPayload())
case "request-access":
    requestAccess()
case "sync":
    do {
        try runSync()
    } catch let error as BridgeError {
        emit(["ok": false, "error": error.message])
    } catch {
        emit(["ok": false, "error": error.localizedDescription])
    }
default:
    emit(["ok": false, "error": "未知的行事曆指令。"])
}

import SwiftUI

/// Block-level markdown for Coach replies — the iOS counterpart of the console's
/// `app/console/assistant/markdown.tsx`.
///
/// Why this exists at all: `Text(someString)` does NOT parse markdown.  SwiftUI only
/// interprets markdown when the argument is a `LocalizedStringKey` *literal*, so a
/// runtime String from `/api/chat` printed `**bold**`, `## heading`, `- bullet` and
/// pipe tables verbatim.
///
/// Why not `AttributedString(markdown:)` on its own: it flattens block structure —
/// headings, list bullets and tables all collapse into one run of prose, and those
/// are exactly what Coach emits.  So blocks are split here and each block's INLINE
/// span goes through `AttributedString(markdown:)`.
///
/// SECURITY — Coach text is untrusted model output that can carry RAG/tool content,
/// so this mirrors the two properties the web renderer spells out:
///   1. No raw HTML is ever interpreted.  There is no HTML engine in this path at
///      all; a `<script>`/`<img>`/`<a href>` in the reply is inert text.
///   2. No remote image is ever auto-loaded.  `![alt](url)` is rewritten to an inert
///      `[image: alt]` label BEFORE parsing, so the URL never reaches an `imageURL`
///      attribute and never reaches an `AsyncImage`.  A real image view would make
///      the phone fetch an attacker-chosen URL the moment the reply renders, which
///      is a metadata-exfiltration channel for prompt-injected content.
enum CoachMarkdown {
    enum Block: Equatable {
        case heading(level: Int, text: String)
        case bullet(text: String)
        case ordered(number: String, text: String)
        case code(String)
        case table(header: [String], rows: [[String]])
        case paragraph(text: String)
    }

    // MARK: - Block splitting

    static func blocks(from raw: String) -> [Block] {
        let lines = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")
        var result: [Block] = []
        var codeBuffer: [String]?
        var index = 0

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                if let buffer = codeBuffer {
                    result.append(.code(buffer.joined(separator: "\n")))
                    codeBuffer = nil
                } else {
                    codeBuffer = []
                }
                index += 1
                continue
            }
            if codeBuffer != nil {
                codeBuffer?.append(line)
                index += 1
                continue
            }
            if trimmed.isEmpty {
                index += 1
                continue
            }
            if let (table, consumed) = tableBlock(at: index, in: lines) {
                result.append(table)
                index += consumed
                continue
            }
            if let heading = headingBlock(trimmed) {
                result.append(heading)
                index += 1
                continue
            }
            if let bullet = bulletText(trimmed) {
                result.append(.bullet(text: bullet))
                index += 1
                continue
            }
            if let (number, text) = orderedItem(trimmed) {
                result.append(.ordered(number: number, text: text))
                index += 1
                continue
            }
            result.append(.paragraph(text: trimmed))
            index += 1
        }

        // An unterminated fence still renders as code rather than leaking ``` markers.
        if let buffer = codeBuffer, !buffer.isEmpty {
            result.append(.code(buffer.joined(separator: "\n")))
        }
        return result
    }

    private static func headingBlock(_ trimmed: String) -> Block? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard hashes >= 1, hashes <= 6 else { return nil }
        let rest = trimmed.dropFirst(hashes)
        guard rest.hasPrefix(" ") else { return nil }
        let text = String(rest).trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        // Deeper levels exist in markdown but the phone has no type ramp for them.
        return .heading(level: min(hashes, 3), text: text)
    }

    private static func bulletText(_ trimmed: String) -> String? {
        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            let text = String(trimmed.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces)
            return text.isEmpty ? nil : text
        }
        return nil
    }

    private static func orderedItem(_ trimmed: String) -> (String, String)? {
        let digits = trimmed.prefix(while: { $0.isNumber })
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let rest = trimmed.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        let text = String(rest.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return (String(digits), text)
    }

    // MARK: - Tables (GFM pipe tables — what Coach actually emits)

    private static func tableBlock(at start: Int, in lines: [String]) -> (Block, Int)? {
        guard start + 1 < lines.count else { return nil }
        let header = lines[start].trimmingCharacters(in: .whitespaces)
        guard header.hasPrefix("|"), isDelimiterRow(lines[start + 1].trimmingCharacters(in: .whitespaces)) else {
            return nil
        }
        var rows: [[String]] = []
        var index = start + 2
        while index < lines.count {
            let row = lines[index].trimmingCharacters(in: .whitespaces)
            guard row.hasPrefix("|") else { break }
            rows.append(cells(row))
            index += 1
        }
        return (.table(header: cells(header), rows: rows), index - start)
    }

    private static func isDelimiterRow(_ line: String) -> Bool {
        guard line.hasPrefix("|") else { return false }
        let parts = cells(line)
        guard !parts.isEmpty else { return false }
        return parts.allSatisfy { part in
            part.contains("-") && part.allSatisfy { $0 == "-" || $0 == ":" }
        }
    }

    private static func cells(_ line: String) -> [String] {
        var body = Substring(line)
        if body.hasPrefix("|") { body = body.dropFirst() }
        if body.hasSuffix("|") { body = body.dropLast() }
        return body.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    // MARK: - Inline spans

    /// Bold / italic / inline code / links for one line.  Block markers are already
    /// stripped by `blocks(from:)`, so this parses INLINE ONLY — otherwise the
    /// parser would re-swallow structure and flatten it again.
    static func inline(_ text: String) -> AttributedString {
        let safe = sanitizingImages(text)
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        guard var parsed = try? AttributedString(markdown: safe, options: options) else {
            // Defensive only — `.returnPartiallyParsedIfPossible` does not throw in practice.
            return AttributedString(safe.replacingOccurrences(of: "\\[", with: "[")
                .replacingOccurrences(of: "\\]", with: "]"))
        }
        // Belt and braces: no run may carry an image URL the renderer could fetch.
        // Ranges are collected first — never mutate while iterating `runs`.
        var imageRanges: [Range<AttributedString.Index>] = []
        for run in parsed.runs where run.imageURL != nil {
            imageRanges.append(run.range)
        }
        for range in imageRanges {
            parsed[range].imageURL = nil
        }
        return parsed
    }

    /// Rewrites `![alt](url)` to an inert `\[image: alt\]` label.  The backslashes keep
    /// the result from re-parsing as a link; the inline parser removes them on render.
    static func sanitizingImages(_ text: String) -> String {
        guard text.contains("![") else { return text }
        var output = ""
        var rest = Substring(text)
        while let marker = rest.range(of: "![") {
            output += rest[rest.startIndex..<marker.lowerBound]
            let afterMarker = rest[marker.upperBound...]
            guard let closeBracket = afterMarker.firstIndex(of: "]") else {
                // Unterminated — emit the remainder as-is; there is no URL to strip.
                output += rest[marker.lowerBound...]
                return output
            }
            let alt = String(afterMarker[afterMarker.startIndex..<closeBracket])
            var tail = afterMarker[afterMarker.index(after: closeBracket)...]
            if tail.first == "(", let closeParen = tail.firstIndex(of: ")") {
                tail = tail[tail.index(after: closeParen)...]
            }
            output += imageLabel(alt: alt)
            rest = tail
        }
        output += rest
        return output
    }

    private static func imageLabel(alt: String) -> String {
        let cleaned = alt
            .filter { !"[]()*`!\\".contains($0) }
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "\\[image\\]" : "\\[image: \(cleaned)\\]"
    }

    // MARK: - Plain-text projection (what the reader sees; used by the tests)

    static func plainText(from raw: String) -> String {
        blocks(from: raw).map(renderedText).joined(separator: "\n")
    }

    static func renderedText(_ block: Block) -> String {
        switch block {
        case .heading(_, let text):
            return String(inline(text).characters)
        case .bullet(let text):
            return "\u{2022} " + String(inline(text).characters)
        case .ordered(let number, let text):
            return "\(number). " + String(inline(text).characters)
        case .code(let code):
            return code
        case .table(let header, let rows):
            return ([header] + rows)
                .map { row in row.map { String(inline($0).characters) }.joined(separator: "\t") }
                .joined(separator: "\n")
        case .paragraph(let text):
            return String(inline(text).characters)
        }
    }
}

/// Renders one Coach reply.  Font and foreground style come from the caller, so this
/// drops straight into the existing bubble.
struct CoachMarkdownText: View {
    private let blocks: [CoachMarkdown.Block]

    init(_ raw: String) {
        self.blocks = CoachMarkdown.blocks(from: raw)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                row(for: block)
            }
        }
    }

    @ViewBuilder
    private func row(for block: CoachMarkdown.Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(CoachMarkdown.inline(text))
                .font(headingFont(level))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: "\u{2022}")
                Text(CoachMarkdown.inline(text))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .ordered(let number, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: "\(number).")
                    .monospacedDigit()
                Text(CoachMarkdown.inline(text))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .code(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: code)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
            }
            .padding(8)
            .background(
                Color.primary.opacity(0.06),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                            Text(CoachMarkdown.inline(cell))
                                .font(.appCaption)
                                .fontWeight(.semibold)
                        }
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(CoachMarkdown.inline(cell))
                                    .font(.appCaption)
                            }
                        }
                    }
                }
            }
        case .paragraph(let text):
            Text(CoachMarkdown.inline(text))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .appTitle3.weight(.semibold)
        default: return .appHeadline
        }
    }
}

import SwiftUI
import UIKit

/// Candlestick "SOCRATIC TRADE" wordmark — Swift port of `app/console/ui/candle-ticker.ts`
/// so native login matches the website `HeaderLogo` (same letter sampling + green-biased ticker).

// MARK: - Model

private struct TickerCell {
    let nx: CGFloat
    let ntop: CGFloat
    let nh: CGFloat
}

private struct TickerUnit {
    let color: Color
    let frac: CGFloat
    let off: CGFloat
}

private struct Wordmark {
    let cells: [TickerCell]
    let ar: CGFloat
    let ncol: Int
    let hcol: [Int]
    let hshort: [Bool]
}

/// Must match `WORDMARK_AR` in `app/console/ui/candle-ticker.ts`.
private let wordmarkAR: CGFloat = 13.081

private let tickerGreens: [Color] = [
    Color(red: 0x04 / 255, green: 0x78 / 255, blue: 0x57 / 255), // #047857
    Color(red: 0x05 / 255, green: 0x96 / 255, blue: 0x69 / 255), // #059669
    Color(red: 0x08 / 255, green: 0x99 / 255, blue: 0x81 / 255)  // #089981
]

private let tickerReds: [Color] = [
    Color(red: 0xbe / 255, green: 0x12 / 255, blue: 0x3c / 255), // #be123c
    Color(red: 0xdc / 255, green: 0x26 / 255, blue: 0x26 / 255), // #dc2626
    Color(red: 0xe1 / 255, green: 0x1d / 255, blue: 0x48 / 255)  // #e11d48
]

private enum CandleWordmarkModel {
    static let shared: (wm: Wordmark, units: [TickerUnit]) = {
        (sampleWordmark("SOCRATIC TRADE"), buildTickerUnits(count: 12))
    }()

    private static func mulberry32(_ seed: UInt32) -> () -> Double {
        var a = seed
        return {
            a = a &+ 0x6d2b79f5
            var t = a
            t = (t ^ (t >> 15)) &* (1 | t)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t)))
            t = t ^ (t >> 14)
            return Double(t) / 4294967296.0
        }
    }

    /// Rasterize bold text and slice into candle cells (mirrors `sampleCells` in candle-ticker.ts).
    private static func sampleCells(
        text: String,
        fontPx: CGFloat,
        tracking: CGFloat,
        pitch: Int
    ) -> (cells: [(cx: CGFloat, top: CGFloat, h: CGFloat)], w: CGFloat, h: CGFloat) {
        let font = UIFont(name: "Arial-BoldMT", size: fontPx)
            ?? UIFont.systemFont(ofSize: fontPx, weight: .bold)
        let chars = Array(text)
        let widths: [CGFloat] = chars.map { ch in
            if ch == " " { return fontPx * 0.45 }
            return (String(ch) as NSString).size(withAttributes: [.font: font]).width
        }
        let total = widths.reduce(0, +) + tracking * CGFloat(max(0, chars.count - 1))
        let padX = ceil(fontPx * 0.35)
        let H = Int(ceil(fontPx * 1.5))
        let W = Int(ceil(total) + padX * 2)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        var pixelData = [UInt8](repeating: 0, count: W * H * 4)
        guard let ctx = CGContext(
            data: &pixelData,
            width: W,
            height: H,
            bitsPerComponent: 8,
            bytesPerRow: W * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return ([], 1, 1)
        }

        // CoreGraphics is bottom-up; flip so y=0 is top (matches web canvas).
        ctx.translateBy(x: 0, y: CGFloat(H))
        ctx.scaleBy(x: 1, y: -1)
        ctx.setFillColor(UIColor.clear.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        ctx.setFillColor(UIColor.white.cgColor)

        var x = padX
        let baseline = fontPx * 1.1
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.white
        ]
        UIGraphicsPushContext(ctx)
        for i in 0..<chars.count {
            if chars[i] != " " {
                let s = String(chars[i]) as NSString
                // draw(at:) y is the top of the text box in flipped UIKit coords when using
                // attributed draw with baseline ≈ font ascender from top of glyph box.
                let drawY = baseline - font.ascender
                s.draw(at: CGPoint(x: x, y: drawY), withAttributes: attrs)
            }
            x += widths[i] + tracking
        }
        UIGraphicsPopContext()

        func alphaAt(xx: Int, yy: Int) -> UInt8 {
            // Row 0 of a CGBitmapContext's buffer is the TOP of the image, and the
            // translate/scale above already put user space in top-origin coordinates — so a
            // top-origin yy maps straight to buffer row yy, with no conversion.
            //
            // This used to apply a second flip (`H - 1 - yy`) on the theory that the buffer was
            // "still physical bottom-up". It isn't, and the extra flip sampled the wordmark
            // upside down: every candle column got its letter's rows in reverse, so the mark
            // rendered vertically mirrored — S read as 2, R as K, A as Y, T as ⊥. It was subtle
            // enough to survive review because the mirrored form is still roughly wordmark-shaped
            // at a glance, and the web original (app/console/ui/candle-ticker.ts, which samples a
            // top-origin canvas with no flip at all) was correct the whole time.
            guard xx >= 0, xx < W, yy >= 0, yy < H else { return 0 }
            return pixelData[(yy * W + xx) * 4 + 3]
        }

        var x0 = W, x1 = 0, y0 = H, y1 = 0
        for yy in 0..<H {
            for xx in 0..<W {
                if alphaAt(xx: xx, yy: yy) > 128 {
                    if xx < x0 { x0 = xx }
                    if xx > x1 { x1 = xx }
                    if yy < y0 { y0 = yy }
                    if yy > y1 { y1 = yy }
                }
            }
        }
        if x1 <= x0 || y1 <= y0 {
            return ([], 1, 1)
        }

        var cells: [(cx: CGFloat, top: CGFloat, h: CGFloat)] = []
        let half = CGFloat((pitch - 4) / 2)
        var cx = x0 + 2
        while cx < x1 {
            var colv = [CGFloat](repeating: 0, count: H)
            for yy in 0..<H {
                var s: CGFloat = 0
                var n: CGFloat = 0
                var xx = cx
                while xx < cx + pitch - 4 && xx < W {
                    s += CGFloat(alphaAt(xx: xx, yy: yy))
                    n += 1
                    xx += 1
                }
                colv[yy] = n > 0 ? s / n / 255 : 0
            }
            var yy = 0
            while yy < H {
                if colv[yy] > 0.42 {
                    let start = yy
                    while yy < H && colv[yy] > 0.42 { yy += 1 }
                    if yy - start >= Int(round(fontPx * 0.03)) {
                        cells.append((
                            cx: CGFloat(cx - x0) + half,
                            top: CGFloat(start - y0),
                            h: CGFloat(yy - start)
                        ))
                    }
                } else {
                    yy += 1
                }
            }
            cx += pitch
        }
        return (cells, CGFloat(x1 - x0), CGFloat(y1 - y0))
    }

    private static func sampleWordmark(_ text: String) -> Wordmark {
        let s = sampleCells(text: text, fontPx: 200, tracking: 10, pitch: 15)
        let cells: [TickerCell] = s.cells.map {
            TickerCell(nx: $0.cx / s.w, ntop: $0.top / s.h, nh: $0.h / s.h)
        }
        func key(_ nx: CGFloat) -> Int { Int(round(nx * 1000)) }
        let uniq = Array(Set(cells.map { key($0.nx) })).sorted()
        var map: [Int: Int] = [:]
        for (i, v) in uniq.enumerated() { map[v] = i }
        let hcol = cells.map { map[key($0.nx)] ?? 0 }
        let hshort = cells.map { $0.nh < 0.16 }
        let ar = s.h > 0 ? s.w / s.h : wordmarkAR
        return Wordmark(
            cells: cells,
            ar: ar,
            ncol: max(1, uniq.count),
            hcol: hcol,
            hshort: hshort
        )
    }

    private static func buildTickerUnits(count P: Int) -> [TickerUnit] {
        let hr = mulberry32(9)
        func hgauss(_ m: Double, _ sd: Double) -> Double {
            var u = 0.0, v = 0.0
            while u == 0 { u = hr() }
            while v == 0 { v = hr() }
            return m + sd * sqrt(-2 * log(u)) * cos(2 * Double.pi * v)
        }
        var price: [Double] = [0]
        for _ in 0..<P {
            price.append(price[price.count - 1] + hgauss(0.16, 0.9))
        }
        let rets = (0..<P).map { i in price[i + 1] - price[i] }
        let mx = rets.map { abs($0) }.max() ?? 1
        let denom = mx == 0 ? 1 : mx
        return rets.map { r in
            let up = r >= 0
            let mag = abs(r) / denom
            let idx = min(2, Int(floor(mag * 3)))
            let palette = up ? tickerGreens : tickerReds
            return TickerUnit(
                color: palette[idx],
                frac: CGFloat(0.4 + 0.45 * mag),
                off: up ? 0.3 : 0.62
            )
        }
    }
}

// MARK: - View

/// Animated candlestick wordmark (web `HeaderLogo` parity).
struct CandleWordmarkView: View {
    var height: CGFloat = 28
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var displayWidth: CGFloat {
        max(1, height * wordmarkAR)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: reduceMotion ? 86_400 : 1.0)) { context in
            let tick = reduceMotion
                ? 0
                : Int(context.date.timeIntervalSinceReferenceDate)
            Canvas { ctx, size in
                drawTicker(context: ctx, size: size, tick: tick)
            }
            .frame(width: displayWidth, height: height)
            .accessibilityElement()
            .accessibilityLabel("Socratic Trade")
        }
    }

    private func drawTicker(context: GraphicsContext, size: CGSize, tick: Int) {
        let model = CandleWordmarkModel.shared
        let wm = model.wm
        let units = model.units
        let P = units.count
        guard P > 0, wm.ncol > 0, !wm.cells.isEmpty else { return }

        let bw = max(1, size.width / CGFloat(wm.ncol) * 0.55)
        for j in 0..<wm.cells.count {
            let c = wm.cells[j]
            let top = c.ntop * size.height
            let h = c.nh * size.height
            let unitIndex = ((wm.hcol[j] + tick) % P + P) % P
            let u = units[unitIndex]
            let frac = wm.hshort[j] ? max(u.frac, 0.82) : u.frac
            let bh = max(1, h * frac)
            let bt = top + (h - bh) * u.off
            let x = c.nx * size.width

            var wick = Path()
            wick.move(to: CGPoint(x: x, y: top))
            wick.addLine(to: CGPoint(x: x, y: top + h))
            context.stroke(
                wick,
                with: .color(u.color),
                style: StrokeStyle(lineWidth: max(0.8, bw * 0.26), lineCap: .round)
            )

            let body = CGRect(x: x - bw / 2, y: bt, width: bw, height: bh)
            let r = min(1.5, bw * 0.25)
            context.fill(
                Path(roundedRect: body, cornerRadius: r),
                with: .color(u.color)
            )
        }
    }
}

#if DEBUG
#Preview("Candle wordmark") {
    VStack(spacing: 32) {
        CandleWordmarkView(height: 22)
        CandleWordmarkView(height: 32)
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(red: 0xee / 255, green: 0xf1 / 255, blue: 0xf5 / 255))
}
#endif

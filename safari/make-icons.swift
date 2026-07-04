// Generates the toolbar/app icons: a soft amber dot on transparent ground.
// Usage: swift make-icons.swift <outdir>
import AppKit

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "extension/images"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func icon(_ size: Int) {
    let s = CGFloat(size)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext
    // soft outer glow
    let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                          colors: [NSColor(calibratedRed: 1.0, green: 0.72, blue: 0.32, alpha: 0.55).cgColor,
                                   NSColor(calibratedRed: 1.0, green: 0.72, blue: 0.32, alpha: 0.0).cgColor] as CFArray,
                          locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: s/2, y: s/2), startRadius: 0,
                           endCenter: CGPoint(x: s/2, y: s/2), endRadius: s/2, options: [])
    // amber core
    let core = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                          colors: [NSColor(calibratedRed: 1.0, green: 0.82, blue: 0.45, alpha: 1).cgColor,
                                   NSColor(calibratedRed: 0.93, green: 0.58, blue: 0.18, alpha: 1).cgColor] as CFArray,
                          locations: [0, 1])!
    let r = s * 0.30
    ctx.saveGState()
    ctx.addEllipse(in: CGRect(x: s/2 - r, y: s/2 - r, width: r*2, height: r*2))
    ctx.clip()
    ctx.drawRadialGradient(core, startCenter: CGPoint(x: s/2 - r*0.3, y: s/2 + r*0.3), startRadius: 0,
                           endCenter: CGPoint(x: s/2, y: s/2), endRadius: r*1.2, options: [])
    ctx.restoreGState()
    img.unlockFocus()
    guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { fatalError("encode \(size)") }
    try! png.write(to: URL(fileURLWithPath: "\(outDir)/icon-\(size).png"))
    print("icon-\(size).png")
}
for s in [16, 19, 32, 38, 48, 64, 96, 128, 256, 512] { icon(s) }

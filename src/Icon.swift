import Cocoa
let output = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath:output, withIntermediateDirectories:true)
for size in [16,32,64,128,256,512,1024] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil, pixelsWide:size, pixelsHigh:size, bitsPerSample:8, samplesPerPixel:4, hasAlpha:true, isPlanar:false, colorSpaceName:.deviceRGB, bytesPerRow:0, bitsPerPixel:0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:bitmap)
    let scale = CGFloat(size)/1024
    let transform = NSAffineTransform(); transform.scale(by:scale); transform.concat()
    NSColor(calibratedRed:0.16,green:0.34,blue:0.29,alpha:1).setFill()
    NSBezierPath(roundedRect:NSRect(x:40,y:40,width:944,height:944),xRadius:220,yRadius:220).fill()
    NSColor(calibratedRed:0.94,green:0.94,blue:0.85,alpha:1).setStroke()
    let left = NSBezierPath(ovalIn:NSRect(x:222,y:240,width:390,height:544));left.lineWidth=23;left.stroke()
    NSColor(calibratedRed:0.75,green:0.82,blue:0.65,alpha:1).setStroke()
    let right = NSBezierPath(ovalIn:NSRect(x:412,y:240,width:390,height:544));right.lineWidth=23;right.stroke()
    NSGraphicsContext.restoreGraphicsState()
    let data=bitmap.representation(using:.png,properties:[:])!
    let names:[String]
    switch size {
    case 16:names=["icon_16x16.png"]
    case 32:names=["icon_16x16@2x.png","icon_32x32.png"]
    case 64:names=["icon_32x32@2x.png"]
    case 128:names=["icon_128x128.png"]
    case 256:names=["icon_128x128@2x.png","icon_256x256.png"]
    case 512:names=["icon_256x256@2x.png","icon_512x512.png"]
    default:names=["icon_512x512@2x.png"]
    }
    for name in names {try data.write(to:URL(fileURLWithPath:output).appendingPathComponent(name))}
}

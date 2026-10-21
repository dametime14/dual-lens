import Foundation
import PDFKit

// PDFKit extracts the text layer only. Do not emit a silently truncated document.
guard CommandLine.arguments.count == 2,
      let document = PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1])),
      !document.isLocked, document.pageCount <= 300 else { exit(1) }
var output = ""
for page in 0..<document.pageCount {
    if let text = document.page(at:page)?.string, !text.isEmpty {
        output += "[페이지 \(page + 1)]\n\(text)\n\n"
        if output.utf8.count > 100000 { exit(2) }
    }
}
guard !output.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { exit(3) }
FileHandle.standardOutput.write(Data(output.utf8))

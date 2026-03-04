
export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("File read error"));
    reader.readAsDataURL(file);
  });
}

export async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await fileToDataUrl(file);
  return dataUrl.split(',')[1];
}

/**
 * Fast partial read for large text/email files.
 */
export async function readPartialText(file: File): Promise<string> {
  const slice = file.slice(0, 1024 * 512); // Increased to 512KB for better email parsing
  return await slice.text();
}

export function preprocessEmailText(text: string): string {
  return text.replace(/[A-Za-z0-9+/]{100,}/g, '[DATA]');
}

/**
 * Basic RTF to Text converter using regex to strip control words.
 */
export function rtfToText(rtf: string): string {
  if (!rtf || typeof rtf !== 'string') return "";
  
  // Basic stripping of RTF control words and groups
  // This extracts the printable text content from the RTF structure
  let text = rtf.replace(/\\([a-z]{1,32})(-?\d+)? ?|\\'([0-9a-f]{2})|\\\{|\\\}|\r\n|[\{\}]/gi, (match, word, arg, hex) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return "";
  });
  
  // Clean up multiple spaces and newlines
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Improved string extraction for .msg files (Outlook Structured Storage).
 * Scans for printable strings in both UTF-16LE and UTF-8/ASCII encodings.
 */
export async function msgToText(file: File): Promise<string> {
  const buffer = await file.slice(0, 1024 * 1024).arrayBuffer(); // Read up to 1MB for larger bodies
  const view = new Uint8Array(buffer);
  
  const decoderUTF16 = new TextDecoder('utf-16le', { fatal: false });
  const decoderUTF8 = new TextDecoder('utf-8', { fatal: false });
  
  let utf16Str = "";
  try {
    utf16Str = decoderUTF16.decode(buffer);
  } catch (e) {}

  let utf8Str = "";
  try {
    utf8Str = decoderUTF8.decode(buffer);
  } catch (e) {}

  /**
   * Filter and extract meaningful printable blocks.
   * Outlook stores properties in dedicated streams; we look for the contiguous printable text.
   */
  const extractValidStrings = (raw: string) => {
    // Regex for sequences of printable characters including common international characters
    const matches = raw.match(/[\x20-\x7E\u00A0-\u00FF\u0100-\u017F]{5,}/g);
    if (!matches) return [];
    
    return matches.filter(s => {
      // Exclude strings that are purely noise symbols
      if (/^[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/? ]+$/.test(s)) return false;
      // Exclude common binary padding patterns
      if (/^(.)\1+$/.test(s) && s.length < 20) return false;
      return true;
    });
  };

  const allStrings = [
    ...extractValidStrings(utf16Str),
    ...extractValidStrings(utf8Str)
  ];
  
  // Remove duplicates and prioritize longer segments which are likely body content
  const uniqueStrings = Array.from(new Set(allStrings)).sort((a, b) => b.length - a.length);
  
  // Combine results with a slight preference for structural markers
  return uniqueStrings.slice(0, 100).join("\n").substring(0, 20000); 
}

/**
 * Simple MIME parser for .eml files to extract body and binary attachments.
 * IMPORTANT: Preserves headers to ensure AI can read metadata like 'To' and 'From'.
 */
export async function extractEmlContent(rawText: string): Promise<{ text: string, attachments: { data: string, mimeType: string }[] }> {
  // Extract critical headers using regex for high precision extraction before body parsing
  // This helps separate metadata from content to prevent "Subject as Recipient" errors
  const fromMatch = rawText.match(/^From:\s*(.+)$/im);
  const toMatch = rawText.match(/^To:\s*(.+)$/im);
  const subjectMatch = rawText.match(/^Subject:\s*(.+)$/im);
  const dateMatch = rawText.match(/^Date:\s*(.+)$/im);

  const boundaryMatch = rawText.match(/boundary=(?:"?)([^";\n\r]+)(?:"?)/i);
  
  // Extract raw headers block (approx first 2k chars) as backup
  const headerEndIndex = rawText.indexOf('\n\n');
  const headers = headerEndIndex !== -1 ? rawText.substring(0, headerEndIndex) : rawText.substring(0, 2000);

  let emailBody = "";
  const attachments: { data: string, mimeType: string }[] = [];

  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawText.split(`--${boundary}`);
    
    for (const part of parts) {
      if (part.trim() === "" || part.trim() === "--") continue;

      const contentTypeMatch = part.match(/Content-Type:\s*([^;\n\r]+)/i);
      const mimeType = contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : "";

      // Extract Text Body
      if (mimeType.includes("text/plain") || (mimeType.includes("text/html") && !emailBody)) {
        const body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/--$/, "").trim();
        // Basic Quoted-Printable decoding for common chars
        emailBody += body.replace(/=([A-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/=\r?\n/g, "");
      } 
      // Extract Binary Attachments (PDF/Images)
      else if (mimeType.includes("application/pdf") || mimeType.includes("image/")) {
        const sections = part.split(/\r?\n\r?\n/);
        if (sections.length > 1) {
          const base64Data = sections.slice(1).join("").replace(/[\r\n\s]/g, "").replace(/--$/, "");
          if (base64Data.length > 100) { // Avoid small junk
             attachments.push({ data: base64Data, mimeType });
          }
        }
      }
    }
  } else {
      // Fallback if no boundary - assume entire text is body if not just headers
      emailBody = rawText.substring(headers.length).trim();
  }

  // Construct a payload that explicitly separates headers for the AI
  const fullText = `[CRITICAL_METADATA_EXTRACTED_BY_SYSTEM]
FROM_HEADER: ${fromMatch ? fromMatch[1].trim() : "Not Found"}
TO_HEADER: ${toMatch ? toMatch[1].trim() : "Not Found"}
SUBJECT_HEADER: ${subjectMatch ? subjectMatch[1].trim() : "Not Found"}
DATE_HEADER: ${dateMatch ? dateMatch[1].trim() : "Not Found"}
[/CRITICAL_METADATA_EXTRACTED_BY_SYSTEM]

[RAW_HEADERS]
${headers}
[/RAW_HEADERS]

[EMAIL_BODY]
${emailBody || "No text body found."}
[/EMAIL_BODY]`;

  return { 
    text: fullText, 
    attachments: attachments.slice(0, 3) // Limit to top 3 attachments to preserve tokens
  };
}

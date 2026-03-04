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
  const slice = file.slice(0, 1024 * 512); // 512KB limit
  return await slice.text();
}

/**
 * 🚀 TOKEN OPTIMIZATION: Strips base64 blocks and hex dumps from raw text
 */
export function preprocessEmailText(text: string): string {
  // Remove massive blocks of base64 (usually images/attachments hidden in text)
  let clean = text.replace(/([A-Za-z0-9+/]{80,}\r?\n)+[A-Za-z0-9+/]*={0,2}/g, '[BASE64_ATTACHMENT_REMOVED]');
  // Remove massive blocks of hex (often found in RTF/MSG)
  clean = clean.replace(/([0-9A-Fa-f]{80,}\r?\n)+[0-9A-Fa-f]*/g, '[HEX_DATA_REMOVED]');
  // Remove long strings of repeating characters (e.g., -------- or =======)
  clean = clean.replace(/([=\-_*~]){20,}/g, '$1$1$1[DIVIDER]$1$1$1');
  return clean;
}

/**
 * Basic RTF to Text converter using regex to strip control words.
 */
export function rtfToText(rtf: string): string {
  if (!rtf || typeof rtf !== 'string') return "";
  
  // Basic stripping of RTF control words and groups
  let text = rtf.replace(/\\[a-z]{1,32}(-?\d+)? ?|\\'([0-9a-f]{2})|\\{/gi, (match, arg, hex) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return "";
  });
  
  // Clean up structural braces and massive whitespace
  text = text.replace(/[{}]/g, '');
  text = preprocessEmailText(text); // Strip hidden hex/base64
  return text.replace(/\s+/g, ' ').trim().substring(0, 15000); // Hard limit to prevent token blowouts
}

/**
 * Improved string extraction for .msg files (Outlook Structured Storage).
 */
export async function msgToText(file: File): Promise<string> {
  const buffer = await file.slice(0, 1024 * 512).arrayBuffer(); // Read up to 512kb (prevent memory crash)
  const decoderUTF16 = new TextDecoder('utf-16le', { fatal: false });
  const decoderUTF8 = new TextDecoder('utf-8', { fatal: false });
  
  const utf16Str = decoderUTF16.decode(buffer);
  const utf8Str = decoderUTF8.decode(buffer);

  // 🚀 TOKEN OPTIMIZATION: Extract only strings that look like actual sentences/data
  const extractValidStrings = (raw: string) => {
    // Look for strings that have at least one space and alphanumeric chars (filters out binary junk)
    const matches = raw.match(/[A-Za-z0-9 \.,!?'"@£$%&\(\)\-:\n\r]{15,}/g);
    if (!matches) return [];
    
    return matches.filter(s => {
      const spaceCount = (s.match(/ /g) || []).length;
      return spaceCount > 2; // Real sentences have spaces. Binary junk usually doesn't.
    });
  };

  const allStrings = [
    ...extractValidStrings(utf16Str),
    ...extractValidStrings(utf8Str)
  ];
  
  const uniqueStrings = Array.from(new Set(allStrings));
  
  // Join the most sentence-like blocks.
  const joinedText = uniqueStrings.join("\n\n");
  
  return preprocessEmailText(joinedText).substring(0, 15000); 
}

/**
 * 🚀 TOKEN OPTIMIZATION: Advanced MIME parser that strips HTML and ignores binary chunks
 */
export async function extractEmlContent(rawText: string): Promise<{ text: string, attachments: { data: string, mimeType: string }[] }> {
  // Extract critical headers (ACCURACY FIX: multiline regex support)
  const fromMatch = rawText.match(/^From:\s*([\s\S]*?)(?=\n[A-Z][a-z0-9\-]+:|\n\n)/im);
  const toMatch = rawText.match(/^To:\s*([\s\S]*?)(?=\n[A-Z][a-z0-9\-]+:|\n\n)/im);
  const subjectMatch = rawText.match(/^Subject:\s*([\s\S]*?)(?=\n[A-Z][a-z0-9\-]+:|\n\n)/im);
  const dateMatch = rawText.match(/^Date:\s*([\s\S]*?)(?=\n[A-Z][a-z0-9\-]+:|\n\n)/im);

  const boundaryMatch = rawText.match(/boundary=(?:"?)([^";\n\r]+)(?:"?)/i);
  
  let emailBody = "";
  const attachments: { data: string, mimeType: string }[] = [];

  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawText.split(`--${boundary}`);
    
    // Track if we found plain text (so we can ignore HTML if possible)
    let foundPlainText = false;

    for (const part of parts) {
      if (part.trim() === "" || part.trim() === "--") continue;

      const contentTypeMatch = part.match(/Content-Type:\s*([^;\n\r]+)/i);
      const mimeType = contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : "";
      
      const isHtml = mimeType.includes("text/html");
      const isPlain = mimeType.includes("text/plain");

      if (isPlain) {
        foundPlainText = true;
        let body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/--$/, "").trim();
        emailBody += body.replace(/=([A-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/=\r?\n/g, "") + "\n\n";
      } 
      else if (isHtml && !foundPlainText) {
        // Only use HTML if we didn't find a plain text alternative
        let body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/--$/, "").trim();
        body = body.replace(/=([A-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/=\r?\n/g, "");
        // Strip HTML tags to save tokens
        body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ''); // Remove CSS
        body = body.replace(/<[^>]+>/g, ' '); // Strip all other tags
        emailBody += body + "\n\n";
      }
      else if (mimeType.includes("application/pdf") || mimeType.includes("image/")) {
        const sections = part.split(/\r?\n\r?\n/);
        if (sections.length > 1) {
          const base64Data = sections.slice(1).join("").replace(/[\r\n\s]/g, "").replace(/--$/, "");
          if (base64Data.length > 100) { 
             attachments.push({ data: base64Data, mimeType });
          }
        }
      }
    }
  } else {
      // Fallback if no boundary
      const headerEndIndex = rawText.indexOf('\n\n');
      emailBody = headerEndIndex !== -1 ? rawText.substring(headerEndIndex) : rawText;
  }

  // Clean the final email body of any leaked base64 or massive spacing
  emailBody = preprocessEmailText(emailBody).replace(/\s+/g, ' ').trim();

  // Construct a much lighter payload
  const fullText = `[METADATA]
FROM: ${fromMatch ? fromMatch[1].trim() : "Not Found"}
TO: ${toMatch ? toMatch[1].trim() : "Not Found"}
SUBJECT: ${subjectMatch ? subjectMatch[1].trim() : "Not Found"}
DATE: ${dateMatch ? dateMatch[1].trim() : "Not Found"}
[/METADATA]

[BODY]
${emailBody.substring(0, 15000) || "No text body found."}
[/BODY]`;

  return { 
    text: fullText, 
    attachments: attachments.slice(0, 2) // Limit to top 2 attachments
  };
}
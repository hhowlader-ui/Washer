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
  let clean = text.replace(/([A-Za-z0-9+/]{80,}\r?\n)+[A-Za-z0-9+/]*={0,2}/g, '[BASE64_ATTACHMENT_REMOVED]');
  clean = clean.replace(/([0-9A-Fa-f]{80,}\r?\n)+[0-9A-Fa-f]*/g, '[HEX_DATA_REMOVED]');
  clean = clean.replace(/([=\-_*~]){20,}/g, '$1$1$1[DIVIDER]$1$1$1');
  return clean;
}

/**
 * 🚀 ACCURACY FIX: Aggressively scrapes readable text from legacy binary files (.doc) and .rtf
 * It strips out invisible control characters that crash the Gemini API tokenizer.
 */
export async function extractLegacyDocument(file: File): Promise<string> {
  const buffer = await file.slice(0, 1024 * 512).arrayBuffer(); // Read first 512KB

  // For RTF files (plaintext with formatting tags)
  if (file.name.toLowerCase().endsWith('.rtf')) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let text = decoder.decode(buffer);
    
    // Strip ALL non-printable binary control characters (the API killers)
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
    // Strip RTF formatting tags
    text = text.replace(/\\[a-z]{1,32}(-?\d+)? ?|\\'([0-9a-f]{2})|\\{/gi, '');
    text = text.replace(/[{}]/g, '');
    
    return preprocessEmailText(text).replace(/\s+/g, ' ').trim().substring(0, 15000);
  }

  // For .DOC / .DOCX files (Binary formats)
  // We decode the binary into strings and hunt for human-readable sentences
  const decoderUTF16 = new TextDecoder('utf-16le', { fatal: false });
  const decoderUTF8 = new TextDecoder('utf-8', { fatal: false });

  const utf16Str = decoderUTF16.decode(buffer);
  const utf8Str = decoderUTF8.decode(buffer);

  const extractValidStrings = (raw: string) => {
    // Find strings of at least 10 standard printable characters
    const matches = raw.match(/[\x20-\x7E\u00A0-\u00FF]{10,}/g);
    if (!matches) return [];
    
    return matches.filter(s => {
      // Must contain spaces to be considered real document text (filters out binary code)
      const spaceCount = (s.match(/ /g) || []).length;
      return spaceCount > 1; 
    });
  };

  const allStrings = [
    ...extractValidStrings(utf16Str),
    ...extractValidStrings(utf8Str)
  ];

  const uniqueStrings = Array.from(new Set(allStrings));
  const joinedText = uniqueStrings.join("\n\n");

  return preprocessEmailText(joinedText).replace(/\s+/g, ' ').trim().substring(0, 15000);
}

/**
 * Improved string extraction for .msg files (Outlook Structured Storage).
 */
export async function msgToText(file: File): Promise<string> {
  const buffer = await file.slice(0, 1024 * 512).arrayBuffer(); 
  const decoderUTF16 = new TextDecoder('utf-16le', { fatal: false });
  const decoderUTF8 = new TextDecoder('utf-8', { fatal: false });
  
  const utf16Str = decoderUTF16.decode(buffer);
  const utf8Str = decoderUTF8.decode(buffer);

  const extractValidStrings = (raw: string) => {
    const matches = raw.match(/[A-Za-z0-9 \.,!?'"@£$%&\(\)\-:\n\r]{15,}/g);
    if (!matches) return [];
    
    return matches.filter(s => {
      const spaceCount = (s.match(/ /g) || []).length;
      return spaceCount > 2;
    });
  };

  const allStrings = [
    ...extractValidStrings(utf16Str),
    ...extractValidStrings(utf8Str)
  ];
  
  const uniqueStrings = Array.from(new Set(allStrings));
  const joinedText = uniqueStrings.join("\n\n");
  
  return preprocessEmailText(joinedText).substring(0, 15000); 
}

/**
 * Advanced MIME parser that strips HTML and ignores binary chunks
 */
export async function extractEmlContent(rawText: string): Promise<{ text: string, attachments: { data: string, mimeType: string }[] }> {
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
        let body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/--$/, "").trim();
        body = body.replace(/=([A-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/=\r?\n/g, "");
        body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ''); 
        body = body.replace(/<[^>]+>/g, ' '); 
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
      const headerEndIndex = rawText.indexOf('\n\n');
      emailBody = headerEndIndex !== -1 ? rawText.substring(headerEndIndex) : rawText;
  }

  emailBody = preprocessEmailText(emailBody).replace(/\s+/g, ' ').trim();

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
    attachments: attachments.slice(0, 2) 
  };
}
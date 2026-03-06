import JSZip from 'jszip';

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

export async function readPartialText(file: File): Promise<string> {
  const slice = file.slice(0, 1024 * 512);
  return await slice.text();
}

export function preprocessEmailText(text: string): string {
  let clean = text.replace(/([A-Za-z0-9+/]{80,}\r?\n)+[A-Za-z0-9+/]*={0,2}/g, '[BASE64_ATTACHMENT_REMOVED]');
  clean = clean.replace(/([0-9A-Fa-f]{80,}\r?\n)+[0-9A-Fa-f]*/g, '[HEX_DATA_REMOVED]');
  clean = clean.replace(/([=\-_*~]){20,}/g, '$1$1$1[DIVIDER]$1$1$1');
  return clean;
}

/**
 * 🚀 THE BULLDOZER: If all else fails, this rips every printable character 
 * straight out of the raw binary file, bypassing all Microsoft encodings.
 */
export async function bruteForceScraper(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let text = "";
    
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0) continue; // Snap spaced-out letters together
        if (b === 9 || b === 10 || b === 13) { text += "\n"; continue; }
        // Keep English letters, numbers, punctuation, and extended ASCII (like £ and curly quotes)
        if ((b >= 32 && b <= 126) || (b >= 160 && b <= 255)) {
            text += String.fromCharCode(b);
        } else {
            text += "\n";
        }
    }
    
    // Clean up the output to only include lines with actual words
    const lines = text.split('\n').map(l => l.trim()).filter(l => {
       const letters = l.match(/[A-Za-z0-9]/g);
       return letters && letters.length > 3;
    });
    
    return preprocessEmailText(lines.join('\n')).substring(0, 15000);
}

export async function extractLegacyDocument(file: File): Promise<string> {
  const lowName = file.name.toLowerCase();

  // Try Modern DOCX
  if (lowName.endsWith('.docx')) {
    try {
      const zip = new JSZip();
      const loadedZip = await zip.loadAsync(file);
      const docXml = await loadedZip.file("word/document.xml")?.async("string");
      if (docXml) {
        let text = docXml.replace(/<\/w:tc>/g, '\t');
        text = text.replace(/<w:p\b[^>]*>/g, '\n'); 
        text = text.replace(/<[^>]+>/g, ''); 
        return text.replace(/[ \t]+/g, ' ').trim().substring(0, 15000);
      }
    } catch (e) {
      console.warn("DOCX zip failed. Attempting brute force.");
    }
  }

  // If DOCX fails, or if it's RTF/DOC, run the bulldozer!
  return await bruteForceScraper(file);
}

export async function msgToText(file: File): Promise<string> {
  const buffer = await file.slice(0, 1024 * 512).arrayBuffer(); 
  const decoderUTF16 = new TextDecoder('utf-16le', { fatal: false });
  const decoderUTF8 = new TextDecoder('utf-8', { fatal: false });
  
  const extractValidStrings = (raw: string) => {
    const matches = raw.match(/[A-Za-z0-9 \.,!?'"@£$%&\(\)\-:\n\r]{15,}/g);
    if (!matches) return [];
    return matches.filter(s => (s.match(/ /g) || []).length > 2);
  };

  const allStrings = [...extractValidStrings(decoderUTF16.decode(buffer)), ...extractValidStrings(decoderUTF8.decode(buffer))];
  return preprocessEmailText(Array.from(new Set(allStrings)).join("\n\n")).substring(0, 15000); 
}

export async function extractEmlContent(rawText: string): Promise<{ text: string, attachments: { data: string, mimeType: string }[] }> {
  const fromMatch = rawText.match(/^From:\s*([\s\S]*?)(?=\n[A-Z][a-z0-9\-]+:|\n\n)/im);
  const toMatch = rawText.match(/^To:\s*([\s\S]*?)(?=\n[A-Z][a-z0-9\-]+:|\n\n)/im);
  const subjectMatch = rawText.match(/^Subject:\s*([\s\S]*?)(?=\n[A-Z][a-z0-9\-]+:|\n\n)/im);
  const dateMatch = rawText.match(/^Date:\s*([\s\S]*?)(?=\n[A-Z][a-z0-9\-]+:|\n\n)/im);

  const boundaryMatch = rawText.match(/boundary=(?:"?)([^";\n\r]+)(?:"?)/i);
  let emailBody = "";
  const attachments: { data: string, mimeType: string }[] = [];

  if (boundaryMatch) {
    const parts = rawText.split(`--${boundaryMatch[1]}`);
    let foundPlainText = false;

    for (const part of parts) {
      if (part.trim() === "" || part.trim() === "--") continue;
      const mimeType = (part.match(/Content-Type:\s*([^;\n\r]+)/i)?.[1] || "").trim().toLowerCase();
      
      if (mimeType.includes("text/plain")) {
        foundPlainText = true;
        let body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/--$/, "").trim();
        emailBody += body.replace(/=([A-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/=\r?\n/g, "") + "\n\n";
      } 
      else if (mimeType.includes("text/html") && !foundPlainText) {
        let body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/--$/, "").trim();
        body = body.replace(/=([A-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/=\r?\n/g, "");
        body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '); 
        emailBody += body + "\n\n";
      }
      else if (mimeType.includes("application/pdf") || mimeType.includes("image/")) {
        const sections = part.split(/\r?\n\r?\n/);
        if (sections.length > 1) {
          const base64Data = sections.slice(1).join("").replace(/[\r\n\s]/g, "").replace(/--$/, "");
          if (base64Data.length > 100) attachments.push({ data: base64Data, mimeType });
        }
      }
    }
  } else {
      emailBody = rawText.substring(rawText.indexOf('\n\n') !== -1 ? rawText.indexOf('\n\n') : 0);
  }

  return { 
    text: `[METADATA]\nFROM: ${fromMatch ? fromMatch[1].trim() : "N/A"}\nTO: ${toMatch ? toMatch[1].trim() : "N/A"}\nSUBJECT: ${subjectMatch ? subjectMatch[1].trim() : "N/A"}\nDATE: ${dateMatch ? dateMatch[1].trim() : "N/A"}\n[/METADATA]\n\n[BODY]\n${preprocessEmailText(emailBody).replace(/\s+/g, ' ').trim().substring(0, 15000)}\n[/BODY]`, 
    attachments: attachments.slice(0, 2) 
  };
}
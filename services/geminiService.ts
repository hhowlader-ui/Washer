
import { GoogleGenAI, Type } from "@google/genai";
import { FILING_RULES } from "../constants";

export interface FileAnalysisResult {
  originalName: string;
  newName: string;
  summary: string;
  managedPoints: { text: string; isAsset: boolean; isCreditor: boolean; isHighRisk: boolean }[];
  referenceNumbers: { type: string; value: string; context?: string }[];
}

export async function processFile(
  content: string | { data: string, mimeType: string } | { parts: any[] },
  originalFilename: string,
  fallbackDate: string,
  mode: 'RENAME_AND_ANALYZE' | 'ANALYZE_ONLY' = 'RENAME_AND_ANALYZE',
  isBundle: boolean = false,
  linkCode?: string
): Promise<FileAnalysisResult | { bundleResults: FileAnalysisResult[] }> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const ext = originalFilename.split('.').pop()?.toLowerCase() || '';
  const isAnalyzeOnly = mode === 'ANALYZE_ONLY';
  
  // Use Gemini 3 Pro for complex email parsing (.eml, .msg) to ensure header accuracy
  // Use Gemini 3 Flash for standard documents (pdf, docx, etc.) for speed and efficiency
  const isEmail = ext === 'eml' || ext === 'msg';
  const modelName = isEmail ? "gemini-3-pro-preview" : "gemini-3-flash-preview";

  try {
    let finalParts: any[] = [];
    
    if (typeof content === 'object' && 'parts' in content) {
      finalParts = content.parts;
    } else if (typeof content === 'string') {
      finalParts.push({ text: content.substring(0, 30000) });
    } else {
      finalParts.push({ inlineData: { data: content.data, mimeType: content.mimeType } });
    }

    // Determine instructions based on whether it's a linked bundle or a high-speed independent batch
    const linkInstruction = linkCode 
      ? `A shared link code [${linkCode}] MUST be inserted immediately after the protocol category code in the 'newName' for EVERY file. Example: [ZA][${linkCode}] or [KA][${linkCode}].`
      : `Process files independently. NO shared link code required.`;

    const instructions = isBundle 
      ? `THESE ARE MULTIPLE FILES IN A BATCH.
         ${linkInstruction}
         
         DATE EXTRACTION PRIORITY:
         1. Extract the specific date from the content of the document itself (in ddmmyyyy format).
         2. If linked as a bundle and document is an attachment with no internal date, use the date of the primary email.
         3. Fallback: ${fallbackDate}.
         
         Return an object with 'bundleResults', ONE FOR EACH unique file provided in the input parts.
         
         CRITICAL REQUIREMENTS:
         1. 'newName' and 'summary' MUST be distinct and highly specific to the individual file.
         2. Attachments MUST NOT just copy the email name; use their OWN content category.
         3. For emails in a linked bundle, 'newName' MUST include "incl att".`
      : `Apply protocol v4.8 strictly. 
         DATE EXTRACTION PRIORITY: 1. Internal content 2. Fallback: ${fallbackDate}.
         Ensure ddmmyyyy is at the end. Return JSON only.`;

    const mainPromptPart = { 
      text: `TASK: ${isBundle ? 'BATCH PROCESSING' : 'INDIVIDUAL PROCESSING'}
${instructions}
Return JSON strictly matching the schema.`
    };
    
    finalParts.unshift(mainPromptPart);

    const schemaProperties: any = {
      newName: { type: Type.STRING },
      summary: { type: Type.STRING },
      managedPoints: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING },
            isAsset: { type: Type.BOOLEAN },
            isCreditor: { type: Type.BOOLEAN },
            isHighRisk: { type: Type.BOOLEAN }
          },
          required: ["text", "isAsset", "isCreditor", "isHighRisk"]
        }
      },
      referenceNumbers: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            type: { type: Type.STRING },
            value: { type: Type.STRING },
            context: { type: Type.STRING }
          },
          required: ["type", "value", "context"]
        }
      }
    };

    const response = await ai.models.generateContent({
      model: modelName,
      contents: { parts: finalParts },
      config: {
        systemInstruction: FILING_RULES,
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: isBundle ? {
          type: Type.OBJECT,
          properties: {
            bundleResults: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  originalName: { type: Type.STRING },
                  ...schemaProperties
                },
                required: ["originalName", "newName", "summary", "managedPoints", "referenceNumbers"]
              }
            }
          },
          required: ["bundleResults"]
        } : {
          type: Type.OBJECT,
          properties: schemaProperties,
          required: ["newName", "summary", "managedPoints", "referenceNumbers"]
        }
      }
    });

    const result = JSON.parse(response.text || '{}');

    if (isBundle && result.bundleResults) {
      return {
        bundleResults: result.bundleResults.map((res: any) => {
          const fileExt = res.originalName?.split('.').pop() || 'docx';
          let cleanName = (res.newName || res.originalName || "Unnamed").trim().replace(/[:\\/*?"<>|]/g, '');
          if (!cleanName.toLowerCase().endsWith(`.${fileExt.toLowerCase()}`)) {
            cleanName = `${cleanName}.${fileExt}`;
          }
          return { ...res, newName: cleanName };
        })
      };
    }

    let cleanName = (result.newName || originalFilename).trim().replace(/[:\\/*?"<>|]/g, '');
    if (!cleanName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
      cleanName = `${cleanName}.${ext}`;
    }

    return {
      originalName: originalFilename,
      newName: isAnalyzeOnly ? originalFilename : cleanName,
      summary: result.summary || "No summary available.",
      managedPoints: result.managedPoints || [],
      referenceNumbers: result.referenceNumbers || []
    };
  } catch (error: any) {
    console.error("Filing Engine Error:", error);
    throw error;
  }
}

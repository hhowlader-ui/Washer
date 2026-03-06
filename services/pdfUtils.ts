// State to prevent loading the script multiple times
let pdfjsLoaded = false;

/**
 * Dynamically loads the PDF.js library from a CDN so you don't need to use npm install
 */
async function loadPdfJs(): Promise<any> {
  if (pdfjsLoaded) return (window as any).pdfjsLib;
  
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    
    script.onload = () => {
      const pdfjsLib = (window as any).pdfjsLib;
      
      // 🚀 THE FIX: Disable the web worker entirely. 
      // This stops the AI Studio browser from blocking cross-origin background scripts.
      // It forces the PDF engine to run locally, ensuring it never crashes on extraction.
      pdfjsLib.GlobalWorkerOptions.disableWorker = true;
      
      pdfjsLoaded = true;
      resolve(pdfjsLib);
    };
    
    script.onerror = () => {
      console.error("Failed to load PDF.js from CDN");
      reject(new Error("CDN load failed"));
    };
    
    document.head.appendChild(script);
  });
}

/**
 * Extracts text from a PDF file locally to save massive API tokens.
 */
export async function extractPdfText(file: File): Promise<string> {
  try {
    const pdfjsLib = await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    
    // Load the PDF document
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    let fullText = '';
    // Speed Optimization: Limit to the first 30 pages. 
    const maxPages = Math.min(pdf.numPages, 30); 
    
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      
      // Map the text items and join them
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');
        
      fullText += `[PAGE ${i}]\n${pageText}\n\n`;
    }
    
    // Clean up excessive whitespace
    fullText = fullText.replace(/\s+/g, ' ').trim();
    
    // Cap the total text length to roughly 15,000 characters to prevent token exhaustion
    return fullText.substring(0, 15000); 
  } catch (error) {
    console.warn(`Could not extract text from PDF: ${file.name}. Falling back to Vision model.`, error);
    return ""; // Return empty string so the App.tsx fallback logic triggers
  }
}
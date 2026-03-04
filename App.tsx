import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { 
  Upload, Download, Loader2, CheckCircle, Trash2, FileText, 
  AlertCircle, RefreshCw, Info, Check, X, Landmark, ShieldAlert, Hash, ChevronDown, Phone, FileSignature, Globe, Save, FolderOpen, CheckCheck, XOctagon, Archive, Key, Zap, Banknote, FileJson, FileOutput, FileUp, Edit3, Briefcase, Tag, TrendingUp, Settings2, Paperclip, Link, Layers, MousePointer2, Activity, Fingerprint, Database, ClipboardCheck, AlertTriangle, Search, Clock, ListOrdered, Table, Maximize2, Minimize2, Box, FilePlus, QrCode
} from 'lucide-react';
import { FileStatus, RenamedFile, ManagedPoint, ReferenceNumber } from './types';
import { fileToBase64, preprocessEmailText, readPartialText, extractEmlContent, rtfToText, msgToText } from './services/fileUtils';
import { processFile, FileAnalysisResult } from './services/geminiService';
import JSZip from 'jszip';

// Parallel processing configuration for maximum throughput
const CONCURRENT_BATCHES = 5; 
const DEFAULT_BATCH_SIZE = 2; // Small batches + high concurrency = fastest results
const APPROX_COST_PER_FILE = 0.00015;
const TIMEOUT_MS = 90000; 

const App: React.FC = () => {
  const [files, setFiles] = useState<RenamedFile[]>([]);
  const [caseCode, setCaseCode] = useState<string>('');
  const [batchSize, setBatchSize] = useState<number>(DEFAULT_BATCH_SIZE);
  const [batchSizeInput, setBatchSizeInput] = useState<string>(DEFAULT_BATCH_SIZE.toString());
  const [isDraggingRename, setIsDraggingRename] = useState(false);
  const [isDraggingRestore, setIsDraggingRestore] = useState(false);
  const [scanCost, setScanCost] = useState<number>(0);
  const [budgetLimit, setBudgetLimit] = useState<number>(5.00);
  const [isQuotaExceeded, setIsQuotaExceeded] = useState<boolean>(false);
  const [now, setNow] = useState<number>(Date.now());
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonImportRef = useRef<HTMLInputElement>(null);
  const processingTracker = useRef<Set<string>>(new Set());

  useEffect(() => {
    const savedLimit = localStorage.getItem('hw_budget_limit');
    if (savedLimit) setBudgetLimit(parseFloat(savedLimit));

    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.warn(`Fullscreen failed: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  }, []);

  const updateScanCost = useCallback((increment: number) => {
    setScanCost(prev => prev + increment);
  }, []);

  const handleUpdateLimit = (val: string) => {
    const num = parseFloat(val) || 0;
    setBudgetLimit(num);
    localStorage.setItem('hw_budget_limit', num.toString());
  };

  useEffect(() => {
    // Prevent massive re-renders
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const getFormattedTimestamp = useCallback(() => {
    const d = new Date();
    const dateStr = d.toLocaleDateString('en-GB').replace(/\//g, ''); // ddmmyyyy
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', ''); // hhmm
    return `${dateStr}_${timeStr}`;
  }, []);

  const generateUniqueCode = useCallback(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `[{${code}}]`;
  }, []);

  const handleOpenSelectKey = async () => {
    const aistudio = (window as any).aistudio;
    if (aistudio?.openSelectKey) {
      await aistudio.openSelectKey();
      setIsQuotaExceeded(false);
    } else {
      window.open('https://ai.google.dev/gemini-api/docs/billing', '_blank');
    }
  };

  const handleFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    const newFiles: RenamedFile[] = Array.from(fileList).map(file => ({
      id: Math.random().toString(36).substring(7) + Date.now(),
      originalFile: file,
      originalName: file.name,
      newName: file.name,
      status: FileStatus.PENDING,
      mode: 'RENAME_AND_ANALYZE',
      selected: false
    }));
    setFiles(prev => [...prev, ...newFiles]);
  }, []);

  const retryFile = (id: string) => {
    processingTracker.current.delete(id);
    setFiles(prev => prev.map(f => f.id === id ? { ...f, status: FileStatus.PENDING, startTime: undefined } : f));
  };

  const downloadFile = useCallback((file: File | null, name: string) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const importJsonFile = useCallback((file: File) => {
    const filenameMatch = file.name.match(/HW_Intelligence_([^_]+)_/i);
    if (filenameMatch && filenameMatch[1] && filenameMatch[1].toUpperCase() !== 'UNASSIGNED') {
      setCaseCode(prev => prev || filenameMatch[1].toUpperCase());
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        const filesToLoad = Array.isArray(data) ? data : (data.files || []);
        if (!Array.isArray(data) && data.caseCode) {
          setCaseCode(prev => prev || data.caseCode);
        }

        if (filesToLoad.length > 0) {
          setFiles(prev => [...prev, ...filesToLoad.map((f: any) => ({
            ...f,
            id: f.id || Math.random().toString(36).substring(7) + Date.now(),
            originalFile: null,
            status: f.status || FileStatus.COMPLETED,
            selected: false
          }))]);
        }
      } catch (err) {
        console.error("Failed to import JSON session", err);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleImportJson = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importJsonFile(file);
    e.target.value = '';
  }, [importJsonFile]);

  const toggleSelectFile = (id: string) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, selected: !f.selected } : f));
  };

  const selectedCount = useMemo(() => files.filter(f => f.selected).length, [files]);

  const handleFastLink = useCallback(() => {
    const selected = files.filter(f => f.selected);
    if (selected.length < 2) return;
    const linkCode = Math.floor(10000 + Math.random() * 90000).toString();
    const bundleId = `bundle-${Date.now()}`;
    setFiles(prev => prev.map(f => {
      if (!f.selected) return f;
      let updatedName = f.newName;
      const match = updatedName.match(/\[[A-Z0-9]{2,}\]/);
      if (match && match.index !== undefined) {
        const insertPos = match.index + match[0].length;
        updatedName = updatedName.slice(0, insertPos) + `[${linkCode}]` + updatedName.slice(insertPos);
      } else {
        updatedName = `[${linkCode}] ${updatedName}`;
      }
      return { ...f, newName: updatedName, bundleId, selected: false };
    }));
  }, [files]);

  const processBatch = useCallback(async (batchFiles: RenamedFile[]) => {
    if (batchFiles.length === 0 || isQuotaExceeded) return;
    const ids = batchFiles.map(f => f.id);
    const startTime = Date.now();
    setFiles(prev => prev.map(f => ids.includes(f.id) ? { ...f, status: FileStatus.PROCESSING, startTime } : f));

    try {
      const partsNested = await Promise.all(batchFiles.map(async (f) => {
        if (!f.originalFile) return [];
        const name = f.originalName;
        const lowName = name.toLowerCase();
        const subParts = [];
        
        if (lowName.endsWith('.eml')) {
          const { text, attachments } = await extractEmlContent(await readPartialText(f.originalFile));
          subParts.push({ text: `DOCUMENT (Email): ${name}\nBODY: ${text}` });
          attachments.forEach(a => subParts.push({ inlineData: { data: a.data, mimeType: a.mimeType } }));
        } 
        else if (lowName.endsWith('.rtf')) {
          const rtfRaw = await readPartialText(f.originalFile);
          const rtfClean = rtfToText(rtfRaw);
          subParts.push({ text: `DOCUMENT (RTF Pre-processed): ${name}\nCONTENT: ${rtfClean}` });
        }
        else if (lowName.endsWith('.msg')) {
          const msgText = await msgToText(f.originalFile);
          subParts.push({ text: `DOCUMENT (Outlook MSG Pre-processed Strings): ${name}\nEXTRACTED DATA: ${msgText}` });
        }
        else if (f.originalFile.type === 'application/pdf' || lowName.endsWith('.pdf') || f.originalFile.type.startsWith('image/')) {
          subParts.push({ text: `DOCUMENT (Binary): ${name}` });
          // SPEED FIX: Prevent massive files from freezing the UI/API. Cap binary payload to first 4MB.
          const maxBinarySize = 4 * 1024 * 1024; // 4MB
          const fileToEncode = f.originalFile.size > maxBinarySize 
            ? new File([f.originalFile.slice(0, maxBinarySize)], f.originalFile.name, { type: f.originalFile.type })
            : f.originalFile;
            
          subParts.push({ inlineData: { data: await fileToBase64(fileToEncode), mimeType: f.originalFile.type || 'application/pdf' } });
        } else {
          subParts.push({ text: `DOCUMENT (Text): ${name}\nCONTENT: ${await readPartialText(f.originalFile)}` });
        }
        return subParts;
      }));

      const finalParts = partsNested.flat();
      const uploadDateStr = new Intl.DateTimeFormat('en-GB').format(new Date()).replace(/\//g, '');
      
      const response = await processFile({ parts: finalParts }, batchFiles[0].originalName, uploadDateStr, 'RENAME_AND_ANALYZE', true);
      const result = response as { bundleResults: FileAnalysisResult[] };
      updateScanCost(APPROX_COST_PER_FILE * batchFiles.length);

      setFiles(prev => prev.map(f => {
        if (!ids.includes(f.id)) return f;
        const fileResult = result.bundleResults.find(r => r.originalName === f.originalName);
        if (!fileResult) return { ...f, status: FileStatus.ERROR, error: "Batch mismatch" };
        const prefix = fileResult.newName.split(' - ')[0];
        const categories: Record<string, string> = {
          Communication: "Communication", Emp: "Employees & Payroll", Engage: "Engagement", 
          Statutory: "Statutory", Financials: "Company Financials", Tax: "Tax & HMRC", 
          Assets: "Assets & Debts", Creditors: "Creditors", Investigate: "Investigation",
          Bank: "Banking", Legal: "Legal"
        };
        return {
          ...f,
          ...fileResult,
          status: FileStatus.COMPLETED,
          category: categories[prefix] || "Miscellaneous",
          managedPoints: fileResult.managedPoints.map(p => ({ ...p, status: 'pending' as const })),
          uniqueCode: generateUniqueCode()
        };
      }));
    } catch (error: any) {
      if (error.message?.includes('429')) setIsQuotaExceeded(true);
      setFiles(prev => prev.map(f => ids.includes(f.id) ? { ...f, status: FileStatus.ERROR, error: error.message } : f));
    } finally {
      ids.forEach(id => processingTracker.current.delete(id));
    }
  }, [updateScanCost, isQuotaExceeded, generateUniqueCode]);

  useEffect(() => {
    const processQueue = () => {
      if (isQuotaExceeded || batchSize <= 0) return;
      const currentlyProcessing = processingTracker.current.size;
      const activeBatchCount = Math.ceil(currentlyProcessing / batchSize);
      if (activeBatchCount >= CONCURRENT_BATCHES) return;
      const pending = files.filter(f => f.status === FileStatus.PENDING && !processingTracker.current.has(f.id));
      if (pending.length === 0) return;
      const nextBatch = pending.slice(0, batchSize);
      nextBatch.forEach(f => processingTracker.current.add(f.id));
      processBatch(nextBatch);
    };
    // SPEED FIX: Changed polling from 100ms to 1000ms. Reduces CPU usage.
    const timer = setInterval(processQueue, 1000); 
    return () => clearInterval(timer);
  }, [files, processBatch, isQuotaExceeded, batchSize]);

  const stats = useMemo(() => ({
    total: files.length,
    completed: files.filter(f => f.status === FileStatus.COMPLETED).length,
    progress: files.length ? (files.filter(f => f.status === FileStatus.COMPLETED).length / files.length) * 100 : 0
  }), [files]);

  const groupedFiles = useMemo(() => {
    const groups: Record<string, RenamedFile[]> = {};
    files.forEach(file => {
      const category = file.category || 'Miscellaneous';
      if (!groups[category]) groups[category] = [];
      groups[category].push(file);
    });
    return groups;
  }, [files]);

  const intelligenceAggregates = useMemo(() => {
    const references: Record<string, Set<string>> = {};
    const criticalPoints: ManagedPoint[] = [];
    files.forEach(f => {
      if (f.status === FileStatus.COMPLETED) {
        f.referenceNumbers?.forEach(ref => {
          if (!references[ref.type]) references[ref.type] = new Set();
          references[ref.type].add(ref.value);
        });
        f.managedPoints?.forEach(p => {
          if (p.isAsset || p.isHighRisk) criticalPoints.push(p);
        });
      }
    });
    return { references, criticalPoints };
  }, [files]);

  const getReportContent = useCallback(() => {
    const categories = (Object.entries(groupedFiles) as [string, RenamedFile[]][]).sort();
    let htmlContent = `
      <html><head><style>
          body { font-family: 'Segoe UI', sans-serif; line-height: 1.6; color: #1e293b; }
          .header { border-bottom: 3px solid #0ea5e9; padding-bottom: 12px; margin-bottom: 24px; }
          .title { font-size: 22pt; font-weight: 800; color: #0f172a; }
          h2 { color: #0284c7; border-left: 6px solid #0ea5e9; padding-left: 12px; margin-top: 32px; font-weight: 700; }
          h3 { color: #1e293b; margin-top: 24px; margin-bottom: 8px; font-weight: 700; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; border: 1px solid #e2e8f0; margin-bottom: 24px; }
          th { background: #f1f5f9; text-align: left; padding: 14px; border: 1px solid #e2e8f0; font-size: 11pt; color: #475569; font-weight: 700; }
          td { padding: 14px; border: 1px solid #e2e8f0; vertical-align: top; font-size: 10.5pt; }
          .risk { color: #b91c1c; font-weight: bold; }
          .asset { color: #047857; font-weight: bold; }
          .code { font-family: 'Consolas', monospace; font-size: 9pt; color: #555; background: #eee; padding: 2px 4px; border-radius: 4px; }
      </style></head><body>
        <div class="header">
          <div class="title">Intelligence Protocol: Hudson Weir Terminal</div>
          <p><strong>Case Reference:</strong> ${caseCode || 'UNASSIGNED'} | <strong>Generated:</strong> ${new Date().toLocaleString('en-GB')}</p>
        </div>
        ${Object.entries(intelligenceAggregates.references).length > 0 ? `
        <h3>Global Extracted Identifiers</h3>
        <table>
          <thead><tr><th style="width: 30%">Signal Type</th><th>Observed Entities</th></tr></thead>
          <tbody>${Object.entries(intelligenceAggregates.references).map(([type, vals]) => `<tr><td><strong>${type}</strong></td><td>${Array.from(vals as Set<string>).join(', ')}</td></tr>`).join('')}</tbody>
        </table>` : ''}
        ${intelligenceAggregates.criticalPoints.length > 0 ? `
        <h3>Critical Risk & Strategic Asset Vectors</h3>
        <table>
          <thead><tr><th style="width: 30%">Vector Type</th><th>Intelligence Detail</th></tr></thead>
          <tbody>${intelligenceAggregates.criticalPoints.map(p => `
            <tr>
              <td><span class="${p.isHighRisk ? 'risk' : 'asset'}">${p.isHighRisk ? 'CRITICAL RISK' : 'STRATEGIC ASSET'}</span></td>
              <td>${p.text}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : ''}
    `;
    categories.forEach(([category, catFiles]) => {
      htmlContent += `<h2>${category} [${catFiles.length}]</h2><table>
        <thead><tr>
          <th style="width: 25%">Protocol Filename</th>
          <th style="width: 35%">Executive Summary</th>
          <th style="width: 30%">Key Intel Findings</th>
          <th style="width: 10%">Unique ID</th>
        </tr></thead>
        <tbody>`;
      catFiles.forEach(file => {
        const points = (file.managedPoints || []).map(p => `<li>${p.text}</li>`).join('');
        htmlContent += `<tr>
          <td><strong>${file.newName}</strong></td>
          <td>${file.summary || 'Summary pending analysis.'}</td>
          <td><ul>${points || 'No specific signals extracted.'}</ul></td>
          <td><span class="code">${file.uniqueCode || '-'}</span></td>
        </tr>`;
      });
      htmlContent += `</tbody></table><br/>`;
    });
    return htmlContent + '</body></html>';
  }, [groupedFiles, caseCode, intelligenceAggregates]);

  const getMappingCsvContent = useCallback(() => {
    const completedFiles = files.filter(f => f.status === FileStatus.COMPLETED);
    const headers = ['Original Filename', 'New Protocol Filename', 'Unique Identifier'];
    const rows = completedFiles.map(f => [`"${f.originalName}"`, `"${f.newName}"`, `"${f.uniqueCode || ''}"`]);
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }, [files]);

 const downloadReport = useCallback(() => {
    if (files.length === 0) return;
    const blob = new Blob(['\ufeff', getReportContent()], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `HW_Report_${caseCode || 'UNASSIGNED'}_${getFormattedTimestamp()}.doc`;
    link.click();
    URL.revokeObjectURL(url); // Cleans up memory
  }, [files, caseCode, getReportContent, getFormattedTimestamp]);

  const downloadCsv = useCallback(() => {
    if (files.length === 0) return;
    const blob = new Blob([getMappingCsvContent()], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `HW_Mapping_${caseCode || 'UNASSIGNED'}_${getFormattedTimestamp()}.csv`;
    link.click();
    URL.revokeObjectURL(url); // Cleans up memory
  }, [files, caseCode, getMappingCsvContent, getFormattedTimestamp]);

  const downloadJson = useCallback(() => {
    if (files.length === 0) return;
    const exportData = {
      caseCode: caseCode || 'UNASSIGNED',
      timestamp: Date.now(),
      files: files.map(({ originalFile, ...rest }) => rest)
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `HW_Intelligence_${caseCode || 'UNASSIGNED'}_${getFormattedTimestamp()}.json`;
    link.click();
    URL.revokeObjectURL(url); // Cleans up memory
  }, [files, caseCode, getFormattedTimestamp]);

  const downloadMasterPackage = useCallback(async () => {
    const completed = files.filter(f => f.status === FileStatus.COMPLETED);
    if (completed.length === 0) return;
    const zip = new JSZip();
    const timestamp = getFormattedTimestamp();
   
    const safeCaseCode = caseCode || 'UNASSIGNED';

    completed.forEach(f => { if (f.originalFile) zip.file(`Documents/${f.newName}`, f.originalFile); });
    
    // Use consistent naming inside the zip
    zip.file(`Intelligence/HW_Mapping_${safeCaseCode}_${timestamp}.csv`, getMappingCsvContent());
    zip.file(`Intelligence/HW_Report_${safeCaseCode}_${timestamp}.doc`, `\ufeff${getReportContent()}`);
    
    const exportData = {
      caseCode: safeCaseCode,
      timestamp: Date.now(),
      files: files.map(({ originalFile, ...rest }) => rest)
    };
    zip.file(`Intelligence/HW_Intelligence_${safeCaseCode}_${timestamp}.json`, JSON.stringify(exportData, null, 2));
    
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const link = document.createElement('a');
    link.href = url;
    link.download = `HW_Master_Package_${safeCaseCode}_${timestamp}.zip`;
    link.click();
    URL.revokeObjectURL(url); // Cleans up the ZIP memory
  }, [files, caseCode, getMappingCsvContent, getReportContent, getFormattedTimestamp]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-800 antialiased overflow-x-hidden">
      <header className="bg-white border-b-2 border-slate-200 px-10 py-5 flex items-center justify-between sticky top-0 z-50 shadow-md">
        <div className="flex items-center space-x-10">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-sky-500 rounded-2xl flex items-center justify-center shadow-lg shadow-sky-500/30">
              <Landmark className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-900 tracking-tighter leading-none">HUDSON WEIR</h1>
              <span className="text-xs text-indigo-600 font-extrabold uppercase tracking-widest mt-1 block">Intelligence Terminal</span>
            </div>
          </div>
          <div className="flex gap-6">
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Case Code</span>
              <input 
                type="text" 
                placeholder="AAAA000" 
                value={caseCode} 
                onChange={(e) => setCaseCode(e.target.value.toUpperCase())} 
                className="bg-slate-100 border-none rounded-xl px-4 py-2 text-sm font-bold w-44 focus:ring-2 focus:ring-sky-400 ring-offset-2 uppercase transition-all" 
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Batch Logic</span>
              <div className="flex items-center bg-slate-100 rounded-xl px-2">
                <ListOrdered className="w-4 h-4 text-sky-500 ml-2" />
                <input 
                  type="number" 
                  value={batchSizeInput} 
                  onChange={(e) => {
                    setBatchSizeInput(e.target.value);
                    const num = parseInt(e.target.value);
                    if (!isNaN(num)) setBatchSize(num);
                  }} 
                  className="bg-transparent border-none py-2 text-sm font-bold w-16 text-center focus:ring-0" 
                />
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-5">
          {files.length > 0 && (
            <div className="flex items-center gap-3 pr-5 border-r-2 border-slate-200">
               <button 
                  onClick={() => fileInputRef.current?.click()} 
                  className="p-3 bg-white border-2 border-slate-100 rounded-2xl text-sky-600 hover:border-sky-400 shadow-sm transition-all flex items-center gap-2 font-bold text-[10px] uppercase tracking-wider"
                  title="Add More Documents"
               >
                 <FilePlus className="w-5 h-5" /> ADD DOCS
               </button>
               <button 
                  onClick={() => jsonImportRef.current?.click()} 
                  className="p-3 bg-white border-2 border-slate-100 rounded-2xl text-indigo-600 hover:border-indigo-400 shadow-sm transition-all flex items-center gap-2 font-bold text-[10px] uppercase tracking-wider"
                  title="Import Session Data"
               >
                 <FolderOpen className="w-5 h-5" /> MERGE DATA
               </button>
            </div>
          )}
          <div className="bg-white border-2 border-indigo-100 px-5 py-2.5 rounded-2xl flex gap-8 items-center shadow-sm">
            <div className="flex flex-col items-end leading-none">
              <span className="text-[9px] font-bold text-indigo-500 uppercase mb-1">Operational Cost</span>
              <span className="text-lg font-black text-slate-900">£{scanCost.toFixed(3)}</span>
            </div>
            <div className="w-px h-8 bg-indigo-100" />
            <div className="flex flex-col items-end leading-none">
              <span className="text-[9px] font-bold text-indigo-500 uppercase mb-1">Budget Safety</span>
              <input 
                type="text" 
                value={budgetLimit} 
                onChange={(e) => handleUpdateLimit(e.target.value)} 
                className="bg-transparent text-lg font-black text-slate-900 w-14 text-right border-b-2 border-indigo-200 focus:outline-none focus:border-indigo-500 transition-colors" 
              />
            </div>
          </div>
          <button onClick={toggleFullscreen} className="p-3 rounded-2xl bg-white border-2 border-slate-100 text-slate-500 hover:bg-slate-50 hover:text-sky-500 transition-all shadow-sm">
            {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
          </button>
          <button onClick={handleOpenSelectKey} className="flex items-center gap-2.5 px-5 py-3 rounded-2xl bg-white border-2 border-slate-100 text-slate-700 font-bold text-xs hover:border-sky-300 transition-all shadow-sm group">
            <Key className="w-5 h-5 text-indigo-500 group-hover:rotate-12 transition-transform" /> Key Manager
          </button>
          {files.length > 0 && (
            <div className="flex items-center gap-3 border-l-2 pl-5 border-slate-200">
              <div className="flex gap-2">
                <button onClick={downloadJson} title="Export JSON" className="p-3 bg-white border-2 border-slate-100 rounded-2xl text-slate-600 hover:border-sky-400 hover:text-sky-600 shadow-sm transition-all"><FileJson className="w-5 h-5" /></button>
                <button onClick={downloadCsv} title="Export CSV Mapping" className="p-3 bg-white border-2 border-slate-100 rounded-2xl text-slate-600 hover:border-sky-400 hover:text-sky-600 shadow-sm transition-all"><Table className="w-5 h-5" /></button>
                <button onClick={downloadReport} title="Export Intelligence Report" className="p-3 bg-white border-2 border-slate-100 rounded-2xl text-slate-600 hover:border-sky-400 hover:text-sky-600 shadow-sm transition-all"><FileOutput className="w-5 h-5" /></button>
              </div>
              <button 
                onClick={downloadMasterPackage} 
                className="bg-indigo-600 text-white hover:bg-indigo-700 px-8 py-3.5 rounded-2xl font-black text-xs flex items-center gap-3 shadow-xl shadow-indigo-600/20 transition-all active:scale-95"
              >
                <Box className="w-5 h-5" /> DOWNLOAD MASTER PACKAGE
              </button>
              <button 
                onClick={() => { setFiles([]); setCaseCode(''); setScanCost(0); processingTracker.current.clear(); }} 
                className="p-3.5 text-slate-400 hover:text-red-600 bg-white border-2 border-slate-100 rounded-2xl transition-all shadow-sm hover:border-red-200"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 p-10 space-y-16 max-w-[2000px] mx-auto w-full font-sans">
        {files.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[65vh] text-center">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10 w-full max-w-5xl">
              <button 
                onClick={() => fileInputRef.current?.click()} 
                onDragOver={(e) => { e.preventDefault(); setIsDraggingRename(true); }}
                onDragLeave={() => setIsDraggingRename(false)}
                onDrop={(e) => { e.preventDefault(); setIsDraggingRename(false); handleFiles(e.dataTransfer.files); }}
                className={`group border-3 border-dashed rounded-[3rem] p-20 flex flex-col items-center justify-center bg-white transition-all duration-300 ${isDraggingRename ? 'border-sky-500 bg-sky-50 shadow-2xl scale-[1.02]' : 'border-slate-200 shadow-xl hover:border-sky-400'}`}
              >
                <div className="w-24 h-24 bg-sky-500 rounded-[2rem] flex items-center justify-center shadow-2xl mb-8 group-hover:scale-110 group-hover:rotate-3 transition-all duration-300 shadow-sky-500/40">
                  <Upload className="w-12 h-12 text-white" />
                </div>
                <h3 className="text-3xl font-black text-slate-900 tracking-tight">Scope Documents</h3>
                <p className="text-slate-500 text-sm mt-4 max-w-[300px] font-medium">Initiate sequential protocol analysis and automated renaming engine.</p>
              </button>

              <button 
                onClick={() => jsonImportRef.current?.click()} 
                onDragOver={(e) => { e.preventDefault(); setIsDraggingRestore(true); }}
                onDragLeave={() => setIsDraggingRestore(false)}
                onDrop={(e) => { 
                  e.preventDefault();
                  setIsDraggingRestore(false); 
                  const file = e.dataTransfer.files[0];
                  if (file && file.name.toLowerCase().endsWith('.json')) {
                    importJsonFile(file);
                  }
                }}
                className={`group border-3 border-dashed rounded-[3rem] p-20 flex flex-col items-center justify-center bg-white transition-all duration-300 ${isDraggingRestore ? 'border-indigo-500 bg-indigo-50 shadow-2xl scale-[1.02]' : 'border-slate-200 shadow-xl hover:border-indigo-400'}`}
              >
                <div className="w-24 h-24 bg-indigo-50 rounded-[2rem] flex items-center justify-center shadow-lg mb-8 group-hover:scale-110 group-hover:-rotate-3 transition-all duration-300">
                  <FileUp className="w-12 h-12 text-indigo-600" />
                </div>
                <h3 className="text-3xl font-black text-slate-900 tracking-tight">Restore Session</h3>
                <p className="text-slate-500 text-sm mt-4 max-w-[300px] font-medium">Import intelligence data to synchronize session state and audit results.</p>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-16 animate-in fade-in slide-in-from-bottom-5 duration-700">
            {(Object.entries(groupedFiles) as [string, RenamedFile[]][]).sort().map(([category, catFiles]) => (
              <section key={category} className="bg-white rounded-[3rem] shadow-xl border-2 border-slate-100 overflow-hidden">
                <header className="px-10 py-6 flex items-center justify-between border-b-2 border-slate-50 bg-slate-50/70 backdrop-blur-md">
                  <div className="flex items-center gap-5">
                    <div className="w-2 h-8 bg-sky-500 rounded-full" />
                    <h2 className="text-xl font-black text-slate-900 tracking-tight">{category}</h2>
                    <span className="text-xs font-black text-sky-700 bg-sky-100 px-4 py-1.5 rounded-full shadow-sm">{catFiles.length} SCOPED DOCUMENTS</span>
                  </div>
                </header>
                <div className="overflow-x-auto">
                  <table className="w-full text-left table-fixed min-w-[1200px]">
                    <thead className="bg-slate-50/50 border-b-2 border-slate-100">
                      <tr>
                        <th className="px-10 py-5 w-[80px]"></th>
                        <th className="px-4 py-5 text-[11px] font-black text-slate-400 uppercase tracking-widest w-[13.5%]">Source Metadata</th>
                        <th className="px-6 py-5 text-[11px] font-black text-sky-600 uppercase tracking-widest w-[24%]">Assigned Protocol Name</th>
                        <th className="px-6 py-5 text-[11px] font-black text-indigo-600 uppercase tracking-widest w-[45%]">Executive Summary & Intelligence</th>
                        <th className="px-6 py-5 text-[11px] font-black text-slate-500 uppercase tracking-widest w-[12%]">Unique ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-slate-50">
                      {catFiles.map(file => {
                        const timeoutMultiplier = (file.originalName.toLowerCase().endsWith('.msg') || file.originalName.toLowerCase().endsWith('.rtf')) ? 5 : 1;
                        const currentTimeout = TIMEOUT_MS * timeoutMultiplier;
                        const isStuck = file.status === FileStatus.PROCESSING && file.startTime && (now - file.startTime > currentTimeout);
                        return (
                          <tr key={file.id} className={`hover:bg-sky-50/40 transition-colors duration-200 ${file.selected ? 'bg-sky-50/80 border-l-4 border-l-sky-500' : ''}`}>
                            <td className="px-10 py-7 align-top">
                              <div className="relative flex items-center justify-center">
                                <input 
                                  type="checkbox" 
                                  checked={file.selected} 
                                  onChange={() => toggleSelectFile(file.id)} 
                                  className="w-6 h-6 rounded-lg border-2 border-slate-300 text-sky-500 focus:ring-sky-400 cursor-pointer transition-all checked:border-sky-500 shadow-sm" 
                                />
                              </div>
                            </td>
                            <td className="px-4 py-7 align-top">
                              <div className="flex flex-col">
                                <span className="text-[11px] font-medium text-slate-700 leading-tight mb-2 break-all font-sans" title={file.originalName}>{file.originalName}</span>
                                {file.bundleId && <div className="inline-flex items-center gap-1.5 text-[8px] font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-lg border border-indigo-100 w-fit"><Link className="w-3 h-3"/> CONTEXT LINKED</div>}
                              </div>
                            </td>
                            <td className="px-6 py-7 align-top">
                              {file.status === FileStatus.PROCESSING ? (
                                <div className="flex flex-col gap-3">
                                  <div className="flex items-center gap-4 text-sky-600 font-medium text-sm animate-pulse bg-sky-50/80 p-5 rounded-[1.5rem] border-2 border-sky-100 shadow-inner">
                                    <Loader2 className="w-6 h-6 animate-spin" /> RUNNING OCR & ANALYSIS...
                                  </div>
                                  {isStuck && (
                                    <button onClick={() => retryFile(file.id)} className="text-[10px] font-bold text-red-600 uppercase flex items-center gap-2 px-5 py-2 bg-red-50 rounded-xl border border-red-100 hover:bg-red-100 transition-colors w-fit shadow-sm">
                                      <RefreshCw className="w-3.5 h-3.5" /> TASK STUCK - MANUAL RETRY
                                    </button>
                                  )}
                                </div>
                              ) : file.status === FileStatus.COMPLETED ? (
                                <div className="space-y-4">
                                  <div className="text-[10px] font
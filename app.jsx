const { useState, useRef, useCallback, useEffect } = React;


// ==================== INDEXEDDB STORAGE ====================
const DB_NAME = 'MyHealthPlusDB';
const DB_VERSION = 1;
let _db = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('store')) {
        db.createObjectStore('store');
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('store', 'readonly');
    const req = tx.objectStore('store').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('store', 'readwrite');
    tx.objectStore('store').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}
async function extractTextFromPDF(file) {
  const pdfjsLib = await loadPDFJS();
  const arrayBuffer = await readAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ");
    fullText += `\n--- PAGE ${i} OF ${pdf.numPages} ---\n` + pageText + "\n";
  }
  return fullText;
}
let pdfjsLoaded = null;
function loadPDFJS() {
  if (pdfjsLoaded) return pdfjsLoaded;
  pdfjsLoaded = new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    
    const timer = setTimeout(() => { reject(new Error("PDF.js load timeout")); }, 10000);
    script.onload = () => {
      clearTimeout(timer);
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      } catch(e) { reject(e); }
    };
    script.onerror = () => { clearTimeout(timer); reject(new Error("PDF.js failed to load")); };
    document.head.appendChild(script);
  });
  return pdfjsLoaded;
}
async function extractTextFromDocx(file) {
  const arrayBuffer = await readAsArrayBuffer(file);
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function detectFileType(file) {
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  const ext = name.split(".").pop();
  if (mime.includes("pdf") || ext === "pdf") return "pdf";
  if (mime.startsWith("image/") || ["jpg","jpeg","png","webp","heic","gif","bmp","heif","tiff","tif"].includes(ext)) return "image";
  if (mime.includes("word") || mime.includes("document") || ["doc","docx"].includes(ext)) return "docx";
  
  if (mime.includes("jpeg") || mime.includes("png") || mime.includes("heic") || mime.includes("heif")) return "image";
  return "unknown";
}
async function parseWithAI(content, isImage = false, imageBase64 = null, mimeType = null) {
  const instructions = `Extract patient info and test results from a medical/lab report. Respond ONLY with valid JSON — no markdown, no backticks, no explanation.
Schema:
{"patient":{"name":"","age":"","sex":"","phone":"","address":"","dateOfBirth":"","referredBy":""},"lab":{"name":"","date":""},"testGroups":[{"group":"Group Name","tests":[{"name":"Test Name","value":"number","unit":"unit","range":"ref range","status":"normal|high|low"}]}]}
Rules:
- Extract name, age, sex, phone, address from patient info area
- age: extract number from "45/M", "32 Yrs", "Age: 45 Years", or calculate from DOB
- sex: extract from "Sex", "Gender", or combined fields like "45/M" = Male
- phone: any 10-digit number near patient details
- Process EVERY page, extract EVERY test result
- Group tests by their panel headers (CBC, Lipid Profile, LFT, etc.)
- status: "high" if above range, "low" if below, "normal" if within
- Keep values concise — numbers only, no extra text
- Output ONLY the JSON object`;
  const userText = "Extract ALL patient info and ALL test results. Return ONLY valid JSON.";
  const messages = [];
  if (isImage && imageBase64) {
    const isPdf = mimeType && mimeType.includes("pdf");
    const contentBlocks = [];
    if (isPdf) {
      contentBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } });
    } else {
      contentBlocks.push({ type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 } });
    }
    contentBlocks.push({ type: "text", text: instructions + "\n\n" + userText });
    messages.push({ role: "user", content: contentBlocks });
  } else {
    
    const truncated = content && content.length > 80000 ? content.slice(0, 80000) + "\n...[TRUNCATED]" : content;
    messages.push({
      role: "user",
      content: instructions + "\n\n" + userText + "\n\n---REPORT TEXT---\n" + truncated + "\n---END---"
    });
  }
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        system: "You are a lab report data extractor. Output ONLY compact valid JSON. No prose, no markdown, no explanations. Be concise — short string values only.",
        messages
      })
    });
  } catch (fetchErr) {
    throw new Error("Network request failed: " + (fetchErr.message || "Could not connect to AI service"));
  }
  let data;
  try {
    data = await response.json();
  } catch (jsonErr) {
    throw new Error("API response not readable (status " + response.status + ")");
  }
  if (!response.ok) throw new Error(data.error?.message || `API error: ${response.status}`);
  if (data.error) throw new Error(data.error.message || "API error");
  const text = data.content?.map(b => b.text || "").join("") || "";
  const stopReason = data.stop_reason || "";
  if (stopReason === "max_tokens") {
    console.warn("AI response was truncated (hit max_tokens). Some tests may be missing.");
  }
  let cleaned = text.replace(/```json|```/g, "").trim();
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON found in AI response");
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  
  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    
    let fixed = cleaned;
    let openBraces = (fixed.match(/{/g) || []).length;
    let closeBraces = (fixed.match(/}/g) || []).length;
    let openBrackets = (fixed.match(/\[/g) || []).length;
    let closeBrackets = (fixed.match(/\]/g) || []).length;
    const lastComplete = Math.max(
      fixed.lastIndexOf("},"),
      fixed.lastIndexOf("}]"),
      fixed.lastIndexOf("\"}"),
    );
    if (lastComplete > fixed.length * 0.5) {
      fixed = fixed.slice(0, lastComplete + 1);
    }
    fixed = fixed.replace(/,\s*"[^"]*"?\s*:?\s*("?[^"{}[\]]*)?$/g, "");
    fixed = fixed.replace(/,\s*{[^}]*$/g, "");
    fixed = fixed.replace(/,\s*$/g, "");
    openBraces = (fixed.match(/{/g) || []).length;
    closeBraces = (fixed.match(/}/g) || []).length;
    openBrackets = (fixed.match(/\[/g) || []).length;
    closeBrackets = (fixed.match(/\]/g) || []).length;
    
    for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += "]";
    for (let i = 0; i < openBraces - closeBraces; i++) fixed += "}";
    fixed = fixed.replace(/,\s*([}\]])/g, "$1");
    
    try {
      return JSON.parse(fixed);
    } catch (e) {
      
      const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
      const ageMatch = text.match(/"age"\s*:\s*"?(\d+)"?/);
      const sexMatch = text.match(/"sex"\s*:\s*"([^"]+)"/);
      return {
        patient: {
          name: nameMatch?.[1] || "",
          age: ageMatch?.[1] || "",
          sex: sexMatch?.[1] || "",
          phone: "", address: "",
        },
        lab: { name: "", date: "" },
        tests: [],
        testGroups: []
      };
    }
  }
}
async function detectReportType(content, isImage, imageBase64, mimeType) {
  const imagingKeywords = /\b(mri|ct scan|computed tomography|magnetic resonance|ultrasound|x-ray|xray|radiograph|mammograph|pet scan|bone scan|doppler|sonograph|echocardiograph|fluoroscopy|angiograph|scintigraph)\b/i;
  const clinicalKeywords = /(discharge summary|inpatient|outpatient|op note|admission note|clinical note|consultation note|admitted on|date of admission|date of discharge|chief complaint|history of present illness|past medical history|plan of care|follow.up|on examination|provisional diagnosis|final diagnosis|advised to)/i;
  if (!isImage && content) {
    if (clinicalKeywords.test(content)) return "clinical_note";
    if (imagingKeywords.test(content)) return "imaging";
  }
  if (isImage || !content) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 20,
          system: "Respond with exactly one word: imaging, clinical_note, or lab.",
          messages: [{
            role: "user",
            content: isImage && imageBase64 ? [
              mimeType?.includes("pdf")
                ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
                : { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 } },
              { type: "text", text: "Classify this medical document with one word:\n- imaging: radiology report (MRI, CT, X-ray, Ultrasound)\n- clinical_note: discharge summary, OP note, inpatient note, consultation\n- lab: blood/lab test report" }
            ] : [{ type: "text", text: "Classify: imaging, clinical_note, or lab?\n\n" + (content || "").slice(0, 600) }]
          }]
        })
      });
      const d = await resp.json();
      const answer = (d.content?.[0]?.text || "").toLowerCase().trim();
      if (answer.includes("clinical_note") || answer.includes("clinical note")) return "clinical_note";
      if (answer.includes("imaging")) return "imaging";
    } catch(e) {}
  }
  return "lab";
}
async function parseImagingReport(content, isImage, imageBase64, mimeType) {
  const instructions = `You are analyzing a radiology/imaging report (MRI, CT, Ultrasound, X-ray, etc.). Extract patient info and summarize findings. Respond ONLY with valid JSON — no markdown, no backticks.
Schema:
{"patient":{"name":"","age":"","sex":"","phone":"","address":"","dateOfBirth":"","referredBy":""},"lab":{"name":"","date":""},"imaging":{"modality":"MRI|CT|Ultrasound|X-Ray|PET|Other","bodyPart":"e.g. Brain, Abdomen, Chest","clinicalHistory":"","technique":"","normalFindings":["finding1","finding2"],"abnormalFindings":["finding1","finding2"],"impression":"Overall impression from radiologist"}}
Rules:
- modality: the imaging type (MRI, CT Scan, Ultrasound, X-Ray, etc.)
- bodyPart: the body region examined
- normalFindings: list each structure/organ that appears normal — one per item, concise
- abnormalFindings: list each abnormal finding — one per item, include severity/size if mentioned
- impression: copy the radiologist's final impression/conclusion verbatim if present
- Output ONLY the JSON object`;
  const userText = "Extract patient info and summarize all imaging findings. Return ONLY valid JSON.";
  const messages = [];
  if (isImage && imageBase64) {
    const contentBlocks = [
      mimeType?.includes("pdf")
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
        : { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 } },
      { type: "text", text: instructions + "\n\n" + userText }
    ];
    messages.push({ role: "user", content: contentBlocks });
  } else {
    const truncated = content && content.length > 80000 ? content.slice(0, 80000) + "\n...[TRUNCATED]" : content;
    messages.push({ role: "user", content: instructions + "\n\n" + userText + "\n\n---REPORT TEXT---\n" + truncated + "\n---END---" });
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: "You are a radiology report summarizer. Output ONLY compact valid JSON.",
      messages
    })
  });
  if (!response.ok) throw new Error("API error: " + response.status);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.map(b => b.text || "").join("") || "";
  const cleaned = text.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON in imaging response");
  return JSON.parse(cleaned.slice(s, e + 1));
}
async function parseClinicalNote(content, isImage, imageBase64, mimeType) {
  const instructions = `You are analyzing a clinical medical document (outpatient note, inpatient note, or discharge summary). Extract structured data. Respond ONLY with valid JSON — no markdown, no backticks.
Schema:
{
  "patient": {"name":"","age":"","sex":"","phone":"","address":"","dateOfBirth":"","referredBy":"","uhid":""},
  "visit": {
    "visitType": "OP|IP",
    "hospital": "",
    "department": "",
    "doctor": "",
    "admissionDate": "",
    "dischargeDate": "",
    "visitDate": "",
    "chiefComplaint": "",
    "diagnoses": ["Primary diagnosis", "Secondary if any"],
    "procedures": ["Procedure 1"],
    "vitals": {"bp":"","pulse":"","temp":"","spo2":"","weight":"","height":"","rr":""},
    "allergies": [],
    "medications": [{"name":"","dose":"","frequency":"","duration":"","route":""}],
    "followUp": "",
    "summary": "2-3 sentence plain summary of the visit/admission"
  },
  "extractedLabs": [
    {
      "date": "YYYY-MM-DD or empty",
      "labName": "",
      "testGroups": [{"group":"Group Name","tests":[{"name":"","value":"","unit":"","range":"","status":"normal|high|low"}]}]
    }
  ]
}
Rules:
- visitType: IP if there is an admission/discharge, OP if outpatient/consultation
- admissionDate/dischargeDate: for IP stays (DD/MM/YYYY or YYYY-MM-DD)
- visitDate: for OP notes, the date of visit
- diagnoses: extract ALL diagnoses listed, primary first
- medications: extract every medication with dose if mentioned
- extractedLabs: if the note contains any lab results (CBC, LFT, blood sugar etc.), extract them grouped by panel; use the date the test was done if mentioned, otherwise leave empty
- If no labs are present, return extractedLabs as []
- summary: brief plain-English summary of why patient came and what happened
- Output ONLY the JSON object`;
  const userText = "Extract all clinical information and any embedded lab results. Return ONLY valid JSON.";
  const messages = [];
  if (isImage && imageBase64) {
    const contentBlocks = [
      mimeType?.includes("pdf")
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
        : { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 } },
      { type: "text", text: instructions + "\n\n" + userText }
    ];
    messages.push({ role: "user", content: contentBlocks });
  } else {
    const truncated = content && content.length > 80000 ? content.slice(0, 80000) + "\n...[TRUNCATED]" : content;
    messages.push({ role: "user", content: instructions + "\n\n" + userText + "\n\n---DOCUMENT TEXT---\n" + truncated + "\n---END---" });
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: "You are a clinical document parser. Output ONLY compact valid JSON. Be thorough with lab extraction.",
      messages
    })
  });
  if (!response.ok) throw new Error("API error: " + response.status);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.map(b => b.text || "").join("") || "";
  const cleaned = text.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON in clinical note response");
  return JSON.parse(cleaned.slice(s, e + 1));
}
async function getAIAnalysis(tests, patientInfo) {
  const testSummary = tests.map(t => `${t.name}: ${t.value} ${t.unit} (Ref: ${t.range}) [${t.status}]`).join("\n");
  const prompt = `You are a medical report analysis AI. Analyze the lab results and respond ONLY with valid JSON — no markdown, no backticks, no explanation.
Schema:
{
  "summary": "1-2 sentence overall summary of health picture",
  "sections": [
    {
      "title": "Section title (e.g. Key Findings, Abnormal Values, What's Normal, Recommendations)",
      "icon": "one of: findings | warning | check | recommend",
      "points": ["Bullet point 1", "Bullet point 2"]
    }
  ]
}
Rules:
- Always include a "Key Findings" section with 2-4 bullets
- If any tests are abnormal, include an "Abnormal Values" section explaining each one simply
- Include a "What's Normal" section highlighting reassuring results
- Include a "Next Steps" section with 1-3 actionable recommendations
- Keep each bullet point concise (1 sentence max)
- Plain language, no jargon — patient-friendly
- Never diagnose, always frame as informational
Patient: ${patientInfo.name || "Unknown"}, Age: ${patientInfo.age || "Unknown"}, Sex: ${patientInfo.sex || "Unknown"}
Test Results:
${testSummary}
Respond ONLY with the JSON object.`;
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch(e) {
    return null;
  }
  if (!response.ok) return null;
  try {
    const data = await response.json();
    if (data.error) return null;
    const text = data.content?.map(b => b.text || "").join("") || "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch(e) {
    return null;
  }
}
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (parseInt(a) > 12) { [a, b] = [b, a]; }
    return `${y}-${a.padStart(2,"0")}-${b.padStart(2,"0")}`;
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (m) {
    const [, d, mo, y] = m;
    const fullYear = parseInt(y) > 50 ? "19" + y : "20" + y;
    return `${fullYear}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  m = s.match(/(\d{1,2})\s*[\/\-.,]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[\/\-.,]?\s*(\d{4})/i);
  if (m) return `${m[3]}-${months[m[2].toLowerCase().slice(0,3)]}-${m[1].padStart(2,"0")}`;
  m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[\/\-.,]?\s*(\d{1,2})\s*[\/\-.,]?\s*(\d{4})/i);
  if (m) return `${m[3]}-${months[m[1].toLowerCase().slice(0,3)]}-${m[2].padStart(2,"0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  
  return null;
}
function formatTestDate(isoDate) {
  if (!isoDate) return "Date unknown";
  try {
    const d = new Date(isoDate + "T00:00:00");
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch(e) { return isoDate; }
}
const Icon = ({ type, size = 20, color = "currentColor" }) => {
  const s = { width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center" };
  const icons = {
    upload: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>,
    home: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
    users: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>,
    chart: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    file: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
    search: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
    chevron: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>,
    back: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>,
    alert: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    heart: <svg style={s} viewBox="0 0 24 24" fill={color} stroke="none"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>,
    ai: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>,
    trend: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
    close: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
    settings: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
    check: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
    userplus: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>,
    refresh: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>,
    list: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
    grid: <svg style={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
  };
  return icons[type] || null;
};
let _chartIdCounter = 0;
const MiniTrendChart = ({ data, color = "#D97757", height = 60, abnormalFlags }) => {
  const [hovered, setHovered] = useState(null);
  const chartId = useRef(null);
  if (!chartId.current) chartId.current = "mhc" + (++_chartIdCounter);
  if (!data || data.length < 2) return null;
  const values = data.map(d => d.value);
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const w = 280, h = height + 44, pad = 18, topPad = 22, bottomPad = 26;
  const chartH = h - topPad - bottomPad;
  const abnormalColor = "#E53935";
  const normalColor = "#2E7D32";
  const getXY = (i) => ({
    x: pad + (i / (values.length - 1)) * (w - 2 * pad),
    y: topPad + chartH - ((values[i] - min) / range) * (chartH - 6),
  });
  const points = values.map((v, i) => { const p = getXY(i); return p.x + "," + p.y; });
  const ptColors = values.map((v, i) => (abnormalFlags && abnormalFlags[i]) ? abnormalColor : normalColor);
  const segGradients = [];
  for (let i = 0; i < values.length - 1; i++) {
    const id = chartId.current + "_s" + i;
    segGradients.push({ id, c1: ptColors[i], c2: ptColors[i + 1] });
  }
  const latestColor = ptColors[ptColors.length - 1];
  const gid = chartId.current + "_g";
  const shortLabel = (label) => {
    if (!label) return "";
    const parts = label.split(" ");
    return parts.length >= 2 ? parts[0] + " " + parts[1] : label;
  };
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg viewBox={"0 0 " + w + " " + h} style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
        onMouseLeave={() => setHovered(null)}
        onTouchEnd={() => setHovered(null)}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={latestColor} stopOpacity="0.18"/><stop offset="100%" stopColor={latestColor} stopOpacity="0.02"/></linearGradient>
          {segGradients.map((sg, i) => {
            const p1 = getXY(i), p2 = getXY(i + 1);
            return (
              <linearGradient key={sg.id} id={sg.id} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor={sg.c1}/><stop offset="100%" stopColor={sg.c2}/>
              </linearGradient>
            );
          })}
        </defs>
        {/* Fill area */}
        <polygon points={pad + "," + (topPad + chartH) + " " + points.join(" ") + " " + (w - pad) + "," + (topPad + chartH)} fill={"url(#" + gid + ")"}/>
        {/* Line segments with gradient transitions */}
        {segGradients.map((sg, i) => {
          const p1 = getXY(i), p2 = getXY(i + 1);
          return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={"url(#" + sg.id + ")"} strokeWidth="2.5" strokeLinecap="round"/>;
        })}
        {values.map((v, i) => {
          const p = getXY(i);
          const isHov = hovered === i;
          const isAbn = abnormalFlags && abnormalFlags[i];
          const ptColor = isAbn ? abnormalColor : normalColor;
          const label = shortLabel(data[i]?.label);
          const valText = String(data[i]?.value ?? "");
          let anchor = "middle";
          if (i === 0 && values.length > 2) anchor = "start";
          if (i === values.length - 1 && values.length > 2) anchor = "end";
          return (
            <g key={i}>
              {/* Value above point — always visible */}
              <text x={p.x} y={isHov ? p.y - 14 : p.y - 10} textAnchor={anchor}
                fontSize={isHov ? "10" : "8"} fontWeight={isHov ? "800" : "500"}
                fill={isHov ? ptColor : isAbn ? abnormalColor + "70" : "#B8BFC8"}>
                {valText}
              </text>
              {/* Date below chart — always visible */}
              <text x={p.x} y={topPad + chartH + 14} textAnchor={anchor}
                fontSize={isHov ? "8.5" : "7"} fontWeight={isHov ? "700" : "400"}
                fill={isHov ? ptColor : "#B8BFC8"}>
                {label}
              </text>
              {/* Vertical guide on hover */}
              {isHov && <line x1={p.x} y1={topPad - 4} x2={p.x} y2={topPad + chartH + 2} stroke={ptColor} strokeWidth="1" strokeDasharray="3,3" opacity="0.4"/>}
              {/* Outer glow on hover */}
              {isHov && <circle cx={p.x} cy={p.y} r={12} fill={ptColor} opacity="0.12"/>}
              {/* Data point — red if abnormal, green if normal */}
              <circle cx={p.x} cy={p.y} r={isHov ? 6 : 4}
                fill={isHov ? ptColor : isAbn ? abnormalColor : normalColor}
                stroke={isHov ? ptColor : isAbn ? abnormalColor : normalColor} strokeWidth={isHov ? 2.5 : 2}/>
              {/* White inner ring for non-hovered */}
              {!isHov && <circle cx={p.x} cy={p.y} r={2} fill="white"/>}
              {/* Invisible large hit area */}
              <circle cx={p.x} cy={p.y} r={20}
                fill="transparent" stroke="none"
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHovered(i)}
                onTouchStart={(e) => { e.stopPropagation(); setHovered(i); }}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
};
const StatusBadge = ({ status }) => {
  const c = { normal: { bg: "#E8F5E9", color: "#2E7D32", label: "Normal" }, high: { bg: "#FFF3E0", color: "#E65100", label: "High" }, low: { bg: "#E3F2FD", color: "#1565C0", label: "Low" } }[status] || { bg: "#E8F5E9", color: "#2E7D32", label: "Normal" };
  return <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: c.bg, color: c.color }}>{c.label}</span>;
};
function PDFCanvasViewer({ fileData }) {
  const containerRef = useRef(null);
  const [pageImages, setPageImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [totalPages, setTotalPages] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjsLib = await loadPDFJS();
        const base64 = fileData.split(",")[1];
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        setTotalPages(pdf.numPages);
        const images = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const scale = 2;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          await page.render({ canvasContext: ctx, viewport }).promise;
          images.push(canvas.toDataURL("image/png"));
          if (cancelled) return;
        }
        setPageImages(images);
        setLoading(false);
      } catch (e) {
        console.error("PDF render error:", e);
        if (!cancelled) { setError("Could not render PDF: " + (e.message || "")); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [fileData]);
  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 300, gap: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: 24, background: "rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", animation: "pulse 1.5s ease-in-out infinite" }}>
          <Icon type="file" size={24} color="white"/>
        </div>
        <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 14 }}>Rendering PDF{totalPages > 0 ? ` (${totalPages} pages)` : ""}...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 300, gap: 12 }}>
        <Icon type="alert" size={32} color="#FF8C42"/>
        <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, textAlign: "center" }}>{error}</p>
      </div>
    );
  }
  return (
    <div ref={containerRef} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, paddingBottom: 16 }}>
      {/* Page indicator */}
      {pageImages.length > 1 && (
        <div style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(26,33,56,0.9)", backdropFilter: "blur(8px)", padding: "6px 16px", borderRadius: 20, fontSize: 12, color: "rgba(255,255,255,0.8)", fontWeight: 600 }}>
          {pageImages.length} pages — scroll to view all
        </div>
      )}
      {pageImages.map((img, i) => (
        <div key={i} style={{ position: "relative", width: "100%" }}>
          <img src={img} alt={`Page ${i + 1}`} style={{ width: "100%", borderRadius: 6, display: "block", boxShadow: "0 2px 12px rgba(0,0,0,0.3)" }}/>
          {pageImages.length > 1 && (
            <div style={{ position: "absolute", bottom: 8, right: 8, background: "rgba(0,0,0,0.6)", color: "white", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 10 }}>
              Page {i + 1} / {pageImages.length}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
function MyHealthPlus() {
  const [patients, setPatients] = useState([]);
  const [reports, setReports] = useState([]);
  const [activeTab, setActiveTab] = useState("home");
  React.useEffect(() => {
    if (!document.getElementById("logo-font")) {
      const link = document.createElement("link");
      link.id = "logo-font";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800&family=Caveat:wght@400;500;600;700&display=swap";
      document.head.appendChild(link);
    }
  }, []);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);
  const [selectedTest, setSelectedTest] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAnalysis, setShowAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisData, setAnalysisData] = useState(null); 
  const [showReportViewer, setShowReportViewer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState("patients"); 
  const [editingPatient, setEditingPatient] = useState(null);
  const [editingReport, setEditingReport] = useState(null);
  const [editingTests, setEditingTests] = useState([]);
  const fileInputRef = useRef(null);

  // Load persisted data on mount
  useEffect(() => {
    (async () => {
      try {
        const p = await dbGet('patients');
        const r = await dbGet('reports');
        if (p && Array.isArray(p)) setPatients(p);
        if (r && Array.isArray(r)) setReports(r);
      } catch(e) { console.warn('Failed to load from IndexedDB:', e); }
    })();
  }, []);

  // Save patients whenever they change (debounced)
  useEffect(() => {
    const t = setTimeout(() => dbSet('patients', patients).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [patients]);

  // Save reports whenever they change (debounced)
  useEffect(() => {
    const t = setTimeout(() => dbSet('reports', reports).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [reports]);


  const [uploadStep, setUploadStep] = useState("select"); 
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [assignChoice, setAssignChoice] = useState("new");
  const [pendingData, setPendingData] = useState(null); 
  const [uploadFileName, setUploadFileName] = useState("");
  const [pendingFileData, setPendingFileData] = useState(null); 
  const [pendingFileType, setPendingFileType] = useState(""); 
  
  const [fileQueue, setFileQueue] = useState([]); 
  const [queueIndex, setQueueIndex] = useState(0); 
  const [batchMode, setBatchMode] = useState(null); 
  const [singlePatientId, setSinglePatientId] = useState(null); 
  
  const [editName, setEditName] = useState("");
  const [editAge, setEditAge] = useState("");
  const [editSex, setEditSex] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const theme = { bg: "#FFF8F5", primary: "#D97757", accent: "#00C48C", warning: "#E53935", text: "#1A2138", textSecondary: "#6B7A99", border: "#F0E6E0", shadow: "0 2px 12px rgba(80,45,31,0.08)" };
  const normalizeTestName = (name) => {
    if (!name) return "";
    let n = name.trim().toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")  
      .replace(/\s+/g, " ").trim();
    const aliases = [
      [/^h(a?e)?moglobin$|^hgb$|^hb$/, "haemoglobin"],
      [/^r(ed)?\s?b(lood)?\s?c(ells?)?$|^rbc(s)?$|^erythrocytes$/, "rbc"],
      [/^w(hite)?\s?b(lood)?\s?c(ells?)?$|^wbc(s)?$|^leucocytes?$|^leukocytes?$|^tlc$/, "wbc"],
      [/^platelet(s)?(\s?count)?$|^plt$|^thrombocytes?$/, "platelets"],
      [/^haematocrit$|^hematocrit$|^hct$|^pcv$/, "haematocrit"],
      [/^m(ean)?\s?c(orpuscular)?\s?v(olume)?$|^mcv$/, "mcv"],
      [/^m(ean)?\s?c(orpuscular)?\s?h(a?e)?moglobin\s?c(onc(entration)?)?$|^mchc$/, "mchc"],
      [/^m(ean)?\s?c(orpuscular)?\s?h(a?e)?moglobin$|^mch$/, "mch"],
      [/^neutrophil(s)?(\s?%)?$|^neut(s)?$|^pmn$/, "neutrophils"],
      [/^lymphocyte(s)?(\s?%)?$|^lymph(s)?$/, "lymphocytes"],
      [/^monocyte(s)?(\s?%)?$|^mono(s)?$/, "monocytes"],
      [/^eosinophil(s)?(\s?%)?$|^eosin(s)?$/, "eosinophils"],
      [/^basophil(s)?(\s?%)?$|^baso(s)?$/, "basophils"],
      [/^(total\s)?cholesterol$|^chol$/, "cholesterol"],
      [/^(ldl|low\s?density\s?lipoprotein)(\s?cholesterol)?$/, "ldl cholesterol"],
      [/^(hdl|high\s?density\s?lipoprotein)(\s?cholesterol)?$/, "hdl cholesterol"],
      [/^triglyceride(s)?$|^tg$/, "triglycerides"],
      [/^(fasting\s)?blood\s?sugar$|^fbs$|^fasting\s?glucose$|^f\.?b\.?g\.?$/, "fasting blood sugar"],
      [/^(post\s?prandial|pp)\s?(blood\s?)?sugar$|^ppbs$|^pp\s?glucose$/, "postprandial blood sugar"],
      [/^(random\s)?blood\s?sugar$|^rbs$|^blood\s?glucose$/, "blood sugar"],
      [/^hba1c$|^glycated\s?h(a?e)?moglobin$|^glycohaemoglobin$/, "hba1c"],
      [/^creatinine(\s?(serum|blood))?$/, "creatinine"],
      [/^blood\s?urea\s?nitrogen$|^bun$|^urea(\s?nitrogen)?$/, "urea"],
      [/^(serum\s)?uric\s?acid$/, "uric acid"],
      [/^(serum\s)?sodium$|^na\+?$/, "sodium"],
      [/^(serum\s)?potassium$|^k\+?$/, "potassium"],
      [/^(serum\s)?calcium$|^ca\+?$/, "calcium"],
      [/^(serum\s)?chloride$|^cl-?$/, "chloride"],
      [/^(serum\s)?bicarbonate$|^hco3-?$/, "bicarbonate"],
      [/^(total\s)?bilirubin$|^tbil$/, "total bilirubin"],
      [/^direct\s?(bilirubin)?$|^dbil$|^conjugated\s?bilirubin$/, "direct bilirubin"],
      [/^indirect\s?(bilirubin)?$|^unconjugated\s?bilirubin$/, "indirect bilirubin"],
      [/^sgpt$|^alt$|^alanine\s?(aminotransferase|transaminase)$/, "alt sgpt"],
      [/^sgot$|^ast$|^aspartate\s?(aminotransferase|transaminase)$/, "ast sgot"],
      [/^alkaline\s?phosphatase$|^alp$|^alk\s?phos$/, "alkaline phosphatase"],
      [/^(total\s)?protein$/, "total protein"],
      [/^albumin(\s?serum)?$/, "albumin"],
      [/^globulin$/, "globulin"],
      [/^thyroid\s?stimulating\s?hormone$|^tsh$/, "tsh"],
      [/^(free\s)?thyroxine$|^(free\s)?t4$|^ft4$/, "t4"],
      [/^(free\s)?triiodothyronine$|^(free\s)?t3$|^ft3$/, "t3"],
      [/^(serum\s)?iron$|^fe$/, "serum iron"],
      [/^(total\s?iron[\s-]?binding\s?capacity|tibc)$/, "tibc"],
      [/^ferritin(\s?serum)?$/, "ferritin"],
      [/^vitamin\s?b[\s-]?12$|^cobalamin$/, "vitamin b12"],
      [/^vitamin\s?d(\s?(total|25[\s-]?oh))?$|^25[\s-]?hydroxyvitamin\s?d$/, "vitamin d"],
      [/^(c[\s-]?reactive\s?protein|crp)$/, "crp"],
      [/^erythrocyte\s?sedimentation\s?rate$|^esr$/, "esr"],
      [/^egfr$|^(estimated\s?)?glomerular\s?filtration\s?rate$/, "egfr"],
    ];
    for (const [pattern, canonical] of aliases) {
      if (pattern.test(n)) return canonical;
    }
    return n;
  };
  const testNamesMatch = (a, b) => {
    const na = normalizeTestName(a);
    const nb = normalizeTestName(b);
    if (na === nb) return true;
    
    if (na.length > 3 && nb.length > 3 && (na.includes(nb) || nb.includes(na))) return true;
    return false;
  };
  const getPatientReports = (pid) => reports.filter(r => r.patientId === pid).sort((a, b) => new Date(b.date + "T00:00:00") - new Date(a.date + "T00:00:00"));
  const getTestTrend = (pid, testName) => {
    return reports.filter(r => r.patientId === pid).map(r => {
      
      let t = (r.tests || []).find(t => testNamesMatch(t.name, testName));
      if (!t && r.testGroups) {
        for (const g of r.testGroups) {
          t = (g.tests || []).find(t => testNamesMatch(t.name, testName));
          if (t) break;
        }
      }
      if (!t) return null;
      const normalized = normalizeDate(r.date);
      const dateVal = normalized ? new Date(normalized + "T00:00:00").getTime() : 0;
      const numVal = parseFloat(String(t.value).replace(/[<>]/g, "").trim());
      return {
        date: r.date,
        dateVal: (!isNaN(dateVal) && dateVal > 0) ? dateVal : Date.now(),
        value: isNaN(numVal) ? null : numVal,
        rawValue: t.value,
        unit: t.unit || "",
        range: t.range || "",
        status: t.status || "normal",
        label: formatTestDate(normalized || r.date),
        numeric: !isNaN(numVal),
      };
    }).filter(d => d !== null).sort((a, b) => a.dateVal - b.dateVal);
  };
  
  const getNumericTrend = (trendData) => trendData.filter(d => d.numeric);
  const checkAgainstRange = (val, rangeStr) => {
    if (val === null || val === undefined || !rangeStr) return null;
    const v = typeof val === "number" ? val : parseFloat(String(val).replace(/[<>]/g, "").trim());
    if (isNaN(v)) return null;
    const r = String(rangeStr).trim();
    if (!r || r === "N/A" || r === "-" || r === "NA") return null;
    const rangeMatches = [...r.matchAll(/([\d.]+)\s*[-–—]\s*([\d.]+)/g)];
    const toMatches = [...r.matchAll(/([\d.]+)\s+to\s+([\d.]+)/gi)];
    const allRanges = [...rangeMatches, ...toMatches];
    for (const match of allRanges) {
      const lo = parseFloat(match[1]), hi = parseFloat(match[2]);
      if (!isNaN(lo) && !isNaN(hi) && v >= lo && v <= hi) return false; 
    }
    if (allRanges.length > 0) {
      
      let minLo = Infinity, maxHi = -Infinity;
      allRanges.forEach(match => {
        const lo = parseFloat(match[1]), hi = parseFloat(match[2]);
        if (!isNaN(lo) && !isNaN(hi)) { minLo = Math.min(minLo, lo); maxHi = Math.max(maxHi, hi); }
      });
      if (minLo !== Infinity && maxHi !== -Infinity) return v < minLo || v > maxHi;
    }
    let m = r.match(/[<≤]\s*([\d.]+)/);
    if (!m) m = r.match(/(?:up\s*to|less\s*than|below|upto|not\s*more\s*than|desirable)[:\s]*([\d.]+)/i);
    if (m) { const hi = parseFloat(m[1]); if (!isNaN(hi)) return v > hi; }
    m = r.match(/[>≥]\s*([\d.]+)/);
    if (!m) m = r.match(/(?:above|greater\s*than|more\s*than|over)[:\s]*([\d.]+)/i);
    if (m) { const lo = parseFloat(m[1]); if (!isNaN(lo)) return v < lo; }
    return null; 
  };
  const getAbnormalStatus = (d) => {
    if (!d) return false;
    if (d.numeric && d.range) {
      const rangeResult = checkAgainstRange(d.value, d.range);
      if (rangeResult !== null) return rangeResult; 
    }
    
    return d.status === "high" || d.status === "low";
  };
  const resetUpload = () => {
    setShowUpload(false); setUploadStep("select"); setUploadStatus(""); setUploadError("");
    setAssignChoice("new"); setPendingData(null); setUploadFileName(""); setPendingFileData(null); setPendingFileType("");
    setEditName(""); setEditAge(""); setEditSex(""); setEditPhone(""); setEditAddress("");
    setFileQueue([]); setQueueIndex(0); setBatchMode(null); setSinglePatientId(null);
    
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const processFile = useCallback(async (file) => {
    if (!file) return;
    setUploadFileName(file.name || "Report");
    setUploadStep("processing");
    setUploadError("");
    let fileDataUrl;
    try {
      fileDataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error("FileReader error"));
        r.onabort = () => rej(new Error("FileReader aborted"));
        r.readAsDataURL(file);
      });
    } catch(e) {
      console.warn("Could not read file as data URL:", e);
      fileDataUrl = null;
    }
    setPendingFileData(fileDataUrl);
    setPendingFileType(file.type || "application/octet-stream");
    try {
      const fileType = detectFileType(file);
      let parsed;
      if (fileType === "image") {
        setUploadStatus("Reading image with AI vision...");
        const base64 = await fileToBase64(file);
        const mime = file.type || "image/jpeg";
        setUploadStatus("Detecting report type...");
        const rType = await detectReportType(null, true, base64, mime);
        if (rType === "imaging") {
          setUploadStatus("Summarising imaging report...");
          parsed = await parseImagingReport(null, true, base64, mime);
          parsed.reportType = "imaging";
        } else if (rType === "clinical_note") {
          setUploadStatus("Analysing clinical document...");
          parsed = await parseClinicalNote(null, true, base64, mime);
          parsed.reportType = "clinical_note";
        } else {
          setUploadStatus("Extracting lab results...");
          parsed = await parseWithAI(null, true, base64, mime);
        }
      } else if (fileType === "pdf") {
        setUploadStatus("Sending PDF to AI...");
        const base64 = await fileToBase64(file);
        setUploadStatus("Detecting report type...");
        const rType = await detectReportType(null, true, base64, "application/pdf");
        if (rType === "imaging") {
          setUploadStatus("Summarising imaging report...");
          parsed = await parseImagingReport(null, true, base64, "application/pdf");
          parsed.reportType = "imaging";
        } else if (rType === "clinical_note") {
          setUploadStatus("Analysing clinical document...");
          parsed = await parseClinicalNote(null, true, base64, "application/pdf");
          parsed.reportType = "clinical_note";
        } else {
          setUploadStatus("Extracting lab results...");
          parsed = await parseWithAI(null, true, base64, "application/pdf");
        }
      } else if (fileType === "docx") {
        setUploadStatus("Extracting text from document...");
        const text = await extractTextFromDocx(file);
        const rType = await detectReportType(text, false, null, null);
        if (rType === "imaging") {
          setUploadStatus("Summarising imaging report...");
          parsed = await parseImagingReport(text, false, null, null);
          parsed.reportType = "imaging";
        } else if (rType === "clinical_note") {
          setUploadStatus("Analysing clinical document...");
          parsed = await parseClinicalNote(text, false, null, null);
          parsed.reportType = "clinical_note";
        } else {
          setUploadStatus("Parsing report with AI...");
          parsed = await parseWithAI(text);
        }
      } else {
        setUploadStatus("Sending file to AI for analysis...");
        const base64 = await fileToBase64(file);
        const mime = file.type || "application/octet-stream";
        const rType = await detectReportType(null, true, base64, mime);
        if (rType === "imaging") {
          setUploadStatus("Summarising imaging report...");
          parsed = await parseImagingReport(null, true, base64, mime);
          parsed.reportType = "imaging";
        } else if (rType === "clinical_note") {
          setUploadStatus("Analysing clinical document...");
          parsed = await parseClinicalNote(null, true, base64, mime);
          parsed.reportType = "clinical_note";
        } else {
          parsed = await parseWithAI(null, true, base64, mime);
        }
      }
      const p = parsed.patient || {};
      const normalizeTestGroups = (tgs, flatTests) => {
        let groups = tgs || [];
        if (groups.length === 0 && flatTests?.length > 0) groups = [{ group: "Others", tests: flatTests }];
        return groups.map(g => ({
          group: g.group || "Others",
          tests: (g.tests || []).map(t => ({ ...t, value: t.value || "0", unit: t.unit || "", range: t.range || "N/A", status: t.status || "normal" }))
        })).filter(g => g.tests.length > 0);
      };
      if (parsed.reportType === "imaging") {
        parsed.testGroups = [];
        parsed.tests = [];
      } else if (parsed.reportType === "clinical_note") {
        parsed.testGroups = [];
        parsed.tests = [];
        if (parsed.extractedLabs) {
          parsed.extractedLabs = parsed.extractedLabs.map(lb => {
            const tgs = normalizeTestGroups(lb.testGroups, lb.tests);
            return { ...lb, testGroups: tgs, tests: tgs.flatMap(g => g.tests.map(t => ({ ...t, group: g.group }))) };
          });
        }
      } else {
        const testGroups = normalizeTestGroups(parsed.testGroups, parsed.tests);
        parsed.testGroups = testGroups;
        parsed.tests = testGroups.flatMap(g => g.tests.map(t => ({ ...t, group: g.group })));
      }
      setPendingData(parsed);
      let extractedAge = p.age || "";
      if (!extractedAge && p.dateOfBirth) {
        try {
          const dob = new Date(p.dateOfBirth);
          if (!isNaN(dob.getTime())) {
            const now = new Date();
            let age = now.getFullYear() - dob.getFullYear();
            const m = now.getMonth() - dob.getMonth();
            if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
            extractedAge = String(age);
          }
        } catch(e) {}
      }
      
      if (extractedAge) {
        const ageNum = extractedAge.match(/\d+/);
        if (ageNum) extractedAge = ageNum[0];
      }
      
      setEditName(p.name || "");
      setEditAge(extractedAge);
      setEditSex(p.sex || "");
      setEditPhone(p.phone || "");
      setEditAddress(p.address || "");
      const matchedId = matchPatient(p.name);
      if (batchMode === "single" && singlePatientId) {
        
        setAssignChoice(singlePatientId);
      } else if (matchedId) {
        setAssignChoice(matchedId);
      } else {
        setAssignChoice("new");
      }
      const totalTests = (parsed.tests || []).length;
      const totalGroups = (parsed.testGroups || []).length;
      console.log("AI Extraction:", totalTests, "tests in", totalGroups, "groups");
      if (totalTests === 0) console.warn("No tests extracted. Raw parsed:", JSON.stringify(parsed).slice(0, 500));
      setUploadStep("detected");
    } catch (err) {
      console.error("Processing error:", err);
      
      if (err.message?.includes("PDF")) pdfjsLoaded = null;
      const rawMsg = err.message || "Unknown error";
      const rawStack = err.stack || "";
      let msg = rawMsg;
      if (rawMsg.includes("JSON")) msg = "AI returned incomplete data. Please try again.";
      else if (rawMsg.includes("Failed to fetch") || rawMsg.includes("NetworkError") || rawMsg.includes("network") || rawMsg.includes("Load failed")) msg = "Network error — could not reach AI service. Check your connection or try inside a Claude.ai conversation (not a published link).";
      else if (rawMsg.includes("401") || rawMsg.includes("403")) msg = "API authentication failed. Upload only works inside Claude.ai, not in published/shared links.";
      else if (rawMsg.includes("password")) msg = "This PDF is password-protected. Please unlock it first.";
      else if (rawMsg.includes("timeout") || rawMsg.includes("Timeout")) msg = "Request timed out. Try a smaller file.";
      
      msg += "\n\n[Debug: " + rawMsg + (rawStack ? " | " + rawStack.split("\n")[0] : "") + "]";
      setUploadError(msg);
      setUploadStep("error");
    }
  }, [patients]);
  const matchPatient = (extractedName) => {
    if (!extractedName) return null;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const en = norm(extractedName);
    if (!en) return null;
    
    let match = patients.find(p => norm(p.name) === en);
    if (match) return match.id;
    
    const eWords = extractedName.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    for (const p of patients) {
      const pWords = p.name.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      const eInP = eWords.filter(w => pWords.some(pw => pw.includes(w) || w.includes(pw)));
      if (eInP.length >= Math.min(2, eWords.length) && eInP.length >= eWords.length * 0.6) return p.id;
    }
    return null;
  };
  const confirmAssignment = () => {
    const labInfo = pendingData?.lab || {};
    const reportDate = normalizeDate(labInfo.date) || new Date().toISOString().split("T")[0];
    let targetId;
    const isSingleBatchFollowup = batchMode === "single" && singlePatientId && queueIndex > 0;
    if (isSingleBatchFollowup) {
      targetId = singlePatientId;
    } else if (assignChoice === "new") {
      const newId = "p-" + Date.now();
      const parts = editName.trim().split(" ").filter(Boolean);
      const avatar = parts.map(n => (n[0] || "").toUpperCase()).join("").slice(0, 2) || "??";
      const np = { id: newId, name: editName.trim() || "Unknown Patient", age: parseInt(editAge) || 0, sex: editSex || "Unknown", phone: editPhone || "Not provided", address: editAddress || "Not provided", avatar };
      setPatients(prev => [...prev, np]);
      targetId = newId;
    } else {
      targetId = assignChoice;
      setPatients(prev => prev.map(p => {
        if (p.id !== targetId) return p;
        return {
          ...p,
          phone: (editPhone && editPhone !== "Not provided") ? editPhone : p.phone,
          address: (editAddress && editAddress !== "Not provided") ? editAddress : p.address,
        };
      }));
    }
    if (batchMode === "single" && !singlePatientId) {
      setSinglePatientId(targetId);
    }
    const tests = (pendingData?.tests || []).map(t => ({
      ...t,
      value: t.value || "0",
      unit: t.unit || "",
      range: t.range || "N/A",
      status: t.status || "normal",
    }));
    const testGroups = (pendingData?.testGroups || []).map(g => ({
      group: g.group || "Others",
      tests: (g.tests || []).map(t => ({
        ...t,
        value: t.value || "0",
        unit: t.unit || "",
        range: t.range || "N/A",
        status: t.status || "normal",
      }))
    }));
    const isImaging = pendingData?.reportType === "imaging";
    const isClinical = pendingData?.reportType === "clinical_note";
    const visitData = isClinical ? pendingData?.visit || {} : null;
    const visitDateRaw = visitData ? (visitData.dischargeDate || visitData.admissionDate || visitData.visitDate || "") : "";
    const visitDate = normalizeDate(visitDateRaw) || reportDate;
    const newReport = {
      id: "r-" + Date.now(),
      patientId: targetId,
      date: isClinical ? visitDate : reportDate,
      labName: isImaging
        ? (pendingData.imaging?.modality || "Imaging") + (pendingData.imaging?.bodyPart ? " — " + pendingData.imaging.bodyPart : "")
        : isClinical
          ? (visitData?.hospital || "Clinical Note") + (visitData?.visitType ? " (" + visitData.visitType + ")" : "")
          : (labInfo.name || "Unknown Lab"),
      fileName: uploadFileName,
      fileData: pendingFileData,
      fileType: pendingFileType,
      tests,
      testGroups,
      reportType: pendingData?.reportType || "lab",
      imaging: pendingData?.imaging || null,
      visit: visitData,
      analysis: null,
      uploadedAt: new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
    };
    const reportsToAdd = [newReport];
    if (isClinical && pendingData?.extractedLabs?.length > 0) {
      pendingData.extractedLabs.forEach((lb, i) => {
        if (!lb.testGroups?.length && !lb.tests?.length) return;
        const labDate = normalizeDate(lb.date) || visitDate;
        reportsToAdd.push({
          id: "r-" + (Date.now() + i + 1),
          patientId: targetId,
          date: labDate,
          labName: lb.labName || (visitData?.hospital ? visitData.hospital + " Lab" : "In-Hospital Lab"),
          fileName: uploadFileName + " (labs)",
          fileData: null,
          fileType: pendingFileType,
          tests: lb.tests || [],
          testGroups: lb.testGroups || [],
          reportType: "lab",
          imaging: null,
          visit: null,
          analysis: null,
          uploadedAt: new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
          sourceVisitId: newReport.id,
        });
      });
    }
    setReports(prev => [...reportsToAdd, ...prev]);
    setUploadStep("done");
    const nextIdx = queueIndex + 1;
    if (nextIdx < fileQueue.length) {
      
      setTimeout(() => {
        setQueueIndex(nextIdx);
        setUploadStep("processing");
        setUploadStatus(""); setUploadError("");
        setPendingData(null); setUploadFileName(""); setPendingFileData(null); setPendingFileType("");
        setEditName(""); setEditAge(""); setEditSex(""); setEditPhone(""); setEditAddress("");
        setAssignChoice("new");
        processFile(fileQueue[nextIdx]);
      }, 800);
    } else {
      
      setTimeout(() => { resetUpload(); setSelectedPatient(targetId); setSelectedReport(reportsToAdd[0].id); setActiveTab("patients"); }, 1200);
    }
  };
  const generateAnalysis = async (report) => {
    setAnalysisLoading(true);
    setShowAnalysis(report.id);
    setAnalysisData(null);
    try {
      const patient = patients.find(p => p.id === report.patientId) || {};
      const result = await getAIAnalysis(report.tests, patient);
      setAnalysisData(result);
      setReports(prev => prev.map(r => r.id === report.id ? { ...r, analysis: result } : r));
    } catch (err) {
      setAnalysisData(null);
    }
    setAnalysisLoading(false);
  };
  const inputStyle = { width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid " + theme.border, fontSize: 14, color: theme.text, outline: "none", background: "white", boxSizing: "border-box" };
  const pageStyle = { maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: theme.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", position: "relative" };
  const LogoWordmark = ({ size = "large" }) => {
    const s = size === "large";
    const f = "'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif";
    const accent = s ? "#1A2744" : "#1A2744";
    return (
      <span style={{ fontFamily: f, fontSize: s ? 22 : 18, letterSpacing: -0.5, display: "inline-flex", alignItems: "baseline" }}>
        <span style={{ fontFamily: "'Caveat', cursive", fontWeight: 700, color: accent, fontSize: s ? 52 : 38 }}>my</span>
        <span style={{ fontWeight: 700, color: "white", marginLeft: s ? 4 : 3 }}>Health </span>
        <span style={{ fontWeight: 700, color: accent }}>Plus+</span>
      </span>
    );
  };
  const SettingsBtn = () => (
    <button onClick={() => setShowSettings(true)} style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 10, padding: 6, cursor: "pointer", display: "flex", alignItems: "center" }}>
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
    </button>
  );
  const Header = ({ title, showBack, onBack, rightAction }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px 12px", background: "linear-gradient(135deg, #D97757 0%, #C4623F 100%)", color: "white", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {showBack && <button onClick={onBack} style={{ background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 10, padding: 6, cursor: "pointer", display: "flex" }}><Icon type="back" size={20} color="white"/></button>}
        <LogoWordmark size={showBack ? "small" : "large"}/>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {rightAction}
        <SettingsBtn/>
      </div>
    </div>
  );
  const BottomNav = () => (
    <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, background: "white", borderTop: "1px solid " + theme.border, display: "flex", justifyContent: "space-around", padding: "8px 0 20px", zIndex: 200, boxShadow: "0 -2px 16px rgba(0,0,0,0.06)" }}>
      {[{ id: "home", icon: "home", label: "Home" }, { id: "patients", icon: "users", label: "Patients" }, { id: "upload", icon: "upload", label: "Upload" }, { id: "trends", icon: "trend", label: "Trends" }, { id: "results", icon: "grid", label: "Results" }].map(tab => (
        <button key={tab.id} onClick={() => { if (tab.id === "upload") { setShowUpload(true); setUploadStep("select"); return; } setActiveTab(tab.id); setSelectedPatient(null); setSelectedReport(null); setSelectedTest(null); setShowReportViewer(false); }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: "4px 12px", color: activeTab === tab.id ? theme.primary : theme.textSecondary }}>
          <div style={{ padding: 6, borderRadius: 12, background: activeTab === tab.id ? theme.primary + "15" : "transparent" }}><Icon type={tab.icon} size={22} color={activeTab === tab.id ? theme.primary : theme.textSecondary}/></div>
          <span style={{ fontSize: 11, fontWeight: activeTab === tab.id ? 600 : 400 }}>{tab.label}</span>
        </button>
      ))}
    </div>
  );
  const UploadModal = () => (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }} onClick={(e) => { if (e.target === e.currentTarget && (uploadStep === "select" || uploadStep === "error")) resetUpload(); }}>
      <div style={{ background: "white", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, padding: "24px 24px 40px", maxHeight: "85vh", overflowY: "auto", animation: "slideUp 0.3s ease-out" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: theme.text }}>
            {uploadStep === "select" ? "Upload Health Reports" : uploadStep === "batch-choose" ? "Multiple Files Selected" : uploadStep === "processing" ? "Processing Report" : uploadStep === "detected" ? "Review Extracted Data" : uploadStep === "done" ? "Upload Complete" : "Upload Error"}
            {fileQueue.length > 1 && !["select", "batch-choose"].includes(uploadStep) && <span style={{ fontSize: 12, fontWeight: 500, color: theme.textSecondary, marginLeft: 8 }}>({queueIndex + 1} of {fileQueue.length})</span>}
          </h2>
          {(uploadStep === "select" || uploadStep === "error" || uploadStep === "batch-choose") && <button onClick={resetUpload} style={{ background: theme.bg, border: "none", borderRadius: 10, padding: 6, cursor: "pointer" }}><Icon type="close" size={18} color={theme.textSecondary}/></button>}
        </div>
        {/* SELECT FILE */}
        {uploadStep === "select" && (<>
          <div onClick={() => fileInputRef.current?.click()} style={{ border: "2px dashed " + theme.primary + "40", borderRadius: 16, padding: 40, textAlign: "center", cursor: "pointer", background: theme.primary + "05", marginBottom: 16 }}>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: theme.primary + "15", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Icon type="upload" size={28} color={theme.primary}/></div>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: theme.text, marginBottom: 6 }}>Tap to select reports</p>
            <p style={{ margin: 0, fontSize: 13, color: theme.textSecondary }}>PDF, Word (.docx), JPEG, PNG — select multiple</p>
            <input ref={fileInputRef} type="file" multiple accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic,.heif,.bmp,.gif,application/pdf,image/*,.tiff,.tif" style={{ display: "none" }} onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (files.length === 0) return;
              
              e.target.value = "";
              setFileQueue(files);
              setQueueIndex(0);
              if (files.length > 1) {
                setUploadStep("batch-choose");
              } else {
                setBatchMode(null);
                processFile(files[0]);
              }
            }}/>
          </div>
          <div style={{ background: theme.primary + "08", borderRadius: 12, padding: 14, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Icon type="ai" size={20} color={theme.primary}/>
            <div>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: theme.text }}>AI-Powered Extraction</p>
              <p style={{ margin: "4px 0 0", fontSize: 12, color: theme.textSecondary, lineHeight: 1.5 }}>Patient name, age, sex, phone, address, and all test results will be automatically extracted. Select multiple files to batch upload.</p>
            </div>
          </div>
        </>)}
        {/* BATCH MODE CHOICE - shown for multiple files */}
        {uploadStep === "batch-choose" && (<>
          <div style={{ background: theme.primary + "08", borderRadius: 14, padding: 16, marginBottom: 20, display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: theme.primary + "15", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon type="file" size={24} color={theme.primary}/>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: theme.text }}>{fileQueue.length} files selected</p>
              <p style={{ margin: "4px 0 0", fontSize: 12, color: theme.textSecondary }}>{fileQueue.map(f => f.name).join(", ")}</p>
            </div>
          </div>
          <p style={{ fontSize: 15, fontWeight: 700, color: theme.text, marginBottom: 12 }}>Are these reports for:</p>
          <div onClick={() => setBatchMode("single")} style={{
            background: batchMode === "single" ? theme.primary + "10" : "white", border: "2px solid " + (batchMode === "single" ? theme.primary : theme.border),
            borderRadius: 16, padding: 16, marginBottom: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 14,
          }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: batchMode === "single" ? theme.primary : theme.primary + "15", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon type="users" size={24} color={batchMode === "single" ? "white" : theme.primary}/>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>Single Patient</div>
              <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 3 }}>All {fileQueue.length} reports belong to the same person</div>
            </div>
            {batchMode === "single" && <Icon type="check" size={20} color={theme.primary}/>}
          </div>
          <div onClick={() => setBatchMode("multi")} style={{
            background: batchMode === "multi" ? theme.primary + "10" : "white", border: "2px solid " + (batchMode === "multi" ? theme.primary : theme.border),
            borderRadius: 16, padding: 16, marginBottom: 20, cursor: "pointer", display: "flex", alignItems: "center", gap: 14,
          }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: batchMode === "multi" ? theme.primary : theme.primary + "15", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={batchMode === "multi" ? "white" : theme.primary} strokeWidth="2">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>Multiple Patients</div>
              <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 3 }}>Reports are for different people — will auto-match names</div>
            </div>
            {batchMode === "multi" && <Icon type="check" size={20} color={theme.primary}/>}
          </div>
          {batchMode && (
            <button onClick={() => { processFile(fileQueue[0]); }} style={{
              width: "100%", padding: 16, background: "linear-gradient(135deg, " + theme.primary + ", #C4623F)", color: "white",
              border: "none", borderRadius: 14, fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 16px rgba(217,119,87,0.3)",
            }}>
              Start Processing {fileQueue.length} Reports
            </button>
          )}
        </>)}
        {/* PROCESSING */}
        {uploadStep === "processing" && (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <div style={{ width: 80, height: 80, borderRadius: 40, background: theme.primary + "10", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", animation: "pulse 1.5s ease-in-out infinite" }}>
              <Icon type="ai" size={36} color={theme.primary}/>
            </div>
            <p style={{ fontSize: 16, fontWeight: 600, color: theme.text, marginBottom: 6 }}>{uploadStatus || "Processing..."}</p>
            <p style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 4 }}>{uploadFileName}</p>
            {fileQueue.length > 1 && <p style={{ fontSize: 12, color: theme.primary, fontWeight: 600, marginTop: 8 }}>File {queueIndex + 1} of {fileQueue.length}</p>}
            <div style={{ width: 40, height: 4, background: theme.primary + "30", borderRadius: 2, margin: "16px auto 0", overflow: "hidden" }}>
              <div style={{ width: "60%", height: "100%", background: theme.primary, borderRadius: 2, animation: "loading 1.2s ease-in-out infinite" }}/>
            </div>
          </div>
        )}
        {/* ERROR */}
        {uploadStep === "error" && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ width: 64, height: 64, borderRadius: 32, background: "#FFEBEE", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Icon type="alert" size={30} color="#D32F2F"/>
            </div>
            <p style={{ fontSize: 15, fontWeight: 600, color: theme.text, marginBottom: 8 }}>Processing Failed</p>
            <p style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 12, lineHeight: 1.5, padding: "0 10px" }}>{uploadError}</p>
            <details style={{ textAlign: "left", marginBottom: 16, padding: "0 10px" }}>
              <summary style={{ fontSize: 11, color: theme.textSecondary, cursor: "pointer" }}>Show technical details</summary>
              <pre style={{ fontSize: 10, color: "#999", background: theme.bg, padding: 10, borderRadius: 8, marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 120, overflow: "auto" }}>{uploadError}</pre>
            </details>
            <button onClick={() => { setUploadStep("select"); setUploadError(""); }} style={{ padding: "12px 32px", background: theme.primary, color: "white", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Try Again</button>
          </div>
        )}
        {/* DETECTED - REVIEW EXTRACTED DATA */}
        {uploadStep === "detected" && pendingData && (() => {
          const isSingleBatchFollowup = batchMode === "single" && singlePatientId && queueIndex > 0;
          const assignedPatient = isSingleBatchFollowup ? patients.find(p => p.id === singlePatientId) : null;
          const autoMatchedId = batchMode === "multi" ? matchPatient(editName) : null;
          const autoMatchedPatient = autoMatchedId ? patients.find(p => p.id === autoMatchedId) : null;
          return (<>
            {/* Success banner — imaging / clinical_note / lab */}
            {pendingData.reportType === "imaging" ? (
              <div style={{ background: "#E8EAF6", border: "1px solid #9FA8DA", borderRadius: 14, padding: 14, marginBottom: 16, display: "flex", gap: 10 }}>
                <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#3949AB" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1A237E" }}>Imaging report detected — findings summarised</p>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: theme.textSecondary }}>{pendingData.imaging?.modality || "Imaging"} · {pendingData.imaging?.bodyPart || ""}</p>
                </div>
              </div>
            ) : pendingData.reportType === "clinical_note" ? (
              <div style={{ background: "#E8F5E9", border: "1px solid #A5D6A7", borderRadius: 14, padding: 14, marginBottom: 16, display: "flex", gap: 10 }}>
                <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#2E7D32" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1B5E20" }}>Clinical {pendingData.visit?.visitType === "IP" ? "Discharge Summary" : "Note"} detected</p>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: theme.textSecondary }}>
                    {pendingData.visit?.hospital || "Hospital"} · {pendingData.visit?.visitType || "OP"}
                    {pendingData.extractedLabs?.length > 0 ? " · " + pendingData.extractedLabs.length + " lab set(s) extracted" : ""}
                  </p>
                </div>
              </div>
            ) : (
              <div style={{ background: theme.accent + "10", border: "1px solid " + theme.accent + "30", borderRadius: 14, padding: 14, marginBottom: 16, display: "flex", gap: 10 }}>
                <Icon type="check" size={20} color={theme.accent}/>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1B5E20" }}>AI successfully extracted data from your report</p>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: theme.textSecondary }}>{pendingData.tests?.length || 0} test results found - Review & edit below</p>
                </div>
              </div>
            )}
            {/* Single-patient batch followup: show assigned patient banner */}
            {isSingleBatchFollowup && assignedPatient && (
              <div style={{ background: theme.primary + "10", border: "1.5px solid " + theme.primary + "30", borderRadius: 14, padding: 14, marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg, #D97757, #C4623F)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "white", flexShrink: 0 }}>{assignedPatient.avatar}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>Assigning to: {assignedPatient.name}</div>
                  <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{assignedPatient.age} yrs - {assignedPatient.sex}</div>
                </div>
                <div style={{ padding: "4px 10px", background: theme.primary + "20", borderRadius: 8, fontSize: 11, fontWeight: 600, color: theme.primary }}>Auto</div>
              </div>
            )}
            {/* Editable patient info - hidden for single-batch followup */}
            {!isSingleBatchFollowup && (
              <div style={{ background: "white", border: "1px solid " + theme.border, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: theme.text, display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon type="users" size={16} color={theme.primary}/> Extracted Patient Information
                </h4>
                {[{ label: "Full Name", val: editName, set: setEditName }, { label: "Age", val: editAge, set: setEditAge, type: "number" }, { label: "Sex", val: editSex, set: setEditSex }, { label: "Phone", val: editPhone, set: setEditPhone, type: "tel" }, { label: "Address", val: editAddress, set: setEditAddress }].map((f, i) => (
                  <div key={i} style={{ marginBottom: i < 4 ? 10 : 0 }}>
                    <label style={{ fontSize: 12, color: theme.textSecondary, fontWeight: 600, display: "block", marginBottom: 4 }}>{f.label}</label>
                    <input value={f.val} onChange={e => f.set(e.target.value)} type={f.type || "text"} placeholder={"Enter " + f.label.toLowerCase()} style={inputStyle}/>
                  </div>
                ))}
              </div>
            )}
            {/* Results preview — imaging summary or lab test list */}
            {pendingData.reportType === "clinical_note" && pendingData.visit && (
              <div style={{ background: "white", border: "1px solid " + theme.border, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: theme.text, display: "flex", alignItems: "center", gap: 8 }}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={theme.primary} strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  Visit Summary
                </h4>
                {pendingData.visit.summary && <p style={{ margin: "0 0 12px", fontSize: 13, color: theme.text, lineHeight: 1.5, padding: "10px 12px", background: theme.bg, borderRadius: 8 }}>{pendingData.visit.summary}</p>}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  {[
                    { label: "Hospital", val: pendingData.visit.hospital },
                    { label: "Type", val: pendingData.visit.visitType === "IP" ? "Inpatient" : "Outpatient" },
                    { label: "Doctor", val: pendingData.visit.doctor },
                    { label: "Department", val: pendingData.visit.department },
                    { label: pendingData.visit.visitType === "IP" ? "Admitted" : "Visit Date", val: pendingData.visit.admissionDate || pendingData.visit.visitDate },
                    { label: "Discharged", val: pendingData.visit.dischargeDate },
                  ].filter(x => x.val).map((item, i) => (
                    <div key={i} style={{ padding: "8px 10px", background: theme.bg, borderRadius: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: theme.textSecondary, textTransform: "uppercase", marginBottom: 2 }}>{item.label}</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>{item.val}</div>
                    </div>
                  ))}
                </div>
                {pendingData.visit.diagnoses?.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary, marginBottom: 4 }}>DIAGNOSES</div>
                    {pendingData.visit.diagnoses.map((d, i) => <div key={i} style={{ fontSize: 12, color: theme.text, padding: "4px 0", borderBottom: "1px solid " + theme.border }}>{i === 0 ? "• " : "◦ "}{d}</div>)}
                  </div>
                )}
                {pendingData.visit.medications?.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary, marginBottom: 4 }}>MEDICATIONS ({pendingData.visit.medications.length})</div>
                    {pendingData.visit.medications.slice(0, 5).map((m, i) => <div key={i} style={{ fontSize: 12, color: theme.text, padding: "3px 0" }}>• {m.name}{m.dose ? " " + m.dose : ""}{m.frequency ? " · " + m.frequency : ""}</div>)}
                    {pendingData.visit.medications.length > 5 && <div style={{ fontSize: 11, color: theme.textSecondary }}>+{pendingData.visit.medications.length - 5} more</div>}
                  </div>
                )}
                {pendingData.visit.followUp && <div style={{ fontSize: 12, color: theme.textSecondary, fontStyle: "italic", borderTop: "1px solid " + theme.border, paddingTop: 8 }}>Follow-up: {pendingData.visit.followUp}</div>}
                {pendingData.extractedLabs?.length > 0 && (
                  <div style={{ marginTop: 10, padding: "8px 10px", background: theme.primary + "08", borderRadius: 8, border: "1px solid " + theme.primary + "20" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: theme.primary }}>🧪 {pendingData.extractedLabs.reduce((n, lb) => n + (lb.tests?.length || 0), 0)} lab results will be saved separately with individual dates</div>
                  </div>
                )}
              </div>
            )}
            {pendingData.reportType === "imaging" && pendingData.imaging && (
              <div style={{ background: "white", border: "1px solid " + theme.border, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: theme.text, display: "flex", alignItems: "center", gap: 8 }}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={theme.primary} strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> Imaging Summary
                </h4>
                {pendingData.imaging.clinicalHistory && (
                  <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10, padding: "8px 10px", background: theme.bg, borderRadius: 8 }}>
                    <span style={{ fontWeight: 600, color: theme.text }}>Clinical History: </span>{pendingData.imaging.clinicalHistory}
                  </div>
                )}
                {pendingData.imaging.abnormalFindings?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#C62828", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 4, background: "#E53935" }}/> Abnormal Findings
                    </div>
                    {pendingData.imaging.abnormalFindings.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, padding: "6px 10px", background: "#FFEBEE", borderRadius: 8, marginBottom: 4, borderLeft: "3px solid #E53935" }}>
                        <span style={{ fontSize: 12, color: "#B71C1C", lineHeight: 1.4 }}>• {f}</span>
                      </div>
                    ))}
                  </div>
                )}
                {pendingData.imaging.normalFindings?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#2E7D32", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 4, background: "#4CAF50" }}/> Normal Findings
                    </div>
                    {pendingData.imaging.normalFindings.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, padding: "6px 10px", background: "#E8F5E9", borderRadius: 8, marginBottom: 4, borderLeft: "3px solid #4CAF50" }}>
                        <span style={{ fontSize: 12, color: "#1B5E20", lineHeight: 1.4 }}>• {f}</span>
                      </div>
                    ))}
                  </div>
                )}
                {pendingData.imaging.impression && (
                  <div style={{ padding: "10px 12px", background: "#E8EAF6", borderRadius: 8, borderLeft: "3px solid #3949AB" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#1A237E", marginBottom: 4 }}>IMPRESSION</div>
                    <div style={{ fontSize: 12, color: "#1A237E", lineHeight: 1.5 }}>{pendingData.imaging.impression}</div>
                  </div>
                )}
              </div>
            )}
            {pendingData.reportType !== "imaging" && pendingData.testGroups?.length > 0 && (
              <div style={{ background: "white", border: "1px solid " + theme.border, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: theme.text, display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon type="file" size={16} color={theme.primary}/> Extracted Test Results ({pendingData.tests?.length || 0})
                </h4>
                <div style={{ maxHeight: 280, overflowY: "auto" }}>
                  {pendingData.testGroups.map((grp, gi) => (
                    <div key={gi} style={{ marginBottom: gi < pendingData.testGroups.length - 1 ? 12 : 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "6px 10px", background: theme.primary + "08", borderRadius: 8 }}>
                        <div style={{ width: 6, height: 6, borderRadius: 3, background: theme.primary }}/>
                        <span style={{ fontSize: 13, fontWeight: 700, color: theme.primary }}>{grp.group}</span>
                        <span style={{ fontSize: 11, color: theme.textSecondary, marginLeft: "auto" }}>{grp.tests.length} tests</span>
                      </div>
                      {grp.tests.map((t, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", borderBottom: i < grp.tests.length - 1 ? "1px solid " + theme.border : "none" }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 500, color: theme.text }}>{t.name}</div>
                            <div style={{ fontSize: 10, color: theme.textSecondary }}>Ref: {t.range || "N/A"}</div>
                          </div>
                          <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: t.status === "high" ? theme.warning : t.status === "low" ? "#1565C0" : theme.text }}>{t.value} {t.unit}</span>
                            <StatusBadge status={t.status || "normal"}/>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Assignment - hidden for single-batch followup */}
            {!isSingleBatchFollowup && (<>
              <h4 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 700, color: theme.text }}>Save report to:</h4>
              {/* Auto-match indicator for multi-patient mode */}
              {batchMode === "multi" && autoMatchedPatient && assignChoice === autoMatchedId && (
                <div style={{ background: theme.accent + "08", border: "1px solid " + theme.accent + "30", borderRadius: 10, padding: "8px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon type="check" size={14} color={theme.accent}/>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#1B5E20" }}>Auto-matched to "{autoMatchedPatient.name}" based on report name</span>
                </div>
              )}
              <div onClick={() => setAssignChoice("new")} style={{ background: assignChoice === "new" ? theme.primary + "10" : "white", border: "2px solid " + (assignChoice === "new" ? theme.primary : theme.border), borderRadius: 14, padding: 14, marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: assignChoice === "new" ? theme.primary : theme.primary + "15", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon type="userplus" size={22} color={assignChoice === "new" ? "white" : theme.primary}/></div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>Create New Patient</div><div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{editName || "Unknown"} {editAge ? "- " + editAge + " yrs" : ""} {editSex ? "- " + editSex : ""}</div></div>
                {assignChoice === "new" && <Icon type="check" size={20} color={theme.primary}/>}
              </div>
              {patients.length > 0 && <p style={{ fontSize: 12, color: theme.textSecondary, margin: "12px 0 8px", fontWeight: 600 }}>Or add to existing patient:</p>}
              {patients.map(p => (
                <div key={p.id} onClick={() => setAssignChoice(p.id)} style={{ background: assignChoice === p.id ? theme.primary + "10" : "white", border: "2px solid " + (assignChoice === p.id ? theme.primary : theme.border), borderRadius: 14, padding: 14, marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg, #D97757, #C4623F)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "white" }}>{p.avatar}</div>
                  <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{p.name}</div><div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{p.age} yrs - {p.sex} - {getPatientReports(p.id).length} reports</div></div>
                  {assignChoice === p.id && <Icon type="check" size={20} color={theme.primary}/>}
                </div>
              ))}
            </>)}
            <button onClick={confirmAssignment} style={{ width: "100%", padding: 16, marginTop: 16, background: "linear-gradient(135deg, " + theme.primary + ", #C4623F)", color: "white", border: "none", borderRadius: 14, fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 16px rgba(217,119,87,0.3)" }}>
              {isSingleBatchFollowup ? "Save Report to " + (assignedPatient?.name || "Patient") : assignChoice !== "new" ? "Add Report to " + (patients.find(p => p.id === assignChoice)?.name || "Patient") : "Create Patient & Save Report"}
            </button>
            <div style={{ background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 12, padding: 12, marginTop: 12, display: "flex", gap: 8 }}>
              <Icon type="alert" size={16} color="#F9A825"/>
              <p style={{ margin: 0, fontSize: 11, color: "#5D4037", lineHeight: 1.5 }}><strong>Note:</strong> AI extraction may have inaccuracies. Please verify all patient details and test results before saving.</p>
            </div>
          </>);
        })()}
        {/* DONE */}
        {uploadStep === "done" && (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <div style={{ width: 80, height: 80, borderRadius: 40, background: theme.accent + "15", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}><Icon type="check" size={40} color={theme.accent}/></div>
            <p style={{ fontSize: 18, fontWeight: 700, color: theme.text, marginBottom: 6 }}>Report Saved!</p>
            {queueIndex + 1 < fileQueue.length ? (
              <p style={{ fontSize: 13, color: theme.textSecondary }}>Processing next file... ({queueIndex + 1} of {fileQueue.length} done)</p>
            ) : fileQueue.length > 1 ? (
              <p style={{ fontSize: 13, color: theme.textSecondary }}>All {fileQueue.length} reports saved!</p>
            ) : (
              <p style={{ fontSize: 13, color: theme.textSecondary }}>Opening patient details...</p>
            )}
            {fileQueue.length > 1 && (
              <div style={{ margin: "16px auto 0", width: "80%", height: 6, background: theme.border, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: Math.round(((queueIndex + 1) / fileQueue.length) * 100) + "%", height: "100%", background: theme.accent, borderRadius: 3, transition: "width 0.3s" }}/>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
  const HomeScreen = () => {
    const totalReports = reports.length;
    const abnormalCount = reports.flatMap(r => r.tests).filter(t => t.status !== "normal").length;
    const recentReports = [...reports].sort((a, b) => new Date(b.date + "T00:00:00") - new Date(a.date + "T00:00:00")).slice(0, 5);
    return (
      <div style={{ paddingBottom: 90 }}>
        <Header title="My Health Plus"/>
        <div style={{ padding: "20px 20px 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
            {[{ label: "Patients", value: patients.length, icon: "users", color: theme.primary }, { label: "Reports", value: totalReports, icon: "file", color: theme.accent }, { label: "Alerts", value: abnormalCount, icon: "alert", color: theme.warning }].map((st, i) => (
              <div key={i} style={{ background: "white", borderRadius: 16, padding: "16px 12px", textAlign: "center", boxShadow: theme.shadow }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: st.color + "15", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px" }}><Icon type={st.icon} size={20} color={st.color}/></div>
                <div style={{ fontSize: 24, fontWeight: 700, color: theme.text }}>{st.value}</div>
                <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{st.label}</div>
              </div>
            ))}
          </div>
          <div style={{ background: "linear-gradient(135deg, #D97757 0%, #C4623F 100%)", borderRadius: 20, padding: 20, marginBottom: 24, boxShadow: "0 4px 20px rgba(217,119,87,0.3)" }}>
            <h3 style={{ color: "white", fontSize: 16, fontWeight: 600, margin: "0 0 14px" }}>Get Started</h3>
            <p style={{ color: "rgba(255,255,255,0.85)", fontSize: 13, margin: "0 0 16px", lineHeight: 1.5 }}>Upload a health report (PDF, image, or Word) and AI will automatically extract patient info and test results.</p>
            <button onClick={() => { setShowUpload(true); setUploadStep("select"); }} style={{ width: "100%", background: "rgba(255,255,255,0.2)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 14, padding: "14px 12px", cursor: "pointer", color: "white", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 15, fontWeight: 600, backdropFilter: "blur(10px)" }}>
              <Icon type="upload" size={22} color="white"/> Upload Health Reports
            </button>
          </div>
          {recentReports.length > 0 && <h3 style={{ fontSize: 16, fontWeight: 700, color: theme.text, margin: "0 0 12px" }}>Recent Reports</h3>}
          {recentReports.map(report => {
            const patient = patients.find(p => p.id === report.patientId);
            const abnormal = report.tests.filter(t => t.status !== "normal").length;
            return (
              <div key={report.id} onClick={() => { setSelectedPatient(report.patientId); setSelectedReport(report.id); setActiveTab("patients"); }} style={{ background: "white", borderRadius: 16, padding: 16, marginBottom: 10, boxShadow: theme.shadow, cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 48, height: 48, borderRadius: 14, background: theme.primary + "12", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: theme.primary }}>{patient?.avatar}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{patient?.name}</div>
                  <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{report.labName} - {formatTestDate(report.date)}</div>
                  {abnormal > 0 && <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}><Icon type="alert" size={13} color={theme.warning}/><span style={{ fontSize: 11, color: theme.warning, fontWeight: 600 }}>{abnormal} abnormal</span></div>}
                </div>
                <Icon type="chevron" size={18} color={theme.textSecondary}/>
              </div>
            );
          })}
          {reports.length === 0 && (
            <div style={{ textAlign: "center", padding: "30px 0", color: theme.textSecondary }}>
              <Icon type="file" size={48} color={theme.border}/><p style={{ marginTop: 12, fontSize: 14 }}>No reports yet. Upload health reports above!</p>
            </div>
          )}
          <div style={{ background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 14, padding: 14, marginTop: 14, display: "flex", gap: 10 }}>
            <Icon type="alert" size={18} color="#F9A825"/>
            <p style={{ margin: 0, fontSize: 12, color: "#5D4037", lineHeight: 1.5 }}><strong>Medical Disclaimer:</strong> AI analysis is for informational purposes only. Always consult your physician for actual diagnosis and treatment.</p>
          </div>
        </div>
      </div>
    );
  };
  const PatientsScreen = () => {
    const filtered = patients.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));
    if (selectedPatient && !selectedReport) {
      const patient = patients.find(p => p.id === selectedPatient);
      if (!patient) { setSelectedPatient(null); return null; }
      const pReports = getPatientReports(selectedPatient);
      return (
        <div style={{ paddingBottom: 90 }}>
          <Header title={patient.name} showBack onBack={() => setSelectedPatient(null)}/>
          <div style={{ padding: 20 }}>
            <div style={{ background: "white", borderRadius: 20, padding: 20, boxShadow: theme.shadow, marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                <div style={{ width: 60, height: 60, borderRadius: 18, background: "linear-gradient(135deg, #D97757, #C4623F)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 700, color: "white" }}>{patient.avatar}</div>
                <div><div style={{ fontSize: 18, fontWeight: 700, color: theme.text }}>{patient.name}</div><div style={{ fontSize: 13, color: theme.textSecondary, marginTop: 2 }}>{patient.age > 0 ? patient.age + " yrs" : "Age N/A"} - {patient.sex}</div></div>
              </div>
              <div style={{ borderTop: "1px solid " + theme.border, paddingTop: 14 }}>
                {[{ label: "Phone", value: patient.phone }, { label: "Address", value: patient.address }, { label: "Reports", value: pReports.length + " uploaded" }].map((item, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < 2 ? "1px solid " + theme.border : "none" }}>
                    <span style={{ fontSize: 13, color: theme.textSecondary }}>{item.label}</span><span style={{ fontSize: 13, fontWeight: 500, color: theme.text, textAlign: "right", maxWidth: "60%" }}>{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: theme.text, margin: "0 0 12px" }}>Reports ({pReports.length})</h3>
            {pReports.map(report => {
              const abnormal = report.tests.filter(t => t.status !== "normal").length;
              const isImg = report.reportType === "imaging";
              const isClin = report.reportType === "clinical_note";
              const borderCol = isClin ? "#2E7D32" : isImg ? "#3949AB" : (abnormal > 0 ? theme.warning : theme.accent);
              return (<div key={report.id} onClick={() => setSelectedReport(report.id)} style={{ background: "white", borderRadius: 16, padding: 16, marginBottom: 10, boxShadow: theme.shadow, cursor: "pointer", borderLeft: "4px solid " + borderCol }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{report.labName}</div>
                    <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 3 }}>
                      {isClin ? (report.visit?.admissionDate && report.visit?.dischargeDate
                        ? "Admitted: " + formatTestDate(normalizeDate(report.visit.admissionDate)) + " · Discharged: " + formatTestDate(normalizeDate(report.visit.dischargeDate))
                        : "Visit: " + formatTestDate(report.date))
                        : "Date: " + formatTestDate(report.date)}
                    </div>
                    <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>
                      {isClin ? <span style={{ color: "#2E7D32", fontWeight: 600 }}>Clinical Note · {report.visit?.visitType === "IP" ? "Inpatient" : "Outpatient"}</span>
                        : isImg ? <span style={{ color: "#3949AB", fontWeight: 600 }}>Imaging Report</span>
                        : <>{report.tests.length} tests{report.testGroups?.length > 0 ? " · " + report.testGroups.length + " panels" : ""}</>}
                      {" · "}Uploaded: {report.uploadedAt}
                    </div>
                    {isClin && report.visit?.diagnoses?.length > 0 && (
                      <div style={{ fontSize: 11, color: theme.text, marginTop: 4, fontStyle: "italic" }}>{report.visit.diagnoses[0]}</div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {!isImg && !isClin && abnormal > 0 && <span style={{ background: "#FFF3E0", color: "#E65100", fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20 }}>{abnormal} alert{abnormal > 1 ? "s" : ""}</span>}
                    {isImg && report.imaging?.abnormalFindings?.length > 0 && <span style={{ background: "#FFEBEE", color: "#C62828", fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20 }}>{report.imaging.abnormalFindings.length} finding{report.imaging.abnormalFindings.length > 1 ? "s" : ""}</span>}
                    <Icon type="chevron" size={18} color={theme.textSecondary}/>
                  </div>
                </div>
              </div>);
            })}
          </div>
        </div>
      );
    }
    if (selectedReport) {
      const report = reports.find(r => r.id === selectedReport);
      if (!report) { setSelectedReport(null); return null; }
      const patient = patients.find(p => p.id === report.patientId);
      return (
        <div style={{ paddingBottom: 90 }}>
          <Header title="Report Details" showBack onBack={() => { if (selectedTest) { setSelectedTest(null); return; } setShowReportViewer(false); setSelectedReport(null); }} rightAction={
            <button onClick={() => { if (report.analysis) { setAnalysisData(report.analysis); setShowAnalysis(report.id); setAnalysisLoading(false); } else { generateAnalysis(report); } }} style={{ background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 10, padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "white", fontSize: 12, fontWeight: 600 }}><Icon type="ai" size={16} color="white"/> AI Analysis</button>
          }/>
          <div style={{ padding: 20 }}>
            <div style={{ background: "white", borderRadius: 16, padding: 16, boxShadow: theme.shadow, marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div><div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>{report.labName}</div><div style={{ fontSize: 13, color: theme.textSecondary, marginTop: 2 }}>Patient: {patient?.name || "Unknown"}</div><div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 1 }}>Tested: {formatTestDate(report.date)} \u00b7 Uploaded: {report.uploadedAt}</div></div>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: theme.primary + "12", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon type="file" size={22} color={theme.primary}/></div>
              </div>
              {/* Original report actions */}
              {report.fileData && (
                <div style={{ display: "flex", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid " + theme.border }}>
                  <button onClick={() => setShowReportViewer(true)} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 12px", background: theme.primary + "10", border: "1px solid " + theme.primary + "30", borderRadius: 12, cursor: "pointer", color: theme.primary, fontSize: 13, fontWeight: 600 }}>
                    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    View Original
                  </button>
                  <button onClick={() => {
                    const a = document.createElement("a");
                    a.href = report.fileData;
                    a.download = report.fileName || "report";
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                  }} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 12px", background: theme.accent + "10", border: "1px solid " + theme.accent + "30", borderRadius: 12, cursor: "pointer", color: "#1B5E20", fontSize: 13, fontWeight: 600 }}>
                    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    Download
                  </button>
                </div>
              )}
              {!report.fileData && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid " + theme.border }}>
                  <p style={{ margin: 0, fontSize: 12, color: theme.textSecondary, fontStyle: "italic" }}>{report.fileName} — original file not available (uploaded before file storage was enabled)</p>
                </div>
              )}
            </div>
            {selectedTest ? (
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: theme.text, margin: "0 0 12px" }}>{selectedTest} - Trend</h3>
                <div style={{ background: "white", borderRadius: 16, padding: 16, boxShadow: theme.shadow, marginBottom: 16 }}>
                  {(() => { const td = getTestTrend(report.patientId, selectedTest); const nt = getNumericTrend(td); const af = nt.map(d => getAbnormalStatus(d)); return td.length >= 1 ? (<>
                    {nt.length >= 2 && <MiniTrendChart data={nt} color={theme.primary} height={120} abnormalFlags={af}/>}
                    <div style={{ marginTop: 12 }}>{[...td].reverse().map((d, i) => {
                      const isAbn = getAbnormalStatus(d);
                      return (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid " + theme.border }}>
                        <span style={{ fontSize: 12, color: i === 0 ? theme.text : theme.textSecondary, fontWeight: i === 0 ? 600 : 400, display: "flex", alignItems: "center", gap: 6 }}>
                          {d.label}
                          {i === 0 && <span style={{ fontSize: 9, fontWeight: 700, color: theme.primary, background: theme.primary + "15", padding: "1px 5px", borderRadius: 4 }}>LATEST</span>}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: isAbn ? "#E53935" : theme.text }}>{d.rawValue || d.value} {d.unit}</span>
                      </div>);
                    })}</div>
                  </>) : <p style={{ fontSize: 13, color: theme.textSecondary, textAlign: "center", padding: 20 }}>Upload more reports for this patient to see trends.</p>; })()}
                </div>
                <button onClick={() => setSelectedTest(null)} style={{ width: "100%", padding: 14, background: theme.primary, color: "white", border: "none", borderRadius: 14, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Back to All Results</button>
              </div>
            ) : (<>
              {/* Clinical note detail view */}
              {report.reportType === "clinical_note" && report.visit ? (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={theme.primary} strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: theme.text, margin: 0 }}>{report.visit.visitType === "IP" ? "Discharge Summary" : "Outpatient Note"}</h3>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 8, background: report.visit.visitType === "IP" ? "#E8F5E9" : "#E3F2FD", color: report.visit.visitType === "IP" ? "#2E7D32" : "#1565C0", fontWeight: 600 }}>{report.visit.visitType || "OP"}</span>
                  </div>
                  {report.visit.summary && (
                    <div style={{ background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Summary</div>
                      <div style={{ fontSize: 13, color: theme.text, lineHeight: 1.6 }}>{report.visit.summary}</div>
                    </div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                    {[
                      { label: "Hospital", val: report.visit.hospital },
                      { label: "Department", val: report.visit.department },
                      { label: "Doctor", val: report.visit.doctor },
                      { label: "Visit Type", val: report.visit.visitType === "IP" ? "Inpatient" : "Outpatient" },
                      { label: report.visit.visitType === "IP" ? "Admitted" : "Visit Date", val: report.visit.admissionDate || report.visit.visitDate },
                      { label: "Discharged", val: report.visit.dischargeDate },
                    ].filter(x => x.val).map((item, i) => (
                      <div key={i} style={{ background: "white", borderRadius: 10, padding: "10px 12px", boxShadow: theme.shadow }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: theme.textSecondary, textTransform: "uppercase", marginBottom: 3 }}>{item.label}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{item.val}</div>
                      </div>
                    ))}
                  </div>
                  {report.visit.diagnoses?.length > 0 && (
                    <div style={{ background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary, marginBottom: 8, textTransform: "uppercase" }}>Diagnoses</div>
                      {report.visit.diagnoses.map((d, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, padding: "7px 10px", background: i === 0 ? "#FFF3E0" : theme.bg, borderRadius: 8, marginBottom: 6, borderLeft: "3px solid " + (i === 0 ? "#E65100" : theme.border) }}>
                          <span style={{ fontSize: 13, color: i === 0 ? "#E65100" : theme.text, fontWeight: i === 0 ? 600 : 400 }}>{i === 0 ? "Primary: " : "◦ "}{d}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {report.visit.vitals && Object.values(report.visit.vitals).some(v => v) && (
                    <div style={{ background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary, marginBottom: 8, textTransform: "uppercase" }}>Vitals</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {[["BP", report.visit.vitals.bp], ["Pulse", report.visit.vitals.pulse], ["Temp", report.visit.vitals.temp], ["SpO2", report.visit.vitals.spo2], ["Weight", report.visit.vitals.weight], ["Height", report.visit.vitals.height], ["RR", report.visit.vitals.rr]].filter(([, v]) => v).map(([label, val], i) => (
                          <div key={i} style={{ padding: "6px 12px", background: theme.bg, borderRadius: 20, fontSize: 12 }}>
                            <span style={{ color: theme.textSecondary, fontWeight: 600 }}>{label}: </span><span style={{ color: theme.text, fontWeight: 700 }}>{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {report.visit.medications?.length > 0 && (
                    <div style={{ background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary, marginBottom: 8, textTransform: "uppercase" }}>Medications ({report.visit.medications.length})</div>
                      {report.visit.medications.map((m, i) => (
                        <div key={i} style={{ padding: "8px 0", borderBottom: i < report.visit.medications.length - 1 ? "1px solid " + theme.border : "none" }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{m.name}{m.dose ? " — " + m.dose : ""}</div>
                          {(m.frequency || m.duration || m.route) && <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>{[m.frequency, m.duration, m.route].filter(Boolean).join(" · ")}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {report.visit.procedures?.length > 0 && (
                    <div style={{ background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary, marginBottom: 8, textTransform: "uppercase" }}>Procedures</div>
                      {report.visit.procedures.map((p, i) => <div key={i} style={{ fontSize: 13, color: theme.text, padding: "4px 0" }}>• {p}</div>)}
                    </div>
                  )}
                  {report.visit.followUp && (
                    <div style={{ background: "#E8F5E9", borderRadius: 12, padding: "12px 14px", borderLeft: "4px solid #2E7D32" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#2E7D32", marginBottom: 4, textTransform: "uppercase" }}>Follow-up Instructions</div>
                      <div style={{ fontSize: 13, color: "#1B5E20", lineHeight: 1.5 }}>{report.visit.followUp}</div>
                    </div>
                  )}
                </div>
              ) : report.reportType === "imaging" && report.imaging ? (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={theme.primary} strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: theme.text, margin: 0 }}>{report.imaging.modality || "Imaging"} Report</h3>
                    {report.imaging.bodyPart && <span style={{ fontSize: 12, color: theme.textSecondary, background: theme.bg, padding: "2px 8px", borderRadius: 8 }}>{report.imaging.bodyPart}</span>}
                  </div>
                  {report.imaging.clinicalHistory && (
                    <div style={{ background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Clinical History</div>
                      <div style={{ fontSize: 13, color: theme.text, lineHeight: 1.5 }}>{report.imaging.clinicalHistory}</div>
                    </div>
                  )}
                  {report.imaging.abnormalFindings?.length > 0 && (
                    <div style={{ background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, marginBottom: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#C62828", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 4, background: "#E53935" }}/> Abnormal Findings ({report.imaging.abnormalFindings.length})
                      </div>
                      {report.imaging.abnormalFindings.map((f, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, padding: "8px 12px", background: "#FFEBEE", borderRadius: 10, marginBottom: 6, borderLeft: "3px solid #E53935" }}>
                          <span style={{ fontSize: 13, color: "#B71C1C", lineHeight: 1.5 }}>• {f}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {report.imaging.normalFindings?.length > 0 && (
                    <div style={{ background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, marginBottom: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#2E7D32", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 4, background: "#4CAF50" }}/> Normal Findings ({report.imaging.normalFindings.length})
                      </div>
                      {report.imaging.normalFindings.map((f, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, padding: "8px 12px", background: "#E8F5E9", borderRadius: 10, marginBottom: 6, borderLeft: "3px solid #4CAF50" }}>
                          <span style={{ fontSize: 13, color: "#1B5E20", lineHeight: 1.5 }}>• {f}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {report.imaging.impression && (
                    <div style={{ background: "#E8EAF6", borderRadius: 12, padding: "12px 14px", boxShadow: theme.shadow, borderLeft: "4px solid #3949AB" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#1A237E", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Radiologist Impression</div>
                      <div style={{ fontSize: 13, color: "#1A237E", lineHeight: 1.6 }}>{report.imaging.impression}</div>
                    </div>
                  )}
                </div>
              ) : (<>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><h3 style={{ fontSize: 16, fontWeight: 700, color: theme.text, margin: 0 }}>Test Results</h3><span style={{ fontSize: 12, color: theme.textSecondary }}>{report.tests.length} tests</span></div>
              {report.tests.length === 0 && <p style={{ textAlign: "center", color: theme.textSecondary, padding: 20 }}>No test results were extracted.</p>}
              
              {/* Grouped display */}
              {(report.testGroups && report.testGroups.length > 0 ? report.testGroups : [{ group: "All Tests", tests: report.tests }]).map((grp, gi) => {
                const groupAbnormal = grp.tests.filter(t => t.status !== "normal").length;
                return (
                  <div key={gi} style={{ marginBottom: 16 }}>
                    {/* Group Header */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "10px 14px", background: "linear-gradient(135deg, " + theme.primary + "10, " + theme.primary + "05)", borderRadius: 12, border: "1px solid " + theme.primary + "20" }}>
                      <div style={{ width: 8, height: 8, borderRadius: 4, background: theme.primary }}/>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: theme.primary }}>{grp.group}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {groupAbnormal > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: theme.warning, background: theme.warning + "15", padding: "2px 8px", borderRadius: 10 }}>{groupAbnormal} alert{groupAbnormal > 1 ? "s" : ""}</span>}
                        <span style={{ fontSize: 11, color: theme.textSecondary }}>{grp.tests.length} tests</span>
                      </div>
                    </div>
                    {/* Tests in this group */}
                    {grp.tests.map((test, idx) => (
                      <div key={idx} onClick={() => setSelectedTest(test.name)} style={{ background: "white", borderRadius: 14, padding: "14px 16px", marginBottom: 8, boxShadow: theme.shadow, cursor: "pointer", borderLeft: "4px solid " + (test.status === "normal" ? theme.accent : test.status === "high" ? theme.warning : theme.primary) }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div><div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{test.name}</div><div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 3 }}>Ref: {test.range} {test.unit}</div></div>
                          <div style={{ textAlign: "right" }}><div style={{ fontSize: 18, fontWeight: 700, color: test.status === "normal" ? theme.text : test.status === "high" ? theme.warning : "#1565C0" }}>{test.value} <span style={{ fontSize: 11, fontWeight: 400, color: theme.textSecondary }}>{test.unit}</span></div><div style={{ marginTop: 4 }}><StatusBadge status={test.status}/></div></div>
                        </div>
                        {(() => { const nt = getNumericTrend(getTestTrend(report.patientId, test.name)); return nt.length > 1 && (
                          <div style={{ marginTop: 10, borderTop: "1px solid " + theme.border, paddingTop: 10 }}>
                            <MiniTrendChart data={nt} color={test.status === "normal" ? theme.accent : theme.warning} height={40} abnormalFlags={nt.map(d => getAbnormalStatus(d))}/>
                            <div style={{ fontSize: 11, color: theme.primary, fontWeight: 600, textAlign: "right", marginTop: 4 }}>Tap for trend</div>
                          </div>
                        ); })()}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>)}
            </>)}
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <div style={{ paddingBottom: 90 }}>
        <Header title="Patients"/>
        <div style={{ padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "white", borderRadius: 14, padding: "10px 16px", boxShadow: theme.shadow, marginBottom: 20 }}>
            <Icon type="search" size={18} color={theme.textSecondary}/>
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search patients..." style={{ border: "none", outline: "none", flex: 1, fontSize: 14, color: theme.text, background: "transparent" }}/>
          </div>
          {filtered.length === 0 && <div style={{ textAlign: "center", padding: 40, color: theme.textSecondary }}><Icon type="users" size={48} color={theme.border}/><p style={{ marginTop: 12 }}>{patients.length === 0 ? "No patients yet. Upload a report to get started!" : "No matching patients found."}</p></div>}
          {filtered.map(p => {
            const pR = getPatientReports(p.id);
            const ab = pR.flatMap(r => r.tests).filter(t => t.status !== "normal").length;
            return (<div key={p.id} onClick={() => setSelectedPatient(p.id)} style={{ background: "white", borderRadius: 18, padding: 18, marginBottom: 12, boxShadow: theme.shadow, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 56, height: 56, borderRadius: 16, background: "linear-gradient(135deg, #D97757, #C4623F)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700, color: "white" }}>{p.avatar}</div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>{p.name}</div><div style={{ fontSize: 13, color: theme.textSecondary, marginTop: 2 }}>{p.age > 0 ? p.age + " yrs" : ""} {p.sex !== "Unknown" ? "- " + p.sex : ""}</div>
                  <div style={{ display: "flex", gap: 12, marginTop: 6 }}><span style={{ fontSize: 12, color: theme.primary, fontWeight: 600 }}>{pR.length} reports</span>{ab > 0 && <span style={{ fontSize: 12, color: theme.warning, fontWeight: 600 }}>{ab} alerts</span>}</div>
                </div><Icon type="chevron" size={20} color={theme.textSecondary}/>
              </div>
            </div>);
          })}
        </div>
      </div>
    );
  };
  const TrendsScreen = () => {
    const [tp, setTp] = useState(patients[0]?.id || "");
    const [selectedGroup, setSelectedGroup] = useState("");
    const [viewMode, setViewMode] = useState("graph"); 
    const scrollRef = useRef(null);
    const scrollGroupBy = (dir) => {
      if (scrollRef.current) scrollRef.current.scrollBy({ left: dir * 160, behavior: "smooth" });
    };
    const groupedTests = {};
    const seenNames = {}; 
    if (tp) {
      reports.filter(r => r.patientId === tp).forEach(r => {
        
        const allTests = [];
        if (r.testGroups?.length > 0) {
          r.testGroups.forEach(g => {
            const gName = g.group || "Others";
            (g.tests || []).forEach(t => { if (t.name) allTests.push({ name: t.name, group: gName }); });
          });
        }
        
        (r.tests || []).forEach(t => {
          if (t.name) {
            const gName = t.group || "Others";
            
            if (!allTests.some(a => testNamesMatch(a.name, t.name))) {
              allTests.push({ name: t.name, group: gName });
            }
          }
        });
        allTests.forEach(({ name, group }) => {
          const key = normalizeTestName(name);
          if (!seenNames[key]) seenNames[key] = name.trim();
          const canonical = seenNames[key];
          if (!groupedTests[group]) groupedTests[group] = new Set();
          groupedTests[group].add(canonical);
        });
      });
    }
    const groupEntries = Object.entries(groupedTests).map(([g, s]) => ({ group: g, tests: [...s] }));
    const activeGroup = selectedGroup && groupedTests[selectedGroup] ? selectedGroup : (groupEntries[0]?.group || "");
    const activeTests = groupEntries.find(g => g.group === activeGroup)?.tests || [];
    const getLatestTest = (pid, testName) => {
      const sorted = reports.filter(r => r.patientId === pid).sort((a, b) => new Date(b.date + "T00:00:00") - new Date(a.date + "T00:00:00"));
      for (const r of sorted) {
        let t = (r.tests || []).find(t => testNamesMatch(t.name, testName));
        if (!t && r.testGroups) {
          for (const g of r.testGroups) {
            t = (g.tests || []).find(t => testNamesMatch(t.name, testName));
            if (t) break;
          }
        }
        if (t) return t;
      }
      return null;
    };
    const groupColors = ["#D97757", "#00C48C", "#FF8C42", "#E040FB", "#FF5252", "#00BCD4", "#8D6E63", "#7C4DFF"];
    const getGroupColor = (idx) => groupColors[idx % groupColors.length];
    return (
      <div style={{ paddingBottom: 90 }}>
        <Header title="Health Trends"/>
        <div style={{ padding: 20 }}>
          {patients.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: theme.textSecondary }}><Icon type="trend" size={48} color={theme.border}/><p style={{ marginTop: 12 }}>Upload reports to see health trends over time.</p></div>
          ) : (<>
            {/* Patient selector */}
            <div style={{ background: "white", borderRadius: 14, padding: 14, boxShadow: theme.shadow, marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: theme.textSecondary, fontWeight: 600, display: "block", marginBottom: 6 }}>Patient</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {patients.map(p => (<button key={p.id} onClick={() => { setTp(p.id); setSelectedGroup(""); }} style={{ padding: "8px 14px", borderRadius: 12, border: "none", cursor: "pointer", background: tp === p.id ? theme.primary : theme.bg, color: tp === p.id ? "white" : theme.text, fontSize: 12, fontWeight: 600 }}>{p.name}</button>))}
              </div>
            </div>
            {/* Group tabs with hover arrows */}
            {groupEntries.length > 0 && (
                <div className="group-scroll-wrap" style={{ position: "relative", marginBottom: 16 }}>
                  <button onClick={() => scrollGroupBy(-1)} className="group-scroll-arrow group-scroll-left" style={{
                    position: "absolute", left: -2, top: "50%", transform: "translateY(-50%)", zIndex: 10,
                    background: "transparent", border: "none", cursor: "pointer", padding: 0,
                    fontSize: 48, color: theme.textSecondary, lineHeight: 1, opacity: 0, transition: "opacity 0.2s",
                  }}>{"\u2039"}</button>
                  <div ref={scrollRef} style={{ display: "flex", gap: 8, overflowX: "auto", padding: "4px 12px", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", msOverflowStyle: "none" }}>
                    {groupEntries.map((ge, gi) => {
                      const isActive = ge.group === activeGroup;
                      const gColor = getGroupColor(gi);
                      const abnormalCount = ge.tests.reduce((c, tn) => { const t = getLatestTest(tp, tn); return c + (t && t.status !== "normal" ? 1 : 0); }, 0);
                      return (
                        <button key={gi} onClick={() => { setSelectedGroup(ge.group); }} style={{
                          flexShrink: 0, padding: "10px 16px", borderRadius: 14, border: isActive ? "2px solid " + gColor : "2px solid " + theme.border,
                          background: isActive ? gColor + "12" : "white", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, minWidth: 120,
                          boxShadow: isActive ? "0 2px 8px " + gColor + "25" : theme.shadow,
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                            <div style={{ width: 8, height: 8, borderRadius: 4, background: gColor, flexShrink: 0 }}/>
                            <span style={{ fontSize: 13, fontWeight: 700, color: isActive ? gColor : theme.text, whiteSpace: "nowrap" }}>{ge.group}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, color: theme.textSecondary }}>{ge.tests.length} tests</span>
                            {abnormalCount > 0 && <span style={{ fontSize: 10, fontWeight: 600, color: theme.warning, background: theme.warning + "15", padding: "1px 6px", borderRadius: 8 }}>{abnormalCount} alert{abnormalCount > 1 ? "s" : ""}</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <button onClick={() => scrollGroupBy(1)} className="group-scroll-arrow group-scroll-right" style={{
                    position: "absolute", right: -2, top: "50%", transform: "translateY(-50%)", zIndex: 10,
                    background: "transparent", border: "none", cursor: "pointer", padding: 0,
                    fontSize: 48, color: theme.textSecondary, lineHeight: 1, opacity: 0, transition: "opacity 0.2s",
                  }}>{"\u203A"}</button>
                </div>
            )}
            {/* All tests in selected group */}
            {activeTests.length > 0 && (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 5, background: getGroupColor(groupEntries.findIndex(g => g.group === activeGroup)) }}/>
                    <h3 style={{ fontSize: 17, fontWeight: 700, color: theme.text, margin: 0 }}>{activeGroup}</h3>
                    <span style={{ fontSize: 12, color: theme.textSecondary }}>{activeTests.length} tests</span>
                  </div>
                  {/* View toggle */}
                  <div style={{ display: "flex", background: theme.bg, borderRadius: 10, padding: 2 }}>
                    {[{ key: "graph", icon: "chart" }, { key: "table", icon: "list" }].map(v => (
                      <button key={v.key} onClick={() => setViewMode(v.key)} style={{
                        padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                        background: viewMode === v.key ? "white" : "transparent",
                        boxShadow: viewMode === v.key ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
                        display: "flex", alignItems: "center", gap: 4,
                        fontSize: 12, fontWeight: 600, color: viewMode === v.key ? theme.primary : theme.textSecondary,
                      }}>
                        <Icon type={v.icon} size={14} color={viewMode === v.key ? theme.primary : theme.textSecondary}/>
                        {v.key === "graph" ? "Graph" : "Table"}
                      </button>
                    ))}
                  </div>
                </div>
                {/* ===== TABLE VIEW ===== */}
                {viewMode === "table" && (() => {
                  
                  const allDates = [...new Set(reports.filter(r => r.patientId === tp).map(r => {
                    const n = normalizeDate(r.date);
                    return n || r.date;
                  }))].sort((a, b) => new Date(b + "T00:00:00") - new Date(a + "T00:00:00"));
                  const shortDate = (d) => { try { return new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }); } catch(e) { return d; } };
                  return (
                  <div style={{ background: "white", borderRadius: 16, boxShadow: theme.shadow, overflow: "hidden" }}>
                    {/* Horizontally scrollable table */}
                    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                      <table style={{ width: "100%", minWidth: Math.max(360, 140 + allDates.length * 72), borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ background: theme.bg }}>
                            <th style={{ position: "sticky", left: 0, background: theme.bg, zIndex: 2, padding: "10px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: theme.textSecondary, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid " + theme.border, minWidth: 120 }}>Test</th>
                            <th style={{ padding: "10px 8px", textAlign: "center", fontSize: 10, fontWeight: 700, color: theme.textSecondary, textTransform: "uppercase", borderBottom: "1px solid " + theme.border, minWidth: 50 }}>Ref</th>
                            {allDates.map((d, di) => (
                              <th key={di} style={{ padding: "10px 8px", textAlign: "center", fontSize: 10, fontWeight: 700, color: di === 0 ? theme.primary : theme.textSecondary, borderBottom: "1px solid " + theme.border, minWidth: 62, whiteSpace: "nowrap" }}>
                                {shortDate(d)}
                                {di === 0 && <div style={{ fontSize: 8, color: theme.primary, fontWeight: 700 }}>LATEST</div>}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {activeTests.map((testName, ti) => {
                            const trendData = getTestTrend(tp, testName);
                            const latest = getLatestTest(tp, testName);
                            
                            const dateMap = {};
                            trendData.forEach(d => {
                              const nd = normalizeDate(d.date) || d.date;
                              dateMap[nd] = d;
                            });
                            return (
                              <tr key={ti} style={{ borderBottom: ti < activeTests.length - 1 ? "1px solid " + theme.border : "none" }}>
                                <td style={{ position: "sticky", left: 0, background: "white", zIndex: 1, padding: "10px 12px", fontSize: 13, fontWeight: 600, color: theme.text }}>
                                  {testName}
                                </td>
                                <td style={{ padding: "10px 8px", textAlign: "center", fontSize: 10, color: theme.textSecondary, whiteSpace: "nowrap" }}>{latest?.range || "N/A"}</td>
                                {allDates.map((d, di) => {
                                  const entry = dateMap[d];
                                  if (!entry) return <td key={di} style={{ padding: "10px 8px", textAlign: "center", fontSize: 12, color: theme.border }}>-</td>;
                                  const isAbn = getAbnormalStatus(entry);
                                  return (
                                    <td key={di} style={{ padding: "10px 8px", textAlign: "center", fontSize: 13, fontWeight: di === 0 ? 700 : 600, color: isAbn ? "#E53935" : theme.text }}>
                                      {entry.rawValue || entry.value}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  );
                })()}
                {/* ===== GRAPH VIEW ===== */}
                {viewMode === "graph" && activeTests.map((testName, ti) => {
                  const trendData = getTestTrend(tp, testName);
                  const numericTrend = getNumericTrend(trendData);
                  const latest = getLatestTest(tp, testName);
                  const gColorIdx = groupEntries.findIndex(g => g.group === activeGroup);
                  const gColor = getGroupColor(gColorIdx >= 0 ? gColorIdx : 0);
                  const latestAbn = trendData.length > 0 && getAbnormalStatus(trendData[trendData.length - 1]);
                  const prevTrend = numericTrend.length >= 2 ? numericTrend[numericTrend.length - 1].value - numericTrend[numericTrend.length - 2].value : null;
                  const abnormalFlags = numericTrend.map(d => getAbnormalStatus(d));
                  return (
                    <div key={ti} style={{
                      background: "white", borderRadius: 16, marginBottom: 12, boxShadow: theme.shadow, overflow: "hidden",
                      borderLeft: "4px solid " + (latestAbn ? "#E53935" : theme.accent),
                    }}>
                      {/* Test header */}
                      <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{testName}</div>
                          {latest && <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>Ref: {latest.range} {latest.unit}</div>}
                        </div>
                        {latest && (
                          <div style={{ textAlign: "right" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                              <span style={{ fontSize: 18, fontWeight: 700, color: latestAbn ? "#E53935" : theme.text }}>
                                {latest.value}
                              </span>
                              <span style={{ fontSize: 11, fontWeight: 400, color: theme.textSecondary }}>{latest.unit}</span>
                              {prevTrend !== null && prevTrend !== 0 && (
                                <span style={{ fontSize: 14, fontWeight: 700, color: latestAbn ? "#E53935" : prevTrend > 0 ? theme.warning : theme.accent }}>
                                  {prevTrend > 0 ? "\u2191" : "\u2193"}
                                </span>
                              )}
                            </div>
                            <StatusBadge status={latestAbn ? (latest.status === "low" ? "low" : "high") : "normal"}/>
                          </div>
                        )}
                      </div>
                      {/* Chart + date details */}
                      {trendData.length >= 1 && (
                        <div style={{ padding: "0 16px 14px" }}>
                          {numericTrend.length >= 2 && (
                            <MiniTrendChart data={numericTrend} color={gColor} height={100} abnormalFlags={abnormalFlags}/>
                          )}
                          <div style={{ marginTop: numericTrend.length >= 2 ? 10 : 0 }}>
                            {[...trendData].reverse().map((d, i, arr) => {
                              const origIdx = trendData.length - 1 - i;
                              const prev = origIdx > 0 ? trendData[origIdx - 1] : null;
                              const isAbn = getAbnormalStatus(d);
                              return (
                                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < arr.length - 1 ? "1px solid " + theme.border : "none" }}>
                                  <span style={{ fontSize: 12, color: i === 0 ? theme.text : theme.textSecondary, fontWeight: i === 0 ? 600 : 400, display: "flex", alignItems: "center", gap: 6 }}>
                                    {d.label}
                                    {i === 0 && <span style={{ fontSize: 9, fontWeight: 700, color: theme.primary, background: theme.primary + "15", padding: "1px 5px", borderRadius: 4 }}>LATEST</span>}
                                  </span>
                                  <span style={{ fontSize: 14, fontWeight: 700, color: isAbn ? "#E53935" : theme.text, display: "flex", alignItems: "center", gap: 6 }}>
                                    {d.rawValue || d.value} {d.unit && <span style={{ fontSize: 11, fontWeight: 400, color: isAbn ? "#E5393590" : theme.textSecondary }}>{d.unit}</span>}
                                    {prev && d.numeric && prev.numeric && (
                                      <span style={{ fontSize: 11, fontWeight: 600, color: isAbn ? "#E53935" : d.value > prev.value ? theme.warning : d.value < prev.value ? theme.accent : theme.textSecondary }}>
                                        {d.value > prev.value ? "\u2191" : d.value < prev.value ? "\u2193" : "="} {Math.abs(d.value - prev.value).toFixed(1)}
                                      </span>
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          {trendData.length === 1 && (
                            <p style={{ margin: "6px 0 0", fontSize: 11, color: theme.textSecondary, fontStyle: "italic" }}>Upload more reports to see trend</p>
                          )}
                        </div>
                      )}
                      {trendData.length === 0 && !latest && (
                        <div style={{ padding: "0 16px 12px" }}>
                          <p style={{ margin: 0, fontSize: 11, color: theme.textSecondary, fontStyle: "italic" }}>No data available</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {groupEntries.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: theme.textSecondary }}>
                <Icon type="chart" size={48} color={theme.border}/>
                <p style={{ marginTop: 12, fontSize: 14 }}>No test data available for this patient.</p>
              </div>
            )}
          </>)}
        </div>
      </div>
    );
  };
  const ResultTreeScreen = () => {
    const [tp, setTp] = useState(patients[0]?.id || "");
    const [expandedGroups, setExpandedGroups] = useState({});
    const [hoverInfo, setHoverInfo] = useState(null); 
    const patientReports = tp ? reports.filter(r => r.patientId === tp).sort((a, b) => {
      const da = normalizeDate(a.date), db = normalizeDate(b.date);
      return new Date((db || "1970-01-01") + "T00:00:00") - new Date((da || "1970-01-01") + "T00:00:00");
    }) : [];
    const allDates = [];
    const dateSet = new Set();
    patientReports.forEach(r => {
      const nd = normalizeDate(r.date) || r.date;
      if (!dateSet.has(nd)) { dateSet.add(nd); allDates.push(nd); }
    });
    const groupedTests = {};
    const seenNames = {};
    patientReports.forEach(r => {
      const allTests = [];
      if (r.testGroups?.length > 0) {
        r.testGroups.forEach(g => {
          (g.tests || []).forEach(t => { if (t.name) allTests.push({ name: t.name, group: g.group || "Others" }); });
        });
      }
      (r.tests || []).forEach(t => {
        if (t.name && !allTests.some(a => testNamesMatch(a.name, t.name))) {
          allTests.push({ name: t.name, group: t.group || "Others" });
        }
      });
      allTests.forEach(({ name, group }) => {
        const key = normalizeTestName(name);
        if (!seenNames[key]) seenNames[key] = name.trim();
        if (!groupedTests[group]) groupedTests[group] = new Set();
        groupedTests[group].add(seenNames[key]);
      });
    });
    const groupEntries = Object.entries(groupedTests).map(([g, s]) => ({ group: g, tests: [...s] }));
    if (groupEntries.length > 0 && Object.keys(expandedGroups).length === 0) {
      const init = {}; groupEntries.forEach(g => init[g.group] = true);
      
    }
    const isExpanded = (g) => expandedGroups[g] !== false; 
    const toggleGroup = (g) => setExpandedGroups(prev => ({ ...prev, [g]: !isExpanded(g) }));
    const getValueAtDate = (testName, dateStr) => {
      for (const r of patientReports) {
        const nd = normalizeDate(r.date) || r.date;
        if (nd !== dateStr) continue;
        let t = (r.tests || []).find(t => testNamesMatch(t.name, testName));
        if (!t && r.testGroups) {
          for (const g of r.testGroups) {
            t = (g.tests || []).find(t => testNamesMatch(t.name, testName));
            if (t) break;
          }
        }
        if (t) return t;
      }
      return null;
    };
    const shortDate = (d) => {
      try { return new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" }); }
      catch(e) { return d; }
    };
    const groupColors = ["#D97757", "#00C48C", "#FF8C42", "#E040FB", "#FF5252", "#00BCD4", "#8D6E63", "#7C4DFF"];
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        <Header title="Result Tree"/>
        <div style={{ padding: "12px 12px 0", flexShrink: 0 }}>
          {patients.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: theme.textSecondary }}>
              <Icon type="grid" size={48} color={theme.border}/>
              <p style={{ marginTop: 12 }}>Upload reports to see the result tree.</p>
            </div>
          ) : (<>
            {/* Patient selector */}
            <div style={{ background: "white", borderRadius: 14, padding: 12, boxShadow: theme.shadow, marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {patients.map(p => (
                  <button key={p.id} onClick={() => { setTp(p.id); setExpandedGroups({}); }} style={{
                    padding: "7px 14px", borderRadius: 12, border: "none", cursor: "pointer",
                    background: tp === p.id ? theme.primary : theme.bg, color: tp === p.id ? "white" : theme.text,
                    fontSize: 12, fontWeight: 600,
                  }}>{p.name}</button>
                ))}
              </div>
            </div>
          </>)}
        </div>
        {patients.length > 0 && allDates.length === 0 && (
          <div style={{ textAlign: "center", padding: 40, color: theme.textSecondary }}>
            <Icon type="grid" size={48} color={theme.border}/>
            <p style={{ marginTop: 12, fontSize: 14 }}>No reports found for this patient.</p>
          </div>
        )}
        {patients.length > 0 && allDates.length > 0 && (
          <div style={{ flex: 1, overflow: "hidden", padding: "0 12px 90px" }}>
            <div style={{ background: "white", borderRadius: 16, boxShadow: theme.shadow, overflow: "hidden", height: "100%" }}>
              <div style={{ overflowX: "auto", overflowY: "auto", height: "100%", WebkitOverflowScrolling: "touch" }}>
                <table style={{ width: "100%", minWidth: Math.max(340, 140 + allDates.length * 70), borderCollapse: "collapse" }}>
                    {/* Date headers - sticky on scroll */}
                    <thead>
                      <tr>
                        <th style={{
                          position: "sticky", left: 0, top: 0, zIndex: 4, background: theme.primary,
                          padding: "12px 12px", textAlign: "left", color: "white", fontSize: 12, fontWeight: 700,
                          borderBottom: "2px solid " + theme.primary, minWidth: 130,
                        }}>
                          Test / Date →
                        </th>
                        {allDates.map((d, di) => (
                          <th key={di} style={{
                            position: "sticky", top: 0, zIndex: 3,
                            padding: "8px 6px", textAlign: "center", fontSize: 11, fontWeight: 700,
                            color: "white", background: di === 0 ? "#1565C0" : theme.primary + "CC",
                            borderBottom: "2px solid " + (di === 0 ? "#1565C0" : theme.primary), minWidth: 62, whiteSpace: "nowrap",
                          }}>
                            {shortDate(d)}
                            {di === 0 && <div style={{ fontSize: 8, fontWeight: 700, opacity: 0.9, marginTop: 1, letterSpacing: 0.5 }}>★ LATEST</div>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {groupEntries.map((ge, gi) => {
                        const gColor = groupColors[gi % groupColors.length];
                        const expanded = isExpanded(ge.group);
                        
                        const abnCount = ge.tests.reduce((c, tn) => {
                          const t = allDates.length > 0 ? getValueAtDate(tn, allDates[0]) : null;
                          if (t) { const td = { value: parseFloat(String(t.value).replace(/[<>]/g,"")), range: t.range, status: t.status, numeric: !isNaN(parseFloat(String(t.value).replace(/[<>]/g,""))), }; if (getAbnormalStatus(td)) return c + 1; }
                          return c;
                        }, 0);
                        return (
                          <React.Fragment key={gi}>
                            {/* Group header row */}
                            <tr onClick={() => toggleGroup(ge.group)} style={{ cursor: "pointer", background: gColor + "10" }}>
                              <td colSpan={1 + allDates.length} style={{
                                position: "sticky", left: 0, zIndex: 2, padding: "10px 12px",
                                borderBottom: "1px solid " + theme.border, background: gColor + "10",
                              }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <span style={{ fontSize: 14, fontWeight: 400, color: gColor, transform: expanded ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}>▶</span>
                                  <div style={{ width: 8, height: 8, borderRadius: 4, background: gColor }}/>
                                  <span style={{ fontSize: 14, fontWeight: 700, color: gColor }}>{ge.group}</span>
                                  <span style={{ fontSize: 11, color: theme.textSecondary }}>{ge.tests.length} tests</span>
                                  {abnCount > 0 && <span style={{ fontSize: 10, fontWeight: 600, color: "#E53935", background: "#E5393515", padding: "1px 6px", borderRadius: 8 }}>{abnCount} alert{abnCount > 1 ? "s" : ""}</span>}
                                </div>
                              </td>
                            </tr>
                            {/* Test rows */}
                            {expanded && ge.tests.map((testName, ti) => (
                              <tr key={ti}>
                                <td style={{
                                  position: "sticky", left: 0, zIndex: 1, background: "white",
                                  padding: "8px 12px 8px 32px", fontSize: 12, fontWeight: 600, color: theme.text,
                                  borderBottom: "1px solid " + theme.border, borderLeft: "3px solid " + gColor,
                                }}>
                                  <div>{testName}</div>
                                  {(() => { const lt = allDates.length > 0 ? getValueAtDate(testName, allDates[0]) : null; return lt ? <div style={{ fontSize: 10, color: theme.textSecondary, marginTop: 1 }}>Ref: {lt.range || "N/A"}</div> : null; })()}
                                </td>
                                {allDates.map((dateStr, di) => {
                                  const t = getValueAtDate(testName, dateStr);
                                  if (!t) return <td key={di} style={{ padding: "8px 6px", textAlign: "center", fontSize: 12, color: theme.border, borderBottom: "1px solid " + theme.border }}>-</td>;
                                  const numVal = parseFloat(String(t.value).replace(/[<>]/g, "").trim());
                                  const td = { value: numVal, range: t.range, status: t.status, numeric: !isNaN(numVal) };
                                  const isAbn = getAbnormalStatus(td);
                                  return (
                                    <td key={di}
                                      onMouseEnter={(e) => {
                                        if (t.interpretation) {
                                          const rect = e.currentTarget.getBoundingClientRect();
                                          setHoverInfo({ x: rect.left + rect.width / 2, y: rect.top, test: t });
                                        }
                                      }}
                                      onMouseLeave={() => setHoverInfo(null)}
                                      onClick={(e) => {
                                        if (t.interpretation) {
                                          const rect = e.currentTarget.getBoundingClientRect();
                                          setHoverInfo(prev => prev?.test === t ? null : { x: rect.left + rect.width / 2, y: rect.top, test: t });
                                        }
                                      }}
                                      style={{
                                        padding: "8px 6px", textAlign: "center", fontSize: 13,
                                        fontWeight: di === 0 ? 700 : 500,
                                        color: isAbn ? "#E53935" : di === 0 ? "#1565C0" : theme.text,
                                        background: isAbn ? "#E5393508" : di === 0 ? "#E3F2FD" : "transparent",
                                        borderBottom: "1px solid " + theme.border,
                                        cursor: t.interpretation ? "pointer" : "default",
                                        textDecoration: t.interpretation ? "underline dotted" : "none",
                                        textDecorationColor: t.interpretation ? (isAbn ? "#E5393560" : theme.textSecondary) : "transparent",
                                        textUnderlineOffset: 3,
                                      }}>
                                      {t.value}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        {/* Interpretation tooltip */}
        {hoverInfo && hoverInfo.test?.interpretation && (
          <div style={{
            position: "fixed", zIndex: 200,
            left: Math.min(Math.max(hoverInfo.x, 120), window.innerWidth - 120),
            top: Math.max(hoverInfo.y - 10, 60),
            transform: "translate(-50%, -100%)",
            background: "#1A2138", color: "white",
            borderRadius: 12, padding: "10px 14px",
            maxWidth: 260, minWidth: 140,
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
            pointerEvents: "none",
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: hoverInfo.test.status === "normal" ? "#66BB6A" : hoverInfo.test.status === "high" ? "#FFB74D" : "#64B5F6", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              <span>{hoverInfo.test.name}</span>
              <span style={{ fontSize: 10, opacity: 0.7 }}>({hoverInfo.test.value} {hoverInfo.test.unit})</span>
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.85)", lineHeight: 1.5 }}>
              {(() => {
                const txt = hoverInfo.test.interpretation || "";
                const srcMatch = txt.match(/\(Source:\s*([^)]+)\)/i);
                const mainText = txt.replace(/\s*\(Source:\s*[^)]+\)/i, "").trim();
                return (<>
                  {mainText}
                  {srcMatch && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", marginTop: 4, fontStyle: "italic" }}>Source: {srcMatch[1]}</div>}
                </>);
              })()}
            </div>
            <div style={{ position: "absolute", bottom: -6, left: "50%", transform: "translateX(-50%)", width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "6px solid #1A2138" }}/>
          </div>
        )}
      </div>
    );
  };
  const SettingsScreen = () => (
    <div style={{ paddingBottom: 90 }}>
      <Header title="Settings"/>
      <div style={{ padding: 20 }}>
        <div style={{ background: "white", borderRadius: 18, boxShadow: theme.shadow, overflow: "hidden" }}>
          {[{ label: "App Name", value: "My Health Plus", desc: "Customizable" }, { label: "AI Engine", value: "Claude Sonnet", desc: "For extraction & analysis" }, { label: "Formats", value: "PDF, DOCX, JPG, PNG", desc: "Supported uploads" }, { label: "PDF Reader", value: "pdf.js", desc: "Text extraction from PDFs" }, { label: "Doc Reader", value: "Mammoth.js", desc: "Word document support" }, { label: "Image OCR", value: "Claude Vision API", desc: "Image-based reports" }, { label: "Platform", value: "iOS & Android", desc: "Cross-platform ready" }].map((item, i, arr) => (
            <div key={i} style={{ padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < arr.length - 1 ? "1px solid " + theme.border : "none" }}>
              <div><div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{item.label}</div><div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{item.desc}</div></div>
              <div style={{ fontSize: 13, color: theme.primary, fontWeight: 500, textAlign: "right", maxWidth: "45%" }}>{item.value}</div>
            </div>
          ))}
        </div>
        <div style={{ background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 14, padding: 16, marginTop: 20, textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 13, color: "#5D4037", fontWeight: 600, marginBottom: 6 }}>Medical Disclaimer</p>
          <p style={{ margin: 0, fontSize: 12, color: "#5D4037", lineHeight: 1.6 }}>This app uses AI for informational purposes only. Always consult a qualified physician for diagnosis and treatment.</p>
        </div>
      </div>
    </div>
  );
  const AnalysisModal = () => {
    const report = reports.find(r => r.id === showAnalysis);
    if (!report) return null;
    const abnormalTests = report.tests.filter(t => t.status !== "normal");
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }} onClick={(e) => { if (e.target === e.currentTarget) setShowAnalysis(null); }}>
        <div style={{ background: "white", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, padding: "24px 24px 40px", maxHeight: "80vh", overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 40, height: 40, borderRadius: 12, background: "linear-gradient(135deg, #D97757, #C4623F)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon type="ai" size={22} color="white"/></div>
              <div><h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: theme.text }}>AI Analysis</h3><p style={{ margin: 0, fontSize: 12, color: theme.textSecondary }}>Powered by Claude</p></div>
            </div>
            <button onClick={() => setShowAnalysis(null)} style={{ background: theme.bg, border: "none", borderRadius: 10, padding: 6, cursor: "pointer" }}><Icon type="close" size={18} color={theme.textSecondary}/></button>
          </div>
          {analysisLoading ? (
            <div style={{ textAlign: "center", padding: "30px 0" }}>
              <div style={{ width: 60, height: 60, borderRadius: 30, background: theme.primary + "10", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", animation: "pulse 1.5s ease-in-out infinite" }}><Icon type="ai" size={28} color={theme.primary}/></div>
              <p style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>Generating AI analysis...</p>
              <p style={{ fontSize: 12, color: theme.textSecondary }}>Reviewing {report.tests.length} test results</p>
            </div>
          ) : analysisData ? (<>
            {/* Summary pill */}
            <div style={{ background: "linear-gradient(135deg, #D97757, #C4623F)", borderRadius: 14, padding: "14px 16px", marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 13, color: "rgba(255,255,255,0.85)", lineHeight: 1.6 }}>{analysisData.summary}</p>
            </div>
            {/* Sections */}
            {(analysisData.sections || []).map((section, si) => {
              const iconMap = {
                findings: { icon: "trend", bg: "#E8F4FD", color: "#1565C0" },
                warning:  { icon: "alert", bg: "#FFF3E0", color: "#E65100" },
                check:    { icon: "check", bg: "#E8F5E9", color: "#2E7D32" },
                recommend:{ icon: "ai",    bg: "#F3E5F5", color: "#7B1FA2" },
              };
              const style = iconMap[section.icon] || iconMap.findings;
              return (
                <div key={si} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: style.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon type={style.icon} size={14} color={style.color}/>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>{section.title}</span>
                  </div>
                  <div style={{ paddingLeft: 4 }}>
                    {(section.points || []).map((point, pi) => (
                      <div key={pi} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "7px 12px", background: style.bg + "88", borderRadius: 10, marginBottom: 6, borderLeft: "3px solid " + style.color + "55" }}>
                        <span style={{ color: style.color, fontSize: 16, lineHeight: 1, marginTop: 1, flexShrink: 0 }}>•</span>
                        <span style={{ fontSize: 13, color: theme.text, lineHeight: 1.5 }}>{point}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>) : (
            <div style={{ textAlign: "center", padding: "20px 0", color: theme.textSecondary, fontSize: 13 }}>
              Analysis could not be generated. Please try again.
            </div>
          )}
          <div style={{ background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 14, padding: 14 }}>
            <div style={{ display: "flex", gap: 10 }}><Icon type="alert" size={20} color="#F9A825"/>
              <div><p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#5D4037", marginBottom: 4 }}>Important Notice</p><p style={{ margin: 0, fontSize: 12, color: "#5D4037", lineHeight: 1.5 }}>This AI analysis is for informational purposes only and does not constitute medical advice. Please consult your physician for proper diagnosis and treatment.</p></div>
            </div>
          </div>
        </div>
      </div>
    );
  };
  return (
    <div style={pageStyle}>
      <style>{`
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes loading { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { width: 0; height: 0; }
        .group-scroll-wrap:hover .group-scroll-arrow { opacity: 0.6 !important; }
        .group-scroll-arrow:hover { opacity: 1 !important; }
        body { margin: 0; padding: 0; background: ${theme.bg}; }
      `}</style>
      {activeTab === "home" && <HomeScreen/>}
      {activeTab === "patients" && <PatientsScreen/>}
      {activeTab === "trends" && <TrendsScreen/>}
      {activeTab === "results" && <ResultTreeScreen/>}
      <BottomNav/>
      {showUpload && UploadModal()}
      {showAnalysis && AnalysisModal()}
      {showSettings && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }} onClick={(e) => { if (e.target === e.currentTarget) { setShowSettings(false); setEditingPatient(null); setEditingReport(null); }}}>
          <div style={{ background: "white", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, padding: "20px 20px 36px", maxHeight: "88vh", overflowY: "auto", animation: "slideUp 0.3s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: theme.text }}>Settings</h3>
              <button onClick={() => { setShowSettings(false); setEditingPatient(null); setEditingReport(null); }} style={{ background: theme.bg, border: "none", borderRadius: 10, padding: 6, cursor: "pointer" }}><Icon type="close" size={18} color={theme.textSecondary}/></button>
            </div>
            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, marginBottom: 16, background: theme.bg, borderRadius: 12, padding: 4 }}>
              {[{ id: "patients", label: "Demographics" }, { id: "labs", label: "Lab Data" }, { id: "info", label: "App Info" }].map(t => (
                <button key={t.id} onClick={() => { setSettingsTab(t.id); setEditingPatient(null); setEditingReport(null); }} style={{ flex: 1, padding: "8px 6px", border: "none", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", background: settingsTab === t.id ? theme.primary : "transparent", color: settingsTab === t.id ? "white" : theme.textSecondary }}>{t.label}</button>
              ))}
            </div>
            {/* DEMOGRAPHICS TAB */}
            {settingsTab === "patients" && !editingPatient && (
              <div>
                <p style={{ fontSize: 12, color: theme.textSecondary, margin: "0 0 12px" }}>Tap a patient to edit their information</p>
                {patients.length === 0 ? <p style={{ textAlign: "center", color: theme.textSecondary, fontSize: 13, padding: 20 }}>No patients yet. Upload a report first.</p> : patients.map(p => (
                  <div key={p.id} onClick={() => setEditingPatient({ ...p })} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: theme.bg, borderRadius: 14, marginBottom: 8, cursor: "pointer" }}>
                    <div style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(135deg, #D97757, #C4623F)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "white", flexShrink: 0 }}>{p.avatar}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{p.name}</div>
                      <div style={{ fontSize: 12, color: theme.textSecondary }}>{p.age > 0 ? p.age + " yrs" : "Age N/A"} · {p.sex} · {reports.filter(r => r.patientId === p.id).length} reports</div>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={theme.textSecondary} strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
                  </div>
                ))}
              </div>
            )}
            {/* EDIT PATIENT FORM */}
            {settingsTab === "patients" && editingPatient && (
              <div>
                <button onClick={() => setEditingPatient(null)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontSize: 13, color: theme.primary, fontWeight: 600, marginBottom: 14, padding: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg> Back to list
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
                  <div style={{ width: 50, height: 50, borderRadius: 14, background: "linear-gradient(135deg, #D97757, #C4623F)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: "white" }}>{editingPatient.avatar}</div>
                  <div><div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>Edit Patient</div><div style={{ fontSize: 12, color: theme.textSecondary }}>Update demographics</div></div>
                </div>
                {[
                  { key: "name", label: "Full Name", type: "text" },
                  { key: "age", label: "Age", type: "number" },
                  { key: "sex", label: "Sex", type: "select", options: ["Male", "Female", "Other", "Unknown"] },
                  { key: "phone", label: "Phone", type: "tel" },
                  { key: "address", label: "Address", type: "text" },
                  { key: "dateOfBirth", label: "Date of Birth", type: "text" },
                  { key: "referredBy", label: "Referred By", type: "text" },
                ].map(field => (
                  <div key={field.key} style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: theme.textSecondary, marginBottom: 4, display: "block" }}>{field.label}</label>
                    {field.type === "select" ? (
                      <select value={editingPatient[field.key] || ""} onChange={e => setEditingPatient(prev => ({ ...prev, [field.key]: e.target.value }))} style={{ width: "100%", padding: "10px 12px", border: "1.5px solid " + theme.border, borderRadius: 10, fontSize: 14, background: "white", color: theme.text, outline: "none" }}>
                        {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input value={editingPatient[field.key] || ""} onChange={e => setEditingPatient(prev => ({ ...prev, [field.key]: field.type === "number" ? e.target.value : e.target.value }))} type={field.type} style={{ width: "100%", padding: "10px 12px", border: "1.5px solid " + theme.border, borderRadius: 10, fontSize: 14, color: theme.text, outline: "none" }} placeholder={"Enter " + field.label.toLowerCase()}/>
                    )}
                  </div>
                ))}
                <button onClick={() => {
                  const updated = { ...editingPatient, age: parseInt(editingPatient.age) || 0 };
                  const parts = (updated.name || "").trim().split(/\s+/);
                  updated.avatar = parts.map(n => (n[0] || "").toUpperCase()).join("").slice(0, 2) || "??";
                  setPatients(prev => prev.map(p => p.id === updated.id ? updated : p));
                  setEditingPatient(null);
                }} style={{ width: "100%", padding: "13px", background: "linear-gradient(135deg, #D97757, #C4623F)", color: "white", border: "none", borderRadius: 14, fontSize: 15, fontWeight: 700, cursor: "pointer", marginTop: 6 }}>Save Changes</button>
              </div>
            )}
            {/* LAB DATA TAB */}
            {settingsTab === "labs" && !editingReport && (
              <div>
                <p style={{ fontSize: 12, color: theme.textSecondary, margin: "0 0 12px" }}>Tap a report to edit test results & reference ranges</p>
                {reports.length === 0 ? <p style={{ textAlign: "center", color: theme.textSecondary, fontSize: 13, padding: 20 }}>No reports yet. Upload a report first.</p> : reports.map(r => {
                  const p = patients.find(pt => pt.id === r.patientId);
                  const abnCount = r.tests.filter(t => t.status !== "normal").length;
                  return (
                    <div key={r.id} onClick={() => { setEditingReport(r.id); setEditingTests(r.tests.map(t => ({ ...t }))); }} style={{ padding: "12px 14px", background: theme.bg, borderRadius: 14, marginBottom: 8, cursor: "pointer" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{r.labName}</div>
                          <div style={{ fontSize: 12, color: theme.textSecondary }}>{p?.name || "Unknown"} · {formatTestDate(r.date)}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: theme.textSecondary, background: theme.border, padding: "3px 8px", borderRadius: 8 }}>{r.tests.length} tests</span>
                          {abnCount > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: "#E65100", background: "#FFF3E0", padding: "3px 8px", borderRadius: 8 }}>{abnCount} abnormal</span>}
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={theme.textSecondary} strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* EDIT TESTS FOR A REPORT */}
            {settingsTab === "labs" && editingReport && (
              <div>
                <button onClick={() => { setEditingReport(null); setEditingTests([]); }} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontSize: 13, color: theme.primary, fontWeight: 600, marginBottom: 14, padding: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg> Back to reports
                </button>
                {(() => {
                  const rep = reports.find(r => r.id === editingReport);
                  const pat = patients.find(p => p.id === rep?.patientId);
                  if (!rep) return null;
                  const groups = [...new Set(editingTests.map(t => t.group))];
                  return (
                    <div>
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>{rep.labName}</div>
                        <div style={{ fontSize: 12, color: theme.textSecondary }}>{pat?.name} · {formatTestDate(rep.date)} · {editingTests.length} tests</div>
                      </div>
                      {groups.map(g => (
                        <div key={g} style={{ marginBottom: 16 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: theme.primary, marginBottom: 8, padding: "6px 10px", background: theme.primary + "10", borderRadius: 8 }}>{g}</div>
                          {editingTests.filter(t => t.group === g).map((test, ti) => {
                            const idx = editingTests.indexOf(test);
                            return (
                              <div key={idx} style={{ background: theme.bg, borderRadius: 12, padding: "12px 14px", marginBottom: 6, border: test.status !== "normal" ? "1.5px solid " + (test.status === "high" ? "#FFB74D" : "#64B5F6") : "1px solid " + theme.border }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                  <input value={test.name} onChange={e => { const t = [...editingTests]; t[idx] = { ...t[idx], name: e.target.value }; setEditingTests(t); }} style={{ fontSize: 14, fontWeight: 600, color: theme.text, border: "none", background: "transparent", outline: "none", flex: 1 }} placeholder="Test name"/>
                                  <select value={test.status} onChange={e => { const t = [...editingTests]; t[idx] = { ...t[idx], status: e.target.value }; setEditingTests(t); }} style={{ fontSize: 11, fontWeight: 700, padding: "4px 8px", borderRadius: 8, border: "none", cursor: "pointer", background: test.status === "normal" ? "#E8F5E9" : test.status === "high" ? "#FFF3E0" : "#E3F2FD", color: test.status === "normal" ? "#2E7D32" : test.status === "high" ? "#E65100" : "#1565C0" }}>
                                    <option value="normal">Normal</option>
                                    <option value="high">High</option>
                                    <option value="low">Low</option>
                                  </select>
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.3fr", gap: 8 }}>
                                  <div>
                                    <label style={{ fontSize: 10, fontWeight: 600, color: theme.textSecondary, display: "block", marginBottom: 3 }}>Value</label>
                                    <input value={test.value} onChange={e => { const t = [...editingTests]; t[idx] = { ...t[idx], value: e.target.value }; setEditingTests(t); }} style={{ width: "100%", padding: "7px 8px", border: "1px solid " + theme.border, borderRadius: 8, fontSize: 13, color: theme.text, outline: "none" }}/>
                                  </div>
                                  <div>
                                    <label style={{ fontSize: 10, fontWeight: 600, color: theme.textSecondary, display: "block", marginBottom: 3 }}>Unit</label>
                                    <input value={test.unit} onChange={e => { const t = [...editingTests]; t[idx] = { ...t[idx], unit: e.target.value }; setEditingTests(t); }} style={{ width: "100%", padding: "7px 8px", border: "1px solid " + theme.border, borderRadius: 8, fontSize: 13, color: theme.text, outline: "none" }}/>
                                  </div>
                                  <div>
                                    <label style={{ fontSize: 10, fontWeight: 600, color: theme.textSecondary, display: "block", marginBottom: 3 }}>Ref Range</label>
                                    <input value={test.range || ""} onChange={e => { const t = [...editingTests]; t[idx] = { ...t[idx], range: e.target.value }; setEditingTests(t); }} style={{ width: "100%", padding: "7px 8px", border: "1px solid " + theme.border, borderRadius: 8, fontSize: 13, color: theme.text, outline: "none" }} placeholder="e.g. 4.0-11.0"/>
                                  </div>
                                </div>
                                <div style={{ marginTop: 8 }}>
                                  <label style={{ fontSize: 10, fontWeight: 600, color: theme.textSecondary, display: "block", marginBottom: 3 }}>Interpretation</label>
                                  <input value={test.interpretation || ""} onChange={e => { const t = [...editingTests]; t[idx] = { ...t[idx], interpretation: e.target.value }; setEditingTests(t); }} style={{ width: "100%", padding: "7px 8px", border: "1px solid " + theme.border, borderRadius: 8, fontSize: 12, color: theme.text, outline: "none" }} placeholder="Clinical meaning or notes"/>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      <button onClick={() => {
                        setReports(prev => prev.map(r => {
                          if (r.id !== editingReport) return r;
                          
                          const groupMap = {};
                          editingTests.forEach(t => {
                            const g = t.group || "Others";
                            if (!groupMap[g]) groupMap[g] = [];
                            groupMap[g].push(t);
                          });
                          const newGroups = Object.entries(groupMap).map(([group, tests]) => ({ group, tests }));
                          return { ...r, tests: editingTests, testGroups: newGroups };
                        }));
                        setEditingReport(null); setEditingTests([]);
                      }} style={{ width: "100%", padding: "13px", background: "linear-gradient(135deg, #D97757, #C4623F)", color: "white", border: "none", borderRadius: 14, fontSize: 15, fontWeight: 700, cursor: "pointer", marginTop: 6 }}>Save All Changes</button>
                    </div>
                  );
                })()}
              </div>
            )}
            {/* APP INFO TAB */}
            {settingsTab === "info" && (
              <div>
                <div style={{ borderRadius: 14, overflow: "hidden", border: "1px solid " + theme.border }}>
                  {[{ label: "App Name", value: "My Health Plus" }, { label: "AI Engine", value: "Claude Sonnet" }, { label: "Formats", value: "PDF, DOCX, JPG, PNG" }, { label: "PDF Reader", value: "pdf.js" }, { label: "Doc Reader", value: "Mammoth.js" }, { label: "Image OCR", value: "Claude Vision API" }].map((item, i, arr) => (
                    <div key={i} style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < arr.length - 1 ? "1px solid " + theme.border : "none" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{item.label}</span>
                      <span style={{ fontSize: 12, color: theme.primary, fontWeight: 500 }}>{item.value}</span>
                    </div>
                  ))}
                </div>
                <div style={{ background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 12, padding: 14, marginTop: 16, textAlign: "center" }}>
                  <p style={{ margin: 0, fontSize: 12, color: "#5D4037", fontWeight: 600, marginBottom: 4 }}>Medical Disclaimer</p>
                  <p style={{ margin: 0, fontSize: 11, color: "#5D4037", lineHeight: 1.5 }}>This app uses AI for informational purposes only. Always consult a qualified physician.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {showReportViewer && (() => {
        const report = reports.find(r => r.id === selectedReport);
        if (!report?.fileData) { setShowReportViewer(false); return null; }
        const isPdf = report.fileType?.includes("pdf") || report.fileName?.toLowerCase().endsWith(".pdf");
        const isImage = report.fileType?.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(report.fileName || "");
        const handleClose = () => setShowReportViewer(false);
        const handleDownload = () => {
          const a = document.createElement("a");
          a.href = report.fileData; a.download = report.fileName || "report";
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
        };
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "#000000ee", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#1A2138", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                <Icon type="file" size={18} color="white"/>
                <span style={{ color: "white", fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{report.fileName}</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button onClick={handleDownload} style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer", color: "white", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                  <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                  Save
                </button>
                <button onClick={handleClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: 6, cursor: "pointer", display: "flex" }}>
                  <Icon type="close" size={20} color="white"/>
                </button>
              </div>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
              {isPdf && <PDFCanvasViewer fileData={report.fileData}/>}
              {isImage && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100%" }}>
                  <img src={report.fileData} alt={report.fileName} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }}/>
                </div>
              )}
              {!isPdf && !isImage && (
                <div style={{ textAlign: "center", padding: 40 }}>
                  <div style={{ width: 80, height: 80, borderRadius: 20, background: "rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                    <Icon type="file" size={40} color="white"/>
                  </div>
                  <p style={{ color: "white", fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{report.fileName}</p>
                  <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, marginBottom: 20 }}>This file type cannot be previewed in-app.</p>
                  <button onClick={handleDownload} style={{ padding: "14px 32px", background: theme.primary, color: "white", border: "none", borderRadius: 14, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Download to View</button>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

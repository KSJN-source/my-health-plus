const {
  useState,
  useRef,
  useCallback,
  useEffect
} = React;

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
    req.onsuccess = e => {
      _db = e.target.result;
      resolve(_db);
    };
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
const GEMINI_KEY = 'AIzaSyAno217DPl53I4K5xrXx21C0fKAEoZys4g';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_KEY;
async function callGemini(parts, maxTokens) {
  maxTokens = maxTokens || 8192;
  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: parts
      }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.1
      }
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error('Gemini error ' + response.status + ': ' + (err.error?.message || 'unknown'));
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}
function geminiImagePart(base64, mimeType) {
  return {
    inline_data: {
      mime_type: mimeType || 'image/jpeg',
      data: base64
    }
  };
}
async function extractTextFromPDF(file) {
  const pdfjsLib = await loadPDFJS();
  const arrayBuffer = await readAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({
    data: arrayBuffer
  }).promise;
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
    if (window.pdfjsLib) {
      resolve(window.pdfjsLib);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    const timer = setTimeout(() => {
      reject(new Error("PDF.js load timeout"));
    }, 10000);
    script.onload = () => {
      clearTimeout(timer);
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      } catch (e) {
        reject(e);
      }
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("PDF.js failed to load"));
    };
    document.head.appendChild(script);
  });
  return pdfjsLoaded;
}
async function extractTextFromDocx(file) {
  const arrayBuffer = await readAsArrayBuffer(file);
  const result = await mammoth.extractRawText({
    arrayBuffer
  });
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
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "heic", "gif", "bmp", "heif", "tiff", "tif"].includes(ext)) return "image";
  if (mime.includes("word") || mime.includes("document") || ["doc", "docx"].includes(ext)) return "docx";
  if (mime.includes("jpeg") || mime.includes("png") || mime.includes("heic") || mime.includes("heif")) return "image";
  return "unknown";
}
async function parseWithAI(content, isImage = false, imageBase64 = null, mimeType = null) {
  const instructions = `Extract patient info and test results from a medical/lab report. Respond ONLY with valid JSON — no markdown, no backticks, no explanation.

Schema:
{"patient":{"name":"","age":"","sex":"","phone":"","address":"","dateOfBirth":"","referredBy":""},"lab":{"name":"","date":""},"testGroups":[{"group":"Group Name","tests":[{"name":"Test Name","value":"number","unit":"unit","range":"ref range","status":"normal|high|low"}]}]}

Rules:
- Extract name, age, sex, phone, address from patient info area
- age: extract number only
- Process EVERY page, extract EVERY test result
- Group tests by panel headers (CBC, Lipid Profile, LFT, etc.)
- status: high if above range, low if below, normal if within
- Output ONLY the JSON object`;
  const parts = [];
  if (isImage && imageBase64) {
    parts.push(geminiImagePart(imageBase64, mimeType));
  } else {
    const truncated = content && content.length > 60000 ? content.slice(0, 60000) + '...[TRUNCATED]' : content;
    parts.push({
      text: '---REPORT TEXT---\n' + truncated + '\n---END---'
    });
  }
  parts.push({
    text: instructions + '\n\nExtract ALL patient info and ALL test results. Return ONLY valid JSON.'
  });
  let text;
  try {
    text = await callGemini(parts, 8192);
  } catch (fetchErr) {
    throw new Error('Network request failed: ' + (fetchErr.message || 'Could not connect to AI service'));
  }
  let cleaned = text.replace(/```json|```/g, '').trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON found in AI response');
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    let fixed = cleaned;
    fixed = fixed.replace(/,\s*"[^"]*"?\s*:?\s*("?[^"{}[\]]*)?$/g, '');
    fixed = fixed.replace(/,\s*{[^}]*$/g, '');
    fixed = fixed.replace(/,\s*$/g, '');
    const ob = (fixed.match(/{/g) || []).length,
      cb = (fixed.match(/}/g) || []).length;
    const oB = (fixed.match(/\[/g) || []).length,
      cB = (fixed.match(/\]/g) || []).length;
    for (let i = 0; i < oB - cB; i++) fixed += ']';
    for (let i = 0; i < ob - cb; i++) fixed += '}';
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(fixed);
    } catch (e) {
      return {
        patient: {
          name: '',
          age: '',
          sex: '',
          phone: '',
          address: ''
        },
        lab: {
          name: '',
          date: ''
        },
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
    if (clinicalKeywords.test(content)) return 'clinical_note';
    if (imagingKeywords.test(content)) return 'imaging';
  }
  const parts = [];
  if (isImage && imageBase64) parts.push(geminiImagePart(imageBase64, mimeType));else parts.push({
    text: (content || '').slice(0, 600)
  });
  parts.push({
    text: "Classify this medical document with one word: 'imaging' (radiology report), 'clinical_note' (discharge summary/OP note/inpatient note), or 'lab' (blood/lab test report). Reply with ONE word only."
  });
  try {
    const answer = (await callGemini(parts, 10)).toLowerCase().trim();
    if (answer.includes('clinical_note') || answer.includes('clinical note')) return 'clinical_note';
    if (answer.includes('imaging')) return 'imaging';
  } catch (e) {}
  return 'lab';
}
async function parseImagingReport(content, isImage, imageBase64, mimeType) {
  const instructions = `Analyze this radiology/imaging report. Respond ONLY with valid JSON — no markdown, no backticks.

Schema:
{"patient":{"name":"","age":"","sex":"","phone":"","address":"","dateOfBirth":"","referredBy":""},"lab":{"name":"","date":""},"imaging":{"modality":"MRI|CT|Ultrasound|X-Ray|PET|Other","bodyPart":"","clinicalHistory":"","technique":"","normalFindings":["finding1"],"abnormalFindings":["finding1"],"impression":""}}

Rules:
- normalFindings: each normal structure/organ as one item
- abnormalFindings: each abnormal finding with severity/size
- impression: copy radiologist conclusion verbatim
- Output ONLY the JSON object`;
  const parts = [];
  if (isImage && imageBase64) parts.push(geminiImagePart(imageBase64, mimeType));else parts.push({
    text: '---REPORT---\n' + (content || '').slice(0, 60000) + '\n---END---'
  });
  parts.push({
    text: instructions
  });
  const text = await callGemini(parts, 4096);
  const cleaned = text.replace(/```json|```/g, '').trim();
  const s = cleaned.indexOf('{'),
    e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('No JSON in imaging response');
  return JSON.parse(cleaned.slice(s, e + 1));
}
async function parseClinicalNote(content, isImage, imageBase64, mimeType) {
  const instructions = `Analyze this clinical document (discharge summary/OP note/inpatient note). Respond ONLY with valid JSON.

Schema:
{"patient":{"name":"","age":"","sex":"","phone":"","address":"","dateOfBirth":"","referredBy":"","uhid":""},"visit":{"visitType":"OP|IP","hospital":"","department":"","doctor":"","admissionDate":"","dischargeDate":"","visitDate":"","chiefComplaint":"","diagnoses":["Primary diagnosis"],"procedures":["Procedure"],"vitals":{"bp":"","pulse":"","temp":"","spo2":"","weight":"","height":"","rr":""},"allergies":[],"medications":[{"name":"","dose":"","frequency":"","duration":"","route":""}],"followUp":"","summary":"2-3 sentence plain summary"},"extractedLabs":[{"date":"","labName":"","testGroups":[{"group":"","tests":[{"name":"","value":"","unit":"","range":"","status":"normal|high|low"}]}]}],"lab":{"name":"","date":""}}

Rules:
- visitType: IP if admission/discharge dates present, else OP
- diagnoses: all diagnoses, primary first
- medications: every medication with dose if mentioned
- extractedLabs: extract lab results grouped by panel with individual dates; empty array if none
- summary: brief plain-English summary
- Output ONLY the JSON object`;
  const parts = [];
  if (isImage && imageBase64) parts.push(geminiImagePart(imageBase64, mimeType));else parts.push({
    text: '---DOCUMENT---\n' + (content || '').slice(0, 60000) + '\n---END---'
  });
  parts.push({
    text: instructions
  });
  const text = await callGemini(parts, 8192);
  const cleaned = text.replace(/```json|```/g, '').trim();
  const s = cleaned.indexOf('{'),
    e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('No JSON in clinical note response');
  return JSON.parse(cleaned.slice(s, e + 1));
}
async function getAIAnalysis(tests, patientInfo) {
  const lines = tests.map(function (t) {
    return t.name + ': ' + t.value + ' ' + t.unit + ' (Ref: ' + t.range + ') [' + t.status + ']';
  });
  const testSummary = lines.join('\n');
  const prompt = 'You are a medical report analysis AI. Analyze the lab results and respond ONLY with valid JSON. No markdown, no backticks.\n\n' + 'Schema:{"summary":"1-2 sentence overall summary","sections":[{"title":"Section title","icon":"findings|warning|check|recommend","points":["Bullet"]}]}\n\n' + 'Rules:\n- Always include Key Findings with 2-4 bullets\n- Abnormal Values section if any abnormal\n- What is Normal section\n- Next Steps section\n- One sentence per bullet, patient-friendly\n\n' + 'Patient: ' + (patientInfo.name || 'Unknown') + ', Age: ' + (patientInfo.age || 'Unknown') + ', Sex: ' + (patientInfo.sex || 'Unknown') + '\n\n' + 'Test Results:\n' + testSummary + '\n\nOutput ONLY the JSON object.';
  try {
    var text = await callGemini([{
      text: prompt
    }], 2000);
    var cleaned = text.replace(/```json|```/g, '').trim();
    var s = cleaned.indexOf('{'),
      e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1) return null;
    return JSON.parse(cleaned.slice(s, e + 1));
  } catch (err) {
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
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (parseInt(a) > 12) {
      [a, b] = [b, a];
    }
    return `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (m) {
    const [, d, mo, y] = m;
    const fullYear = parseInt(y) > 50 ? "19" + y : "20" + y;
    return `${fullYear}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const months = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12"
  };
  m = s.match(/(\d{1,2})\s*[\/\-.,]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[\/\-.,]?\s*(\d{4})/i);
  if (m) return `${m[3]}-${months[m[2].toLowerCase().slice(0, 3)]}-${m[1].padStart(2, "0")}`;
  m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[\/\-.,]?\s*(\d{1,2})\s*[\/\-.,]?\s*(\d{4})/i);
  if (m) return `${m[3]}-${months[m[1].toLowerCase().slice(0, 3)]}-${m[2].padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
function formatTestDate(isoDate) {
  if (!isoDate) return "Date unknown";
  try {
    const d = new Date(isoDate + "T00:00:00");
    return d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  } catch (e) {
    return isoDate;
  }
}
const Icon = ({
  type,
  size = 20,
  color = "currentColor"
}) => {
  const s = {
    width: size,
    height: size,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center"
  };
  const icons = {
    upload: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"
    })),
    home: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "9 22 9 12 15 12 15 22"
    })),
    users: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "9",
      cy: "7",
      r: "4"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"
    })),
    chart: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("line", {
      x1: "18",
      y1: "20",
      x2: "18",
      y2: "10"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "20",
      x2: "12",
      y2: "4"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "6",
      y1: "20",
      x2: "6",
      y2: "14"
    })),
    file: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "14 2 14 8 20 8"
    })),
    search: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("circle", {
      cx: "11",
      cy: "11",
      r: "8"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "21",
      y1: "21",
      x2: "16.65",
      y2: "16.65"
    })),
    chevron: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("polyline", {
      points: "9 18 15 12 9 6"
    })),
    back: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("polyline", {
      points: "15 18 9 12 15 6"
    })),
    alert: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "9",
      x2: "12",
      y2: "13"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "17",
      x2: "12.01",
      y2: "17"
    })),
    heart: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: color,
      stroke: "none"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"
    })),
    ai: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
    })),
    trend: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("polyline", {
      points: "22 12 18 12 15 21 9 3 6 12 2 12"
    })),
    close: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("line", {
      x1: "18",
      y1: "6",
      x2: "6",
      y2: "18"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "6",
      y1: "6",
      x2: "18",
      y2: "18"
    })),
    settings: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
    })),
    check: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("polyline", {
      points: "20 6 9 17 4 12"
    })),
    userplus: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "8.5",
      cy: "7",
      r: "4"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "20",
      y1: "8",
      x2: "20",
      y2: "14"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "23",
      y1: "11",
      x2: "17",
      y2: "11"
    })),
    refresh: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("polyline", {
      points: "23 4 23 10 17 10"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M20.49 15a9 9 0 11-2.12-9.36L23 10"
    })),
    list: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("line", {
      x1: "8",
      y1: "6",
      x2: "21",
      y2: "6"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "8",
      y1: "12",
      x2: "21",
      y2: "12"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "8",
      y1: "18",
      x2: "21",
      y2: "18"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "3",
      y1: "6",
      x2: "3.01",
      y2: "6"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "3",
      y1: "12",
      x2: "3.01",
      y2: "12"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "3",
      y1: "18",
      x2: "3.01",
      y2: "18"
    })),
    grid: /*#__PURE__*/React.createElement("svg", {
      style: s,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("rect", {
      x: "3",
      y: "3",
      width: "7",
      height: "7"
    }), /*#__PURE__*/React.createElement("rect", {
      x: "14",
      y: "3",
      width: "7",
      height: "7"
    }), /*#__PURE__*/React.createElement("rect", {
      x: "3",
      y: "14",
      width: "7",
      height: "7"
    }), /*#__PURE__*/React.createElement("rect", {
      x: "14",
      y: "14",
      width: "7",
      height: "7"
    }))
  };
  return icons[type] || null;
};
let _chartIdCounter = 0;
const MiniTrendChart = ({
  data,
  color = "#D97757",
  height = 60,
  abnormalFlags
}) => {
  const [hovered, setHovered] = useState(null);
  const chartId = useRef(null);
  if (!chartId.current) chartId.current = "mhc" + ++_chartIdCounter;
  if (!data || data.length < 2) return null;
  const values = data.map(d => d.value);
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  const w = 280,
    h = height + 44,
    pad = 18,
    topPad = 22,
    bottomPad = 26;
  const chartH = h - topPad - bottomPad;
  const abnormalColor = "#E53935";
  const normalColor = "#2E7D32";
  const getXY = i => ({
    x: pad + i / (values.length - 1) * (w - 2 * pad),
    y: topPad + chartH - (values[i] - min) / range * (chartH - 6)
  });
  const points = values.map((v, i) => {
    const p = getXY(i);
    return p.x + "," + p.y;
  });
  const ptColors = values.map((v, i) => abnormalFlags && abnormalFlags[i] ? abnormalColor : normalColor);
  const segGradients = [];
  for (let i = 0; i < values.length - 1; i++) {
    const id = chartId.current + "_s" + i;
    segGradients.push({
      id,
      c1: ptColors[i],
      c2: ptColors[i + 1]
    });
  }
  const latestColor = ptColors[ptColors.length - 1];
  const gid = chartId.current + "_g";
  const shortLabel = label => {
    if (!label) return "";
    const parts = label.split(" ");
    return parts.length >= 2 ? parts[0] + " " + parts[1] : label;
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      width: "100%"
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 " + w + " " + h,
    style: {
      width: "100%",
      height: "auto",
      display: "block",
      overflow: "visible"
    },
    onMouseLeave: () => setHovered(null),
    onTouchEnd: () => setHovered(null)
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: gid,
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: latestColor,
    stopOpacity: "0.18"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: latestColor,
    stopOpacity: "0.02"
  })), segGradients.map((sg, i) => {
    const p1 = getXY(i),
      p2 = getXY(i + 1);
    return /*#__PURE__*/React.createElement("linearGradient", {
      key: sg.id,
      id: sg.id,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      gradientUnits: "userSpaceOnUse"
    }, /*#__PURE__*/React.createElement("stop", {
      offset: "0%",
      stopColor: sg.c1
    }), /*#__PURE__*/React.createElement("stop", {
      offset: "100%",
      stopColor: sg.c2
    }));
  })), /*#__PURE__*/React.createElement("polygon", {
    points: pad + "," + (topPad + chartH) + " " + points.join(" ") + " " + (w - pad) + "," + (topPad + chartH),
    fill: "url(#" + gid + ")"
  }), segGradients.map((sg, i) => {
    const p1 = getXY(i),
      p2 = getXY(i + 1);
    return /*#__PURE__*/React.createElement("line", {
      key: i,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      stroke: "url(#" + sg.id + ")",
      strokeWidth: "2.5",
      strokeLinecap: "round"
    });
  }), values.map((v, i) => {
    const p = getXY(i);
    const isHov = hovered === i;
    const isAbn = abnormalFlags && abnormalFlags[i];
    const ptColor = isAbn ? abnormalColor : normalColor;
    const label = shortLabel(data[i]?.label);
    const valText = String(data[i]?.value ?? "");
    let anchor = "middle";
    if (i === 0 && values.length > 2) anchor = "start";
    if (i === values.length - 1 && values.length > 2) anchor = "end";
    return /*#__PURE__*/React.createElement("g", {
      key: i
    }, /*#__PURE__*/React.createElement("text", {
      x: p.x,
      y: isHov ? p.y - 14 : p.y - 10,
      textAnchor: anchor,
      fontSize: isHov ? "10" : "8",
      fontWeight: isHov ? "800" : "500",
      fill: isHov ? ptColor : isAbn ? abnormalColor + "70" : "#B8BFC8"
    }, valText), /*#__PURE__*/React.createElement("text", {
      x: p.x,
      y: topPad + chartH + 14,
      textAnchor: anchor,
      fontSize: isHov ? "8.5" : "7",
      fontWeight: isHov ? "700" : "400",
      fill: isHov ? ptColor : "#B8BFC8"
    }, label), isHov && /*#__PURE__*/React.createElement("line", {
      x1: p.x,
      y1: topPad - 4,
      x2: p.x,
      y2: topPad + chartH + 2,
      stroke: ptColor,
      strokeWidth: "1",
      strokeDasharray: "3,3",
      opacity: "0.4"
    }), isHov && /*#__PURE__*/React.createElement("circle", {
      cx: p.x,
      cy: p.y,
      r: 12,
      fill: ptColor,
      opacity: "0.12"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: p.x,
      cy: p.y,
      r: isHov ? 6 : 4,
      fill: isHov ? ptColor : isAbn ? abnormalColor : normalColor,
      stroke: isHov ? ptColor : isAbn ? abnormalColor : normalColor,
      strokeWidth: isHov ? 2.5 : 2
    }), !isHov && /*#__PURE__*/React.createElement("circle", {
      cx: p.x,
      cy: p.y,
      r: 2,
      fill: "white"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: p.x,
      cy: p.y,
      r: 20,
      fill: "transparent",
      stroke: "none",
      style: {
        cursor: "pointer"
      },
      onMouseEnter: () => setHovered(i),
      onTouchStart: e => {
        e.stopPropagation();
        setHovered(i);
      }
    }));
  })));
};
const StatusBadge = ({
  status
}) => {
  const c = {
    normal: {
      bg: "#E8F5E9",
      color: "#2E7D32",
      label: "Normal"
    },
    high: {
      bg: "#FFF3E0",
      color: "#E65100",
      label: "High"
    },
    low: {
      bg: "#E3F2FD",
      color: "#1565C0",
      label: "Low"
    }
  }[status] || {
    bg: "#E8F5E9",
    color: "#2E7D32",
    label: "Normal"
  };
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 600,
      background: c.bg,
      color: c.color
    }
  }, c.label);
};
function PDFCanvasViewer({
  fileData
}) {
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
        const pdf = await pdfjsLib.getDocument({
          data: bytes
        }).promise;
        if (cancelled) return;
        setTotalPages(pdf.numPages);
        const images = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const scale = 2;
          const viewport = page.getViewport({
            scale
          });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          await page.render({
            canvasContext: ctx,
            viewport
          }).promise;
          images.push(canvas.toDataURL("image/png"));
          if (cancelled) return;
        }
        setPageImages(images);
        setLoading(false);
      } catch (e) {
        console.error("PDF render error:", e);
        if (!cancelled) {
          setError("Could not render PDF: " + (e.message || ""));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileData]);
  if (loading) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 300,
        gap: 16
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 48,
        height: 48,
        borderRadius: 24,
        background: "rgba(255,255,255,0.1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "pulse 1.5s ease-in-out infinite"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "file",
      size: 24,
      color: "white"
    })), /*#__PURE__*/React.createElement("p", {
      style: {
        color: "rgba(255,255,255,0.7)",
        fontSize: 14
      }
    }, "Rendering PDF", totalPages > 0 ? ` (${totalPages} pages)` : "", "..."));
  }
  if (error) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 300,
        gap: 12
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "alert",
      size: 32,
      color: "#FF8C42"
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        color: "rgba(255,255,255,0.7)",
        fontSize: 14,
        textAlign: "center"
      }
    }, error));
  }
  return /*#__PURE__*/React.createElement("div", {
    ref: containerRef,
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 12,
      paddingBottom: 16
    }
  }, pageImages.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "sticky",
      top: 0,
      zIndex: 10,
      background: "rgba(26,33,56,0.9)",
      backdropFilter: "blur(8px)",
      padding: "6px 16px",
      borderRadius: 20,
      fontSize: 12,
      color: "rgba(255,255,255,0.8)",
      fontWeight: 600
    }
  }, pageImages.length, " pages \u2014 scroll to view all"), pageImages.map((img, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      position: "relative",
      width: "100%"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: img,
    alt: `Page ${i + 1}`,
    style: {
      width: "100%",
      borderRadius: 6,
      display: "block",
      boxShadow: "0 2px 12px rgba(0,0,0,0.3)"
    }
  }), pageImages.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      bottom: 8,
      right: 8,
      background: "rgba(0,0,0,0.6)",
      color: "white",
      fontSize: 11,
      fontWeight: 600,
      padding: "3px 10px",
      borderRadius: 10
    }
  }, "Page ", i + 1, " / ", pageImages.length))));
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
      } catch (e) {
        console.warn('Failed to load from IndexedDB:', e);
      }
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
  const theme = {
    bg: "#FFF8F5",
    primary: "#D97757",
    accent: "#00C48C",
    warning: "#E53935",
    text: "#1A2138",
    textSecondary: "#6B7A99",
    border: "#F0E6E0",
    shadow: "0 2px 12px rgba(80,45,31,0.08)"
  };
  const normalizeTestName = name => {
    if (!name) return "";
    let n = name.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const aliases = [[/^h(a?e)?moglobin$|^hgb$|^hb$/, "haemoglobin"], [/^r(ed)?\s?b(lood)?\s?c(ells?)?$|^rbc(s)?$|^erythrocytes$/, "rbc"], [/^w(hite)?\s?b(lood)?\s?c(ells?)?$|^wbc(s)?$|^leucocytes?$|^leukocytes?$|^tlc$/, "wbc"], [/^platelet(s)?(\s?count)?$|^plt$|^thrombocytes?$/, "platelets"], [/^haematocrit$|^hematocrit$|^hct$|^pcv$/, "haematocrit"], [/^m(ean)?\s?c(orpuscular)?\s?v(olume)?$|^mcv$/, "mcv"], [/^m(ean)?\s?c(orpuscular)?\s?h(a?e)?moglobin\s?c(onc(entration)?)?$|^mchc$/, "mchc"], [/^m(ean)?\s?c(orpuscular)?\s?h(a?e)?moglobin$|^mch$/, "mch"], [/^neutrophil(s)?(\s?%)?$|^neut(s)?$|^pmn$/, "neutrophils"], [/^lymphocyte(s)?(\s?%)?$|^lymph(s)?$/, "lymphocytes"], [/^monocyte(s)?(\s?%)?$|^mono(s)?$/, "monocytes"], [/^eosinophil(s)?(\s?%)?$|^eosin(s)?$/, "eosinophils"], [/^basophil(s)?(\s?%)?$|^baso(s)?$/, "basophils"], [/^(total\s)?cholesterol$|^chol$/, "cholesterol"], [/^(ldl|low\s?density\s?lipoprotein)(\s?cholesterol)?$/, "ldl cholesterol"], [/^(hdl|high\s?density\s?lipoprotein)(\s?cholesterol)?$/, "hdl cholesterol"], [/^triglyceride(s)?$|^tg$/, "triglycerides"], [/^(fasting\s)?blood\s?sugar$|^fbs$|^fasting\s?glucose$|^f\.?b\.?g\.?$/, "fasting blood sugar"], [/^(post\s?prandial|pp)\s?(blood\s?)?sugar$|^ppbs$|^pp\s?glucose$/, "postprandial blood sugar"], [/^(random\s)?blood\s?sugar$|^rbs$|^blood\s?glucose$/, "blood sugar"], [/^hba1c$|^glycated\s?h(a?e)?moglobin$|^glycohaemoglobin$/, "hba1c"], [/^creatinine(\s?(serum|blood))?$/, "creatinine"], [/^blood\s?urea\s?nitrogen$|^bun$|^urea(\s?nitrogen)?$/, "urea"], [/^(serum\s)?uric\s?acid$/, "uric acid"], [/^(serum\s)?sodium$|^na\+?$/, "sodium"], [/^(serum\s)?potassium$|^k\+?$/, "potassium"], [/^(serum\s)?calcium$|^ca\+?$/, "calcium"], [/^(serum\s)?chloride$|^cl-?$/, "chloride"], [/^(serum\s)?bicarbonate$|^hco3-?$/, "bicarbonate"], [/^(total\s)?bilirubin$|^tbil$/, "total bilirubin"], [/^direct\s?(bilirubin)?$|^dbil$|^conjugated\s?bilirubin$/, "direct bilirubin"], [/^indirect\s?(bilirubin)?$|^unconjugated\s?bilirubin$/, "indirect bilirubin"], [/^sgpt$|^alt$|^alanine\s?(aminotransferase|transaminase)$/, "alt sgpt"], [/^sgot$|^ast$|^aspartate\s?(aminotransferase|transaminase)$/, "ast sgot"], [/^alkaline\s?phosphatase$|^alp$|^alk\s?phos$/, "alkaline phosphatase"], [/^(total\s)?protein$/, "total protein"], [/^albumin(\s?serum)?$/, "albumin"], [/^globulin$/, "globulin"], [/^thyroid\s?stimulating\s?hormone$|^tsh$/, "tsh"], [/^(free\s)?thyroxine$|^(free\s)?t4$|^ft4$/, "t4"], [/^(free\s)?triiodothyronine$|^(free\s)?t3$|^ft3$/, "t3"], [/^(serum\s)?iron$|^fe$/, "serum iron"], [/^(total\s?iron[\s-]?binding\s?capacity|tibc)$/, "tibc"], [/^ferritin(\s?serum)?$/, "ferritin"], [/^vitamin\s?b[\s-]?12$|^cobalamin$/, "vitamin b12"], [/^vitamin\s?d(\s?(total|25[\s-]?oh))?$|^25[\s-]?hydroxyvitamin\s?d$/, "vitamin d"], [/^(c[\s-]?reactive\s?protein|crp)$/, "crp"], [/^erythrocyte\s?sedimentation\s?rate$|^esr$/, "esr"], [/^egfr$|^(estimated\s?)?glomerular\s?filtration\s?rate$/, "egfr"]];
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
  const getPatientReports = pid => reports.filter(r => r.patientId === pid).sort((a, b) => new Date(b.date + "T00:00:00") - new Date(a.date + "T00:00:00"));
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
        dateVal: !isNaN(dateVal) && dateVal > 0 ? dateVal : Date.now(),
        value: isNaN(numVal) ? null : numVal,
        rawValue: t.value,
        unit: t.unit || "",
        range: t.range || "",
        status: t.status || "normal",
        label: formatTestDate(normalized || r.date),
        numeric: !isNaN(numVal)
      };
    }).filter(d => d !== null).sort((a, b) => a.dateVal - b.dateVal);
  };
  const getNumericTrend = trendData => trendData.filter(d => d.numeric);
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
      const lo = parseFloat(match[1]),
        hi = parseFloat(match[2]);
      if (!isNaN(lo) && !isNaN(hi) && v >= lo && v <= hi) return false;
    }
    if (allRanges.length > 0) {
      let minLo = Infinity,
        maxHi = -Infinity;
      allRanges.forEach(match => {
        const lo = parseFloat(match[1]),
          hi = parseFloat(match[2]);
        if (!isNaN(lo) && !isNaN(hi)) {
          minLo = Math.min(minLo, lo);
          maxHi = Math.max(maxHi, hi);
        }
      });
      if (minLo !== Infinity && maxHi !== -Infinity) return v < minLo || v > maxHi;
    }
    let m = r.match(/[<≤]\s*([\d.]+)/);
    if (!m) m = r.match(/(?:up\s*to|less\s*than|below|upto|not\s*more\s*than|desirable)[:\s]*([\d.]+)/i);
    if (m) {
      const hi = parseFloat(m[1]);
      if (!isNaN(hi)) return v > hi;
    }
    m = r.match(/[>≥]\s*([\d.]+)/);
    if (!m) m = r.match(/(?:above|greater\s*than|more\s*than|over)[:\s]*([\d.]+)/i);
    if (m) {
      const lo = parseFloat(m[1]);
      if (!isNaN(lo)) return v < lo;
    }
    return null;
  };
  const getAbnormalStatus = d => {
    if (!d) return false;
    if (d.numeric && d.range) {
      const rangeResult = checkAgainstRange(d.value, d.range);
      if (rangeResult !== null) return rangeResult;
    }
    return d.status === "high" || d.status === "low";
  };
  const resetUpload = () => {
    setShowUpload(false);
    setUploadStep("select");
    setUploadStatus("");
    setUploadError("");
    setAssignChoice("new");
    setPendingData(null);
    setUploadFileName("");
    setPendingFileData(null);
    setPendingFileType("");
    setEditName("");
    setEditAge("");
    setEditSex("");
    setEditPhone("");
    setEditAddress("");
    setFileQueue([]);
    setQueueIndex(0);
    setBatchMode(null);
    setSinglePatientId(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const processFile = useCallback(async file => {
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
    } catch (e) {
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
        if (groups.length === 0 && flatTests?.length > 0) groups = [{
          group: "Others",
          tests: flatTests
        }];
        return groups.map(g => ({
          group: g.group || "Others",
          tests: (g.tests || []).map(t => ({
            ...t,
            value: t.value || "0",
            unit: t.unit || "",
            range: t.range || "N/A",
            status: t.status || "normal"
          }))
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
            return {
              ...lb,
              testGroups: tgs,
              tests: tgs.flatMap(g => g.tests.map(t => ({
                ...t,
                group: g.group
              })))
            };
          });
        }
      } else {
        const testGroups = normalizeTestGroups(parsed.testGroups, parsed.tests);
        parsed.testGroups = testGroups;
        parsed.tests = testGroups.flatMap(g => g.tests.map(t => ({
          ...t,
          group: g.group
        })));
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
            if (m < 0 || m === 0 && now.getDate() < dob.getDate()) age--;
            extractedAge = String(age);
          }
        } catch (e) {}
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
      if (rawMsg.includes("JSON")) msg = "AI returned incomplete data. Please try again.";else if (rawMsg.includes("Failed to fetch") || rawMsg.includes("NetworkError") || rawMsg.includes("network") || rawMsg.includes("Load failed")) msg = "Network error — could not reach AI service. Check your connection or try inside a Claude.ai conversation (not a published link).";else if (rawMsg.includes("401") || rawMsg.includes("403")) msg = "API authentication failed. Upload only works inside Claude.ai, not in published/shared links.";else if (rawMsg.includes("password")) msg = "This PDF is password-protected. Please unlock it first.";else if (rawMsg.includes("timeout") || rawMsg.includes("Timeout")) msg = "Request timed out. Try a smaller file.";
      msg += "\n\n[Debug: " + rawMsg + (rawStack ? " | " + rawStack.split("\n")[0] : "") + "]";
      setUploadError(msg);
      setUploadStep("error");
    }
  }, [patients]);
  const matchPatient = extractedName => {
    if (!extractedName) return null;
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
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
      const np = {
        id: newId,
        name: editName.trim() || "Unknown Patient",
        age: parseInt(editAge) || 0,
        sex: editSex || "Unknown",
        phone: editPhone || "Not provided",
        address: editAddress || "Not provided",
        avatar
      };
      setPatients(prev => [...prev, np]);
      targetId = newId;
    } else {
      targetId = assignChoice;
      setPatients(prev => prev.map(p => {
        if (p.id !== targetId) return p;
        return {
          ...p,
          phone: editPhone && editPhone !== "Not provided" ? editPhone : p.phone,
          address: editAddress && editAddress !== "Not provided" ? editAddress : p.address
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
      status: t.status || "normal"
    }));
    const testGroups = (pendingData?.testGroups || []).map(g => ({
      group: g.group || "Others",
      tests: (g.tests || []).map(t => ({
        ...t,
        value: t.value || "0",
        unit: t.unit || "",
        range: t.range || "N/A",
        status: t.status || "normal"
      }))
    }));
    const isImaging = pendingData?.reportType === "imaging";
    const isClinical = pendingData?.reportType === "clinical_note";
    const visitData = isClinical ? pendingData?.visit || {} : null;
    const visitDateRaw = visitData ? visitData.dischargeDate || visitData.admissionDate || visitData.visitDate || "" : "";
    const visitDate = normalizeDate(visitDateRaw) || reportDate;
    const newReport = {
      id: "r-" + Date.now(),
      patientId: targetId,
      date: isClinical ? visitDate : reportDate,
      labName: isImaging ? (pendingData.imaging?.modality || "Imaging") + (pendingData.imaging?.bodyPart ? " — " + pendingData.imaging.bodyPart : "") : isClinical ? (visitData?.hospital || "Clinical Note") + (visitData?.visitType ? " (" + visitData.visitType + ")" : "") : labInfo.name || "Unknown Lab",
      fileName: uploadFileName,
      fileData: pendingFileData,
      fileType: pendingFileType,
      tests,
      testGroups,
      reportType: pendingData?.reportType || "lab",
      imaging: pendingData?.imaging || null,
      visit: visitData,
      analysis: null,
      uploadedAt: new Date().toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric"
      })
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
          uploadedAt: new Date().toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
            year: "numeric"
          }),
          sourceVisitId: newReport.id
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
        setUploadStatus("");
        setUploadError("");
        setPendingData(null);
        setUploadFileName("");
        setPendingFileData(null);
        setPendingFileType("");
        setEditName("");
        setEditAge("");
        setEditSex("");
        setEditPhone("");
        setEditAddress("");
        setAssignChoice("new");
        processFile(fileQueue[nextIdx]);
      }, 800);
    } else {
      setTimeout(() => {
        resetUpload();
        setSelectedPatient(targetId);
        setSelectedReport(reportsToAdd[0].id);
        setActiveTab("patients");
      }, 1200);
    }
  };
  const generateAnalysis = async report => {
    setAnalysisLoading(true);
    setShowAnalysis(report.id);
    setAnalysisData(null);
    try {
      const patient = patients.find(p => p.id === report.patientId) || {};
      const result = await getAIAnalysis(report.tests, patient);
      setAnalysisData(result);
      setReports(prev => prev.map(r => r.id === report.id ? {
        ...r,
        analysis: result
      } : r));
    } catch (err) {
      setAnalysisData(null);
    }
    setAnalysisLoading(false);
  };
  const inputStyle = {
    width: "100%",
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid " + theme.border,
    fontSize: 14,
    color: theme.text,
    outline: "none",
    background: "white",
    boxSizing: "border-box"
  };
  const pageStyle = {
    maxWidth: 430,
    margin: "0 auto",
    minHeight: "100vh",
    background: theme.bg,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    position: "relative"
  };
  const LogoWordmark = ({
    size = "large"
  }) => {
    const s = size === "large";
    const f = "'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif";
    const accent = s ? "#1A2744" : "#1A2744";
    return /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: f,
        fontSize: s ? 22 : 18,
        letterSpacing: -0.5,
        display: "inline-flex",
        alignItems: "baseline"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "'Caveat', cursive",
        fontWeight: 700,
        color: accent,
        fontSize: s ? 52 : 38
      }
    }, "my"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 700,
        color: "white",
        marginLeft: s ? 4 : 3
      }
    }, "Health "), /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 700,
        color: accent
      }
    }, "Plus+"));
  };
  const SettingsBtn = () => /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowSettings(true),
    style: {
      background: "rgba(255,255,255,0.15)",
      border: "none",
      borderRadius: 10,
      padding: 6,
      cursor: "pointer",
      display: "flex",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "rgba(255,255,255,0.85)",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
  })));
  const Header = ({
    title,
    showBack,
    onBack,
    rightAction
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 20px 12px",
      background: "linear-gradient(135deg, #D97757 0%, #C4623F 100%)",
      color: "white",
      position: "sticky",
      top: 0,
      zIndex: 100
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12
    }
  }, showBack && /*#__PURE__*/React.createElement("button", {
    onClick: onBack,
    style: {
      background: "rgba(255,255,255,0.2)",
      border: "none",
      borderRadius: 10,
      padding: 6,
      cursor: "pointer",
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "back",
    size: 20,
    color: "white"
  })), /*#__PURE__*/React.createElement(LogoWordmark, {
    size: showBack ? "small" : "large"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, rightAction, /*#__PURE__*/React.createElement(SettingsBtn, null)));
  const BottomNav = () => /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      bottom: 0,
      left: "50%",
      transform: "translateX(-50%)",
      width: "100%",
      maxWidth: 430,
      background: "white",
      borderTop: "1px solid " + theme.border,
      display: "flex",
      justifyContent: "space-around",
      padding: "8px 0 20px",
      zIndex: 200,
      boxShadow: "0 -2px 16px rgba(0,0,0,0.06)"
    }
  }, [{
    id: "home",
    icon: "home",
    label: "Home"
  }, {
    id: "patients",
    icon: "users",
    label: "Patients"
  }, {
    id: "upload",
    icon: "upload",
    label: "Upload"
  }, {
    id: "trends",
    icon: "trend",
    label: "Trends"
  }, {
    id: "results",
    icon: "grid",
    label: "Results"
  }].map(tab => /*#__PURE__*/React.createElement("button", {
    key: tab.id,
    onClick: () => {
      if (tab.id === "upload") {
        setShowUpload(true);
        setUploadStep("select");
        return;
      }
      setActiveTab(tab.id);
      setSelectedPatient(null);
      setSelectedReport(null);
      setSelectedTest(null);
      setShowReportViewer(false);
    },
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 4,
      background: "none",
      border: "none",
      cursor: "pointer",
      padding: "4px 12px",
      color: activeTab === tab.id ? theme.primary : theme.textSecondary
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 6,
      borderRadius: 12,
      background: activeTab === tab.id ? theme.primary + "15" : "transparent"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: tab.icon,
    size: 22,
    color: activeTab === tab.id ? theme.primary : theme.textSecondary
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: activeTab === tab.id ? 600 : 400
    }
  }, tab.label))));
  const UploadModal = () => /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 300,
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "center",
      background: "rgba(0,0,0,0.5)",
      backdropFilter: "blur(4px)"
    },
    onClick: e => {
      if (e.target === e.currentTarget && (uploadStep === "select" || uploadStep === "error")) resetUpload();
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "white",
      borderRadius: "24px 24px 0 0",
      width: "100%",
      maxWidth: 430,
      padding: "24px 24px 40px",
      maxHeight: "85vh",
      overflowY: "auto",
      animation: "slideUp 0.3s ease-out"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      fontSize: 20,
      fontWeight: 700,
      color: theme.text
    }
  }, uploadStep === "select" ? "Upload Health Reports" : uploadStep === "batch-choose" ? "Multiple Files Selected" : uploadStep === "processing" ? "Processing Report" : uploadStep === "detected" ? "Review Extracted Data" : uploadStep === "done" ? "Upload Complete" : "Upload Error", fileQueue.length > 1 && !["select", "batch-choose"].includes(uploadStep) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 500,
      color: theme.textSecondary,
      marginLeft: 8
    }
  }, "(", queueIndex + 1, " of ", fileQueue.length, ")")), (uploadStep === "select" || uploadStep === "error" || uploadStep === "batch-choose") && /*#__PURE__*/React.createElement("button", {
    onClick: resetUpload,
    style: {
      background: theme.bg,
      border: "none",
      borderRadius: 10,
      padding: 6,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "close",
    size: 18,
    color: theme.textSecondary
  }))), uploadStep === "select" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: () => fileInputRef.current?.click(),
    style: {
      border: "2px dashed " + theme.primary + "40",
      borderRadius: 16,
      padding: 40,
      textAlign: "center",
      cursor: "pointer",
      background: theme.primary + "05",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 64,
      height: 64,
      borderRadius: 20,
      background: theme.primary + "15",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      margin: "0 auto 16px"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "upload",
    size: 28,
    color: theme.primary
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 16,
      fontWeight: 600,
      color: theme.text,
      marginBottom: 6
    }
  }, "Tap to select reports"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 13,
      color: theme.textSecondary
    }
  }, "PDF, Word (.docx), JPEG, PNG \u2014 select multiple"), /*#__PURE__*/React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    multiple: true,
    accept: ".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic,.heif,.bmp,.gif,application/pdf,image/*,.tiff,.tif",
    style: {
      display: "none"
    },
    onChange: e => {
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
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      background: theme.primary + "08",
      borderRadius: 12,
      padding: 14,
      display: "flex",
      gap: 10,
      alignItems: "flex-start"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "ai",
    size: 20,
    color: theme.primary
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 13,
      fontWeight: 600,
      color: theme.text
    }
  }, "AI-Powered Extraction"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "4px 0 0",
      fontSize: 12,
      color: theme.textSecondary,
      lineHeight: 1.5
    }
  }, "Patient name, age, sex, phone, address, and all test results will be automatically extracted. Select multiple files to batch upload.")))), uploadStep === "batch-choose" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      background: theme.primary + "08",
      borderRadius: 14,
      padding: 16,
      marginBottom: 20,
      display: "flex",
      gap: 12,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 48,
      borderRadius: 14,
      background: theme.primary + "15",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "file",
    size: 24,
    color: theme.primary
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 16,
      fontWeight: 700,
      color: theme.text
    }
  }, fileQueue.length, " files selected"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "4px 0 0",
      fontSize: 12,
      color: theme.textSecondary
    }
  }, fileQueue.map(f => f.name).join(", ")))), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 15,
      fontWeight: 700,
      color: theme.text,
      marginBottom: 12
    }
  }, "Are these reports for:"), /*#__PURE__*/React.createElement("div", {
    onClick: () => setBatchMode("single"),
    style: {
      background: batchMode === "single" ? theme.primary + "10" : "white",
      border: "2px solid " + (batchMode === "single" ? theme.primary : theme.border),
      borderRadius: 16,
      padding: 16,
      marginBottom: 10,
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 48,
      borderRadius: 14,
      background: batchMode === "single" ? theme.primary : theme.primary + "15",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "users",
    size: 24,
    color: batchMode === "single" ? "white" : theme.primary
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: theme.text
    }
  }, "Single Patient"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: theme.textSecondary,
      marginTop: 3
    }
  }, "All ", fileQueue.length, " reports belong to the same person")), batchMode === "single" && /*#__PURE__*/React.createElement(Icon, {
    type: "check",
    size: 20,
    color: theme.primary
  })), /*#__PURE__*/React.createElement("div", {
    onClick: () => setBatchMode("multi"),
    style: {
      background: batchMode === "multi" ? theme.primary + "10" : "white",
      border: "2px solid " + (batchMode === "multi" ? theme.primary : theme.border),
      borderRadius: 16,
      padding: 16,
      marginBottom: 20,
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 48,
      borderRadius: 14,
      background: batchMode === "multi" ? theme.primary : theme.primary + "15",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: batchMode === "multi" ? "white" : theme.primary,
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "7",
    r: "4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M23 21v-2a4 4 0 00-3-3.87"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M16 3.13a4 4 0 010 7.75"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: theme.text
    }
  }, "Multiple Patients"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: theme.textSecondary,
      marginTop: 3
    }
  }, "Reports are for different people \u2014 will auto-match names")), batchMode === "multi" && /*#__PURE__*/React.createElement(Icon, {
    type: "check",
    size: 20,
    color: theme.primary
  })), batchMode && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      processFile(fileQueue[0]);
    },
    style: {
      width: "100%",
      padding: 16,
      background: "linear-gradient(135deg, " + theme.primary + ", #C4623F)",
      color: "white",
      border: "none",
      borderRadius: 14,
      fontSize: 15,
      fontWeight: 700,
      cursor: "pointer",
      boxShadow: "0 4px 16px rgba(217,119,87,0.3)"
    }
  }, "Start Processing ", fileQueue.length, " Reports")), uploadStep === "processing" && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "30px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 80,
      height: 80,
      borderRadius: 40,
      background: theme.primary + "10",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      margin: "0 auto 20px",
      animation: "pulse 1.5s ease-in-out infinite"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "ai",
    size: 36,
    color: theme.primary
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 16,
      fontWeight: 600,
      color: theme.text,
      marginBottom: 6
    }
  }, uploadStatus || "Processing..."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: theme.textSecondary,
      marginBottom: 4
    }
  }, uploadFileName), fileQueue.length > 1 && /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 12,
      color: theme.primary,
      fontWeight: 600,
      marginTop: 8
    }
  }, "File ", queueIndex + 1, " of ", fileQueue.length), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 4,
      background: theme.primary + "30",
      borderRadius: 2,
      margin: "16px auto 0",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "60%",
      height: "100%",
      background: theme.primary,
      borderRadius: 2,
      animation: "loading 1.2s ease-in-out infinite"
    }
  }))), uploadStep === "error" && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "20px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 64,
      height: 64,
      borderRadius: 32,
      background: "#FFEBEE",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      margin: "0 auto 16px"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "alert",
    size: 30,
    color: "#D32F2F"
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: theme.text,
      marginBottom: 8
    }
  }, "Processing Failed"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: theme.textSecondary,
      marginBottom: 12,
      lineHeight: 1.5,
      padding: "0 10px"
    }
  }, uploadError), /*#__PURE__*/React.createElement("details", {
    style: {
      textAlign: "left",
      marginBottom: 16,
      padding: "0 10px"
    }
  }, /*#__PURE__*/React.createElement("summary", {
    style: {
      fontSize: 11,
      color: theme.textSecondary,
      cursor: "pointer"
    }
  }, "Show technical details"), /*#__PURE__*/React.createElement("pre", {
    style: {
      fontSize: 10,
      color: "#999",
      background: theme.bg,
      padding: 10,
      borderRadius: 8,
      marginTop: 6,
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      maxHeight: 120,
      overflow: "auto"
    }
  }, uploadError)), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setUploadStep("select");
      setUploadError("");
    },
    style: {
      padding: "12px 32px",
      background: theme.primary,
      color: "white",
      border: "none",
      borderRadius: 12,
      fontSize: 14,
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "Try Again")), uploadStep === "detected" && pendingData && (() => {
    const isSingleBatchFollowup = batchMode === "single" && singlePatientId && queueIndex > 0;
    const assignedPatient = isSingleBatchFollowup ? patients.find(p => p.id === singlePatientId) : null;
    const autoMatchedId = batchMode === "multi" ? matchPatient(editName) : null;
    const autoMatchedPatient = autoMatchedId ? patients.find(p => p.id === autoMatchedId) : null;
    return /*#__PURE__*/React.createElement(React.Fragment, null, pendingData.reportType === "imaging" ? /*#__PURE__*/React.createElement("div", {
      style: {
        background: "#E8EAF6",
        border: "1px solid #9FA8DA",
        borderRadius: 14,
        padding: 14,
        marginBottom: 16,
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("svg", {
      width: 20,
      height: 20,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "#3949AB",
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("rect", {
      x: "3",
      y: "3",
      width: "18",
      height: "18",
      rx: "2"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "8.5",
      cy: "8.5",
      r: "1.5"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M21 15l-5-5L5 21"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 13,
        fontWeight: 600,
        color: "#1A237E"
      }
    }, "Imaging report detected \u2014 findings summarised"), /*#__PURE__*/React.createElement("p", {
      style: {
        margin: "4px 0 0",
        fontSize: 12,
        color: theme.textSecondary
      }
    }, pendingData.imaging?.modality || "Imaging", " \xB7 ", pendingData.imaging?.bodyPart || ""))) : pendingData.reportType === "clinical_note" ? /*#__PURE__*/React.createElement("div", {
      style: {
        background: "#E8F5E9",
        border: "1px solid #A5D6A7",
        borderRadius: 14,
        padding: 14,
        marginBottom: 16,
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("svg", {
      width: 20,
      height: 20,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "#2E7D32",
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "14 2 14 8 20 8"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "16",
      y1: "13",
      x2: "8",
      y2: "13"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "16",
      y1: "17",
      x2: "8",
      y2: "17"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "10 9 9 9 8 9"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 13,
        fontWeight: 600,
        color: "#1B5E20"
      }
    }, "Clinical ", pendingData.visit?.visitType === "IP" ? "Discharge Summary" : "Note", " detected"), /*#__PURE__*/React.createElement("p", {
      style: {
        margin: "4px 0 0",
        fontSize: 12,
        color: theme.textSecondary
      }
    }, pendingData.visit?.hospital || "Hospital", " \xB7 ", pendingData.visit?.visitType || "OP", pendingData.extractedLabs?.length > 0 ? " · " + pendingData.extractedLabs.length + " lab set(s) extracted" : ""))) : /*#__PURE__*/React.createElement("div", {
      style: {
        background: theme.accent + "10",
        border: "1px solid " + theme.accent + "30",
        borderRadius: 14,
        padding: 14,
        marginBottom: 16,
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "check",
      size: 20,
      color: theme.accent
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 13,
        fontWeight: 600,
        color: "#1B5E20"
      }
    }, "AI successfully extracted data from your report"), /*#__PURE__*/React.createElement("p", {
      style: {
        margin: "4px 0 0",
        fontSize: 12,
        color: theme.textSecondary
      }
    }, pendingData.tests?.length || 0, " test results found - Review & edit below"))), isSingleBatchFollowup && assignedPatient && /*#__PURE__*/React.createElement("div", {
      style: {
        background: theme.primary + "10",
        border: "1.5px solid " + theme.primary + "30",
        borderRadius: 14,
        padding: 14,
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        gap: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 44,
        height: 44,
        borderRadius: 12,
        background: "linear-gradient(135deg, #D97757, #C4623F)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 15,
        fontWeight: 700,
        color: "white",
        flexShrink: 0
      }
    }, assignedPatient.avatar), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: 600,
        color: theme.text
      }
    }, "Assigning to: ", assignedPatient.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        marginTop: 2
      }
    }, assignedPatient.age, " yrs - ", assignedPatient.sex)), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "4px 10px",
        background: theme.primary + "20",
        borderRadius: 8,
        fontSize: 11,
        fontWeight: 600,
        color: theme.primary
      }
    }, "Auto")), !isSingleBatchFollowup && /*#__PURE__*/React.createElement("div", {
      style: {
        background: "white",
        border: "1px solid " + theme.border,
        borderRadius: 14,
        padding: 16,
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("h4", {
      style: {
        margin: "0 0 12px",
        fontSize: 14,
        fontWeight: 700,
        color: theme.text,
        display: "flex",
        alignItems: "center",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "users",
      size: 16,
      color: theme.primary
    }), " Extracted Patient Information"), [{
      label: "Full Name",
      val: editName,
      set: setEditName
    }, {
      label: "Age",
      val: editAge,
      set: setEditAge,
      type: "number"
    }, {
      label: "Sex",
      val: editSex,
      set: setEditSex
    }, {
      label: "Phone",
      val: editPhone,
      set: setEditPhone,
      type: "tel"
    }, {
      label: "Address",
      val: editAddress,
      set: setEditAddress
    }].map((f, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        marginBottom: i < 4 ? 10 : 0
      }
    }, /*#__PURE__*/React.createElement("label", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        fontWeight: 600,
        display: "block",
        marginBottom: 4
      }
    }, f.label), /*#__PURE__*/React.createElement("input", {
      value: f.val,
      onChange: e => f.set(e.target.value),
      type: f.type || "text",
      placeholder: "Enter " + f.label.toLowerCase(),
      style: inputStyle
    })))), pendingData.reportType === "clinical_note" && pendingData.visit && /*#__PURE__*/React.createElement("div", {
      style: {
        background: "white",
        border: "1px solid " + theme.border,
        borderRadius: 14,
        padding: 16,
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("h4", {
      style: {
        margin: "0 0 12px",
        fontSize: 14,
        fontWeight: 700,
        color: theme.text,
        display: "flex",
        alignItems: "center",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("svg", {
      width: 16,
      height: 16,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: theme.primary,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "14 2 14 8 20 8"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "16",
      y1: "13",
      x2: "8",
      y2: "13"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "16",
      y1: "17",
      x2: "8",
      y2: "17"
    })), "Visit Summary"), pendingData.visit.summary && /*#__PURE__*/React.createElement("p", {
      style: {
        margin: "0 0 12px",
        fontSize: 13,
        color: theme.text,
        lineHeight: 1.5,
        padding: "10px 12px",
        background: theme.bg,
        borderRadius: 8
      }
    }, pendingData.visit.summary), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 8,
        marginBottom: 10
      }
    }, [{
      label: "Hospital",
      val: pendingData.visit.hospital
    }, {
      label: "Type",
      val: pendingData.visit.visitType === "IP" ? "Inpatient" : "Outpatient"
    }, {
      label: "Doctor",
      val: pendingData.visit.doctor
    }, {
      label: "Department",
      val: pendingData.visit.department
    }, {
      label: pendingData.visit.visitType === "IP" ? "Admitted" : "Visit Date",
      val: pendingData.visit.admissionDate || pendingData.visit.visitDate
    }, {
      label: "Discharged",
      val: pendingData.visit.dischargeDate
    }].filter(x => x.val).map((item, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        padding: "8px 10px",
        background: theme.bg,
        borderRadius: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        fontWeight: 600,
        color: theme.textSecondary,
        textTransform: "uppercase",
        marginBottom: 2
      }
    }, item.label), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 600,
        color: theme.text
      }
    }, item.val)))), pendingData.visit.diagnoses?.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: theme.textSecondary,
        marginBottom: 4
      }
    }, "DIAGNOSES"), pendingData.visit.diagnoses.map((d, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        fontSize: 12,
        color: theme.text,
        padding: "4px 0",
        borderBottom: "1px solid " + theme.border
      }
    }, i === 0 ? "• " : "◦ ", d))), pendingData.visit.medications?.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: theme.textSecondary,
        marginBottom: 4
      }
    }, "MEDICATIONS (", pendingData.visit.medications.length, ")"), pendingData.visit.medications.slice(0, 5).map((m, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        fontSize: 12,
        color: theme.text,
        padding: "3px 0"
      }
    }, "\u2022 ", m.name, m.dose ? " " + m.dose : "", m.frequency ? " · " + m.frequency : "")), pendingData.visit.medications.length > 5 && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: theme.textSecondary
      }
    }, "+", pendingData.visit.medications.length - 5, " more")), pendingData.visit.followUp && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        fontStyle: "italic",
        borderTop: "1px solid " + theme.border,
        paddingTop: 8
      }
    }, "Follow-up: ", pendingData.visit.followUp), pendingData.extractedLabs?.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10,
        padding: "8px 10px",
        background: theme.primary + "08",
        borderRadius: 8,
        border: "1px solid " + theme.primary + "20"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 600,
        color: theme.primary
      }
    }, "\uD83E\uDDEA ", pendingData.extractedLabs.reduce((n, lb) => n + (lb.tests?.length || 0), 0), " lab results will be saved separately with individual dates"))), pendingData.reportType === "imaging" && pendingData.imaging && /*#__PURE__*/React.createElement("div", {
      style: {
        background: "white",
        border: "1px solid " + theme.border,
        borderRadius: 14,
        padding: 16,
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("h4", {
      style: {
        margin: "0 0 12px",
        fontSize: 14,
        fontWeight: 700,
        color: theme.text,
        display: "flex",
        alignItems: "center",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("svg", {
      width: 16,
      height: 16,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: theme.primary,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("rect", {
      x: "3",
      y: "3",
      width: "18",
      height: "18",
      rx: "2"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "8.5",
      cy: "8.5",
      r: "1.5"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M21 15l-5-5L5 21"
    })), " Imaging Summary"), pendingData.imaging.clinicalHistory && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        marginBottom: 10,
        padding: "8px 10px",
        background: theme.bg,
        borderRadius: 8
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 600,
        color: theme.text
      }
    }, "Clinical History: "), pendingData.imaging.clinicalHistory), pendingData.imaging.abnormalFindings?.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 700,
        color: "#C62828",
        marginBottom: 6,
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 8,
        height: 8,
        borderRadius: 4,
        background: "#E53935"
      }
    }), " Abnormal Findings"), pendingData.imaging.abnormalFindings.map((f, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: "flex",
        gap: 8,
        padding: "6px 10px",
        background: "#FFEBEE",
        borderRadius: 8,
        marginBottom: 4,
        borderLeft: "3px solid #E53935"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: "#B71C1C",
        lineHeight: 1.4
      }
    }, "\u2022 ", f)))), pendingData.imaging.normalFindings?.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 700,
        color: "#2E7D32",
        marginBottom: 6,
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 8,
        height: 8,
        borderRadius: 4,
        background: "#4CAF50"
      }
    }), " Normal Findings"), pendingData.imaging.normalFindings.map((f, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: "flex",
        gap: 8,
        padding: "6px 10px",
        background: "#E8F5E9",
        borderRadius: 8,
        marginBottom: 4,
        borderLeft: "3px solid #4CAF50"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: "#1B5E20",
        lineHeight: 1.4
      }
    }, "\u2022 ", f)))), pendingData.imaging.impression && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "10px 12px",
        background: "#E8EAF6",
        borderRadius: 8,
        borderLeft: "3px solid #3949AB"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: "#1A237E",
        marginBottom: 4
      }
    }, "IMPRESSION"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: "#1A237E",
        lineHeight: 1.5
      }
    }, pendingData.imaging.impression))), pendingData.reportType !== "imaging" && pendingData.testGroups?.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        background: "white",
        border: "1px solid " + theme.border,
        borderRadius: 14,
        padding: 16,
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("h4", {
      style: {
        margin: "0 0 12px",
        fontSize: 14,
        fontWeight: 700,
        color: theme.text,
        display: "flex",
        alignItems: "center",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "file",
      size: 16,
      color: theme.primary
    }), " Extracted Test Results (", pendingData.tests?.length || 0, ")"), /*#__PURE__*/React.createElement("div", {
      style: {
        maxHeight: 280,
        overflowY: "auto"
      }
    }, pendingData.testGroups.map((grp, gi) => /*#__PURE__*/React.createElement("div", {
      key: gi,
      style: {
        marginBottom: gi < pendingData.testGroups.length - 1 ? 12 : 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 8,
        padding: "6px 10px",
        background: theme.primary + "08",
        borderRadius: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 6,
        height: 6,
        borderRadius: 3,
        background: theme.primary
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: theme.primary
      }
    }, grp.group), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: theme.textSecondary,
        marginLeft: "auto"
      }
    }, grp.tests.length, " tests")), grp.tests.map((t, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "6px 10px",
        borderBottom: i < grp.tests.length - 1 ? "1px solid " + theme.border : "none"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 500,
        color: theme.text
      }
    }, t.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: theme.textSecondary
      }
    }, "Ref: ", t.range || "N/A")), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right",
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: t.status === "high" ? theme.warning : t.status === "low" ? "#1565C0" : theme.text
      }
    }, t.value, " ", t.unit), /*#__PURE__*/React.createElement(StatusBadge, {
      status: t.status || "normal"
    })))))))), !isSingleBatchFollowup && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h4", {
      style: {
        margin: "0 0 10px",
        fontSize: 14,
        fontWeight: 700,
        color: theme.text
      }
    }, "Save report to:"), batchMode === "multi" && autoMatchedPatient && assignChoice === autoMatchedId && /*#__PURE__*/React.createElement("div", {
      style: {
        background: theme.accent + "08",
        border: "1px solid " + theme.accent + "30",
        borderRadius: 10,
        padding: "8px 12px",
        marginBottom: 10,
        display: "flex",
        alignItems: "center",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "check",
      size: 14,
      color: theme.accent
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        fontWeight: 600,
        color: "#1B5E20"
      }
    }, "Auto-matched to \"", autoMatchedPatient.name, "\" based on report name")), /*#__PURE__*/React.createElement("div", {
      onClick: () => setAssignChoice("new"),
      style: {
        background: assignChoice === "new" ? theme.primary + "10" : "white",
        border: "2px solid " + (assignChoice === "new" ? theme.primary : theme.border),
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 44,
        height: 44,
        borderRadius: 12,
        background: assignChoice === "new" ? theme.primary : theme.primary + "15",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "userplus",
      size: 22,
      color: assignChoice === "new" ? "white" : theme.primary
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: 600,
        color: theme.text
      }
    }, "Create New Patient"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        marginTop: 2
      }
    }, editName || "Unknown", " ", editAge ? "- " + editAge + " yrs" : "", " ", editSex ? "- " + editSex : "")), assignChoice === "new" && /*#__PURE__*/React.createElement(Icon, {
      type: "check",
      size: 20,
      color: theme.primary
    })), patients.length > 0 && /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        margin: "12px 0 8px",
        fontWeight: 600
      }
    }, "Or add to existing patient:"), patients.map(p => /*#__PURE__*/React.createElement("div", {
      key: p.id,
      onClick: () => setAssignChoice(p.id),
      style: {
        background: assignChoice === p.id ? theme.primary + "10" : "white",
        border: "2px solid " + (assignChoice === p.id ? theme.primary : theme.border),
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 44,
        height: 44,
        borderRadius: 12,
        background: "linear-gradient(135deg, #D97757, #C4623F)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 15,
        fontWeight: 700,
        color: "white"
      }
    }, p.avatar), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: 600,
        color: theme.text
      }
    }, p.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        marginTop: 2
      }
    }, p.age, " yrs - ", p.sex, " - ", getPatientReports(p.id).length, " reports")), assignChoice === p.id && /*#__PURE__*/React.createElement(Icon, {
      type: "check",
      size: 20,
      color: theme.primary
    })))), /*#__PURE__*/React.createElement("button", {
      onClick: confirmAssignment,
      style: {
        width: "100%",
        padding: 16,
        marginTop: 16,
        background: "linear-gradient(135deg, " + theme.primary + ", #C4623F)",
        color: "white",
        border: "none",
        borderRadius: 14,
        fontSize: 15,
        fontWeight: 700,
        cursor: "pointer",
        boxShadow: "0 4px 16px rgba(217,119,87,0.3)"
      }
    }, isSingleBatchFollowup ? "Save Report to " + (assignedPatient?.name || "Patient") : assignChoice !== "new" ? "Add Report to " + (patients.find(p => p.id === assignChoice)?.name || "Patient") : "Create Patient & Save Report"), /*#__PURE__*/React.createElement("div", {
      style: {
        background: "#FFF8E1",
        border: "1px solid #FFE082",
        borderRadius: 12,
        padding: 12,
        marginTop: 12,
        display: "flex",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "alert",
      size: 16,
      color: "#F9A825"
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 11,
        color: "#5D4037",
        lineHeight: 1.5
      }
    }, /*#__PURE__*/React.createElement("strong", null, "Note:"), " AI extraction may have inaccuracies. Please verify all patient details and test results before saving.")));
  })(), uploadStep === "done" && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "30px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 80,
      height: 80,
      borderRadius: 40,
      background: theme.accent + "15",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      margin: "0 auto 20px"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "check",
    size: 40,
    color: theme.accent
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 18,
      fontWeight: 700,
      color: theme.text,
      marginBottom: 6
    }
  }, "Report Saved!"), queueIndex + 1 < fileQueue.length ? /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: theme.textSecondary
    }
  }, "Processing next file... (", queueIndex + 1, " of ", fileQueue.length, " done)") : fileQueue.length > 1 ? /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: theme.textSecondary
    }
  }, "All ", fileQueue.length, " reports saved!") : /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: theme.textSecondary
    }
  }, "Opening patient details..."), fileQueue.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      margin: "16px auto 0",
      width: "80%",
      height: 6,
      background: theme.border,
      borderRadius: 3,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: Math.round((queueIndex + 1) / fileQueue.length * 100) + "%",
      height: "100%",
      background: theme.accent,
      borderRadius: 3,
      transition: "width 0.3s"
    }
  })))));
  const HomeScreen = () => {
    const totalReports = reports.length;
    const abnormalCount = reports.flatMap(r => r.tests).filter(t => t.status !== "normal").length;
    const recentReports = [...reports].sort((a, b) => new Date(b.date + "T00:00:00") - new Date(a.date + "T00:00:00")).slice(0, 5);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        paddingBottom: 90
      }
    }, /*#__PURE__*/React.createElement(Header, {
      title: "My Health Plus"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "20px 20px 0"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 12,
        marginBottom: 24
      }
    }, [{
      label: "Patients",
      value: patients.length,
      icon: "users",
      color: theme.primary
    }, {
      label: "Reports",
      value: totalReports,
      icon: "file",
      color: theme.accent
    }, {
      label: "Alerts",
      value: abnormalCount,
      icon: "alert",
      color: theme.warning
    }].map((st, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        background: "white",
        borderRadius: 16,
        padding: "16px 12px",
        textAlign: "center",
        boxShadow: theme.shadow
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 40,
        height: 40,
        borderRadius: 12,
        background: st.color + "15",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        margin: "0 auto 8px"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: st.icon,
      size: 20,
      color: st.color
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 24,
        fontWeight: 700,
        color: theme.text
      }
    }, st.value), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        marginTop: 2
      }
    }, st.label)))), /*#__PURE__*/React.createElement("div", {
      style: {
        background: "linear-gradient(135deg, #D97757 0%, #C4623F 100%)",
        borderRadius: 20,
        padding: 20,
        marginBottom: 24,
        boxShadow: "0 4px 20px rgba(217,119,87,0.3)"
      }
    }, /*#__PURE__*/React.createElement("h3", {
      style: {
        color: "white",
        fontSize: 16,
        fontWeight: 600,
        margin: "0 0 14px"
      }
    }, "Get Started"), /*#__PURE__*/React.createElement("p", {
      style: {
        color: "rgba(255,255,255,0.85)",
        fontSize: 13,
        margin: "0 0 16px",
        lineHeight: 1.5
      }
    }, "Upload a health report (PDF, image, or Word) and AI will automatically extract patient info and test results."), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setShowUpload(true);
        setUploadStep("select");
      },
      style: {
        width: "100%",
        background: "rgba(255,255,255,0.2)",
        border: "1px solid rgba(255,255,255,0.3)",
        borderRadius: 14,
        padding: "14px 12px",
        cursor: "pointer",
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        fontSize: 15,
        fontWeight: 600,
        backdropFilter: "blur(10px)"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "upload",
      size: 22,
      color: "white"
    }), " Upload Health Reports")), recentReports.length > 0 && /*#__PURE__*/React.createElement("h3", {
      style: {
        fontSize: 16,
        fontWeight: 700,
        color: theme.text,
        margin: "0 0 12px"
      }
    }, "Recent Reports"), recentReports.map(report => {
      const patient = patients.find(p => p.id === report.patientId);
      const abnormal = report.tests.filter(t => t.status !== "normal").length;
      return /*#__PURE__*/React.createElement("div", {
        key: report.id,
        onClick: () => {
          setSelectedPatient(report.patientId);
          setSelectedReport(report.id);
          setActiveTab("patients");
        },
        style: {
          background: "white",
          borderRadius: 16,
          padding: 16,
          marginBottom: 10,
          boxShadow: theme.shadow,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 14
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          width: 48,
          height: 48,
          borderRadius: 14,
          background: theme.primary + "12",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 16,
          fontWeight: 700,
          color: theme.primary
        }
      }, patient?.avatar), /*#__PURE__*/React.createElement("div", {
        style: {
          flex: 1
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 14,
          fontWeight: 600,
          color: theme.text
        }
      }, patient?.name), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 12,
          color: theme.textSecondary,
          marginTop: 2
        }
      }, report.labName, " - ", formatTestDate(report.date)), abnormal > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: 4,
          display: "flex",
          alignItems: "center",
          gap: 4
        }
      }, /*#__PURE__*/React.createElement(Icon, {
        type: "alert",
        size: 13,
        color: theme.warning
      }), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 11,
          color: theme.warning,
          fontWeight: 600
        }
      }, abnormal, " abnormal"))), /*#__PURE__*/React.createElement(Icon, {
        type: "chevron",
        size: 18,
        color: theme.textSecondary
      }));
    }), reports.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: "30px 0",
        color: theme.textSecondary
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "file",
      size: 48,
      color: theme.border
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        marginTop: 12,
        fontSize: 14
      }
    }, "No reports yet. Upload health reports above!")), /*#__PURE__*/React.createElement("div", {
      style: {
        background: "#FFF8E1",
        border: "1px solid #FFE082",
        borderRadius: 14,
        padding: 14,
        marginTop: 14,
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "alert",
      size: 18,
      color: "#F9A825"
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 12,
        color: "#5D4037",
        lineHeight: 1.5
      }
    }, /*#__PURE__*/React.createElement("strong", null, "Medical Disclaimer:"), " AI analysis is for informational purposes only. Always consult your physician for actual diagnosis and treatment."))));
  };
  const PatientsScreen = () => {
    const filtered = patients.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));
    if (selectedPatient && !selectedReport) {
      const patient = patients.find(p => p.id === selectedPatient);
      if (!patient) {
        setSelectedPatient(null);
        return null;
      }
      const pReports = getPatientReports(selectedPatient);
      return /*#__PURE__*/React.createElement("div", {
        style: {
          paddingBottom: 90
        }
      }, /*#__PURE__*/React.createElement(Header, {
        title: patient.name,
        showBack: true,
        onBack: () => setSelectedPatient(null)
      }), /*#__PURE__*/React.createElement("div", {
        style: {
          padding: 20
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 20,
          padding: 20,
          boxShadow: theme.shadow,
          marginBottom: 20
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 16
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          width: 60,
          height: 60,
          borderRadius: 18,
          background: "linear-gradient(135deg, #D97757, #C4623F)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          fontWeight: 700,
          color: "white"
        }
      }, patient.avatar), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 18,
          fontWeight: 700,
          color: theme.text
        }
      }, patient.name), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: theme.textSecondary,
          marginTop: 2
        }
      }, patient.age > 0 ? patient.age + " yrs" : "Age N/A", " - ", patient.sex))), /*#__PURE__*/React.createElement("div", {
        style: {
          borderTop: "1px solid " + theme.border,
          paddingTop: 14
        }
      }, [{
        label: "Phone",
        value: patient.phone
      }, {
        label: "Address",
        value: patient.address
      }, {
        label: "Reports",
        value: pReports.length + " uploaded"
      }].map((item, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          display: "flex",
          justifyContent: "space-between",
          padding: "8px 0",
          borderBottom: i < 2 ? "1px solid " + theme.border : "none"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          color: theme.textSecondary
        }
      }, item.label), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          fontWeight: 500,
          color: theme.text,
          textAlign: "right",
          maxWidth: "60%"
        }
      }, item.value))))), /*#__PURE__*/React.createElement("h3", {
        style: {
          fontSize: 16,
          fontWeight: 700,
          color: theme.text,
          margin: "0 0 12px"
        }
      }, "Reports (", pReports.length, ")"), pReports.map(report => {
        const abnormal = report.tests.filter(t => t.status !== "normal").length;
        const isImg = report.reportType === "imaging";
        const isClin = report.reportType === "clinical_note";
        const borderCol = isClin ? "#2E7D32" : isImg ? "#3949AB" : abnormal > 0 ? theme.warning : theme.accent;
        return /*#__PURE__*/React.createElement("div", {
          key: report.id,
          onClick: () => setSelectedReport(report.id),
          style: {
            background: "white",
            borderRadius: 16,
            padding: 16,
            marginBottom: 10,
            boxShadow: theme.shadow,
            cursor: "pointer",
            borderLeft: "4px solid " + borderCol
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start"
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            flex: 1
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 14,
            fontWeight: 600,
            color: theme.text
          }
        }, report.labName), /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 12,
            color: theme.textSecondary,
            marginTop: 3
          }
        }, isClin ? report.visit?.admissionDate && report.visit?.dischargeDate ? "Admitted: " + formatTestDate(normalizeDate(report.visit.admissionDate)) + " · Discharged: " + formatTestDate(normalizeDate(report.visit.dischargeDate)) : "Visit: " + formatTestDate(report.date) : "Date: " + formatTestDate(report.date)), /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 11,
            color: theme.textSecondary,
            marginTop: 2
          }
        }, isClin ? /*#__PURE__*/React.createElement("span", {
          style: {
            color: "#2E7D32",
            fontWeight: 600
          }
        }, "Clinical Note \xB7 ", report.visit?.visitType === "IP" ? "Inpatient" : "Outpatient") : isImg ? /*#__PURE__*/React.createElement("span", {
          style: {
            color: "#3949AB",
            fontWeight: 600
          }
        }, "Imaging Report") : /*#__PURE__*/React.createElement(React.Fragment, null, report.tests.length, " tests", report.testGroups?.length > 0 ? " · " + report.testGroups.length + " panels" : ""), " · ", "Uploaded: ", report.uploadedAt), isClin && report.visit?.diagnoses?.length > 0 && /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 11,
            color: theme.text,
            marginTop: 4,
            fontStyle: "italic"
          }
        }, report.visit.diagnoses[0])), /*#__PURE__*/React.createElement("div", {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8
          }
        }, !isImg && !isClin && abnormal > 0 && /*#__PURE__*/React.createElement("span", {
          style: {
            background: "#FFF3E0",
            color: "#E65100",
            fontSize: 11,
            fontWeight: 600,
            padding: "4px 10px",
            borderRadius: 20
          }
        }, abnormal, " alert", abnormal > 1 ? "s" : ""), isImg && report.imaging?.abnormalFindings?.length > 0 && /*#__PURE__*/React.createElement("span", {
          style: {
            background: "#FFEBEE",
            color: "#C62828",
            fontSize: 11,
            fontWeight: 600,
            padding: "4px 10px",
            borderRadius: 20
          }
        }, report.imaging.abnormalFindings.length, " finding", report.imaging.abnormalFindings.length > 1 ? "s" : ""), /*#__PURE__*/React.createElement(Icon, {
          type: "chevron",
          size: 18,
          color: theme.textSecondary
        }))));
      })));
    }
    if (selectedReport) {
      const report = reports.find(r => r.id === selectedReport);
      if (!report) {
        setSelectedReport(null);
        return null;
      }
      const patient = patients.find(p => p.id === report.patientId);
      return /*#__PURE__*/React.createElement("div", {
        style: {
          paddingBottom: 90
        }
      }, /*#__PURE__*/React.createElement(Header, {
        title: "Report Details",
        showBack: true,
        onBack: () => {
          if (selectedTest) {
            setSelectedTest(null);
            return;
          }
          setShowReportViewer(false);
          setSelectedReport(null);
        },
        rightAction: /*#__PURE__*/React.createElement("button", {
          onClick: () => {
            if (report.analysis) {
              setAnalysisData(report.analysis);
              setShowAnalysis(report.id);
              setAnalysisLoading(false);
            } else {
              generateAnalysis(report);
            }
          },
          style: {
            background: "rgba(255,255,255,0.2)",
            border: "none",
            borderRadius: 10,
            padding: "6px 12px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "white",
            fontSize: 12,
            fontWeight: 600
          }
        }, /*#__PURE__*/React.createElement(Icon, {
          type: "ai",
          size: 16,
          color: "white"
        }), " AI Analysis")
      }), /*#__PURE__*/React.createElement("div", {
        style: {
          padding: 20
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 16,
          padding: 16,
          boxShadow: theme.shadow,
          marginBottom: 16
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }
      }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 16,
          fontWeight: 700,
          color: theme.text
        }
      }, report.labName), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: theme.textSecondary,
          marginTop: 2
        }
      }, "Patient: ", patient?.name || "Unknown"), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 12,
          color: theme.textSecondary,
          marginTop: 1
        }
      }, "Tested: ", formatTestDate(report.date), " \\u00b7 Uploaded: ", report.uploadedAt)), /*#__PURE__*/React.createElement("div", {
        style: {
          width: 44,
          height: 44,
          borderRadius: 12,
          background: theme.primary + "12",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }
      }, /*#__PURE__*/React.createElement(Icon, {
        type: "file",
        size: 22,
        color: theme.primary
      }))), report.fileData && /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: 8,
          marginTop: 14,
          paddingTop: 14,
          borderTop: "1px solid " + theme.border
        }
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => setShowReportViewer(true),
        style: {
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "10px 12px",
          background: theme.primary + "10",
          border: "1px solid " + theme.primary + "30",
          borderRadius: 12,
          cursor: "pointer",
          color: theme.primary,
          fontSize: 13,
          fontWeight: 600
        }
      }, /*#__PURE__*/React.createElement("svg", {
        style: {
          width: 16,
          height: 16
        },
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2"
      }, /*#__PURE__*/React.createElement("path", {
        d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "3"
      })), "View Original"), /*#__PURE__*/React.createElement("button", {
        onClick: () => {
          const a = document.createElement("a");
          a.href = report.fileData;
          a.download = report.fileName || "report";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        },
        style: {
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "10px 12px",
          background: theme.accent + "10",
          border: "1px solid " + theme.accent + "30",
          borderRadius: 12,
          cursor: "pointer",
          color: "#1B5E20",
          fontSize: 13,
          fontWeight: 600
        }
      }, /*#__PURE__*/React.createElement("svg", {
        style: {
          width: 16,
          height: 16
        },
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2"
      }, /*#__PURE__*/React.createElement("path", {
        d: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
      })), "Download")), !report.fileData && /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: 12,
          paddingTop: 12,
          borderTop: "1px solid " + theme.border
        }
      }, /*#__PURE__*/React.createElement("p", {
        style: {
          margin: 0,
          fontSize: 12,
          color: theme.textSecondary,
          fontStyle: "italic"
        }
      }, report.fileName, " \u2014 original file not available (uploaded before file storage was enabled)"))), selectedTest ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
        style: {
          fontSize: 16,
          fontWeight: 700,
          color: theme.text,
          margin: "0 0 12px"
        }
      }, selectedTest, " - Trend"), /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 16,
          padding: 16,
          boxShadow: theme.shadow,
          marginBottom: 16
        }
      }, (() => {
        const td = getTestTrend(report.patientId, selectedTest);
        const nt = getNumericTrend(td);
        const af = nt.map(d => getAbnormalStatus(d));
        return td.length >= 1 ? /*#__PURE__*/React.createElement(React.Fragment, null, nt.length >= 2 && /*#__PURE__*/React.createElement(MiniTrendChart, {
          data: nt,
          color: theme.primary,
          height: 120,
          abnormalFlags: af
        }), /*#__PURE__*/React.createElement("div", {
          style: {
            marginTop: 12
          }
        }, [...td].reverse().map((d, i) => {
          const isAbn = getAbnormalStatus(d);
          return /*#__PURE__*/React.createElement("div", {
            key: i,
            style: {
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 0",
              borderBottom: "1px solid " + theme.border
            }
          }, /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: 12,
              color: i === 0 ? theme.text : theme.textSecondary,
              fontWeight: i === 0 ? 600 : 400,
              display: "flex",
              alignItems: "center",
              gap: 6
            }
          }, d.label, i === 0 && /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: 9,
              fontWeight: 700,
              color: theme.primary,
              background: theme.primary + "15",
              padding: "1px 5px",
              borderRadius: 4
            }
          }, "LATEST")), /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: 13,
              fontWeight: 600,
              color: isAbn ? "#E53935" : theme.text
            }
          }, d.rawValue || d.value, " ", d.unit));
        }))) : /*#__PURE__*/React.createElement("p", {
          style: {
            fontSize: 13,
            color: theme.textSecondary,
            textAlign: "center",
            padding: 20
          }
        }, "Upload more reports for this patient to see trends.");
      })()), /*#__PURE__*/React.createElement("button", {
        onClick: () => setSelectedTest(null),
        style: {
          width: "100%",
          padding: 14,
          background: theme.primary,
          color: "white",
          border: "none",
          borderRadius: 14,
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer"
        }
      }, "Back to All Results")) : /*#__PURE__*/React.createElement(React.Fragment, null, report.reportType === "clinical_note" && report.visit ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14
        }
      }, /*#__PURE__*/React.createElement("svg", {
        width: 18,
        height: 18,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: theme.primary,
        strokeWidth: "2"
      }, /*#__PURE__*/React.createElement("path", {
        d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
      }), /*#__PURE__*/React.createElement("polyline", {
        points: "14 2 14 8 20 8"
      }), /*#__PURE__*/React.createElement("line", {
        x1: "16",
        y1: "13",
        x2: "8",
        y2: "13"
      }), /*#__PURE__*/React.createElement("line", {
        x1: "16",
        y1: "17",
        x2: "8",
        y2: "17"
      })), /*#__PURE__*/React.createElement("h3", {
        style: {
          fontSize: 16,
          fontWeight: 700,
          color: theme.text,
          margin: 0
        }
      }, report.visit.visitType === "IP" ? "Discharge Summary" : "Outpatient Note"), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 11,
          padding: "2px 8px",
          borderRadius: 8,
          background: report.visit.visitType === "IP" ? "#E8F5E9" : "#E3F2FD",
          color: report.visit.visitType === "IP" ? "#2E7D32" : "#1565C0",
          fontWeight: 600
        }
      }, report.visit.visitType || "OP")), report.visit.summary && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          color: theme.textSecondary,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: 0.5
        }
      }, "Summary"), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: theme.text,
          lineHeight: 1.6
        }
      }, report.visit.summary)), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginBottom: 12
        }
      }, [{
        label: "Hospital",
        val: report.visit.hospital
      }, {
        label: "Department",
        val: report.visit.department
      }, {
        label: "Doctor",
        val: report.visit.doctor
      }, {
        label: "Visit Type",
        val: report.visit.visitType === "IP" ? "Inpatient" : "Outpatient"
      }, {
        label: report.visit.visitType === "IP" ? "Admitted" : "Visit Date",
        val: report.visit.admissionDate || report.visit.visitDate
      }, {
        label: "Discharged",
        val: report.visit.dischargeDate
      }].filter(x => x.val).map((item, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          background: "white",
          borderRadius: 10,
          padding: "10px 12px",
          boxShadow: theme.shadow
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 10,
          fontWeight: 700,
          color: theme.textSecondary,
          textTransform: "uppercase",
          marginBottom: 3
        }
      }, item.label), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          fontWeight: 600,
          color: theme.text
        }
      }, item.val)))), report.visit.diagnoses?.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          color: theme.textSecondary,
          marginBottom: 8,
          textTransform: "uppercase"
        }
      }, "Diagnoses"), report.visit.diagnoses.map((d, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          display: "flex",
          gap: 10,
          padding: "7px 10px",
          background: i === 0 ? "#FFF3E0" : theme.bg,
          borderRadius: 8,
          marginBottom: 6,
          borderLeft: "3px solid " + (i === 0 ? "#E65100" : theme.border)
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          color: i === 0 ? "#E65100" : theme.text,
          fontWeight: i === 0 ? 600 : 400
        }
      }, i === 0 ? "Primary: " : "◦ ", d)))), report.visit.vitals && Object.values(report.visit.vitals).some(v => v) && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          color: theme.textSecondary,
          marginBottom: 8,
          textTransform: "uppercase"
        }
      }, "Vitals"), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          flexWrap: "wrap",
          gap: 8
        }
      }, [["BP", report.visit.vitals.bp], ["Pulse", report.visit.vitals.pulse], ["Temp", report.visit.vitals.temp], ["SpO2", report.visit.vitals.spo2], ["Weight", report.visit.vitals.weight], ["Height", report.visit.vitals.height], ["RR", report.visit.vitals.rr]].filter(([, v]) => v).map(([label, val], i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          padding: "6px 12px",
          background: theme.bg,
          borderRadius: 20,
          fontSize: 12
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          color: theme.textSecondary,
          fontWeight: 600
        }
      }, label, ": "), /*#__PURE__*/React.createElement("span", {
        style: {
          color: theme.text,
          fontWeight: 700
        }
      }, val))))), report.visit.medications?.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          color: theme.textSecondary,
          marginBottom: 8,
          textTransform: "uppercase"
        }
      }, "Medications (", report.visit.medications.length, ")"), report.visit.medications.map((m, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          padding: "8px 0",
          borderBottom: i < report.visit.medications.length - 1 ? "1px solid " + theme.border : "none"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          fontWeight: 600,
          color: theme.text
        }
      }, m.name, m.dose ? " — " + m.dose : ""), (m.frequency || m.duration || m.route) && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          color: theme.textSecondary,
          marginTop: 2
        }
      }, [m.frequency, m.duration, m.route].filter(Boolean).join(" · "))))), report.visit.procedures?.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          color: theme.textSecondary,
          marginBottom: 8,
          textTransform: "uppercase"
        }
      }, "Procedures"), report.visit.procedures.map((p, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          fontSize: 13,
          color: theme.text,
          padding: "4px 0"
        }
      }, "\u2022 ", p))), report.visit.followUp && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "#E8F5E9",
          borderRadius: 12,
          padding: "12px 14px",
          borderLeft: "4px solid #2E7D32"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          color: "#2E7D32",
          marginBottom: 4,
          textTransform: "uppercase"
        }
      }, "Follow-up Instructions"), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: "#1B5E20",
          lineHeight: 1.5
        }
      }, report.visit.followUp))) : report.reportType === "imaging" && report.imaging ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14
        }
      }, /*#__PURE__*/React.createElement("svg", {
        width: 18,
        height: 18,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: theme.primary,
        strokeWidth: "2"
      }, /*#__PURE__*/React.createElement("rect", {
        x: "3",
        y: "3",
        width: "18",
        height: "18",
        rx: "2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "8.5",
        cy: "8.5",
        r: "1.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M21 15l-5-5L5 21"
      })), /*#__PURE__*/React.createElement("h3", {
        style: {
          fontSize: 16,
          fontWeight: 700,
          color: theme.text,
          margin: 0
        }
      }, report.imaging.modality || "Imaging", " Report"), report.imaging.bodyPart && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: theme.textSecondary,
          background: theme.bg,
          padding: "2px 8px",
          borderRadius: 8
        }
      }, report.imaging.bodyPart)), report.imaging.clinicalHistory && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          color: theme.textSecondary,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: 0.5
        }
      }, "Clinical History"), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: theme.text,
          lineHeight: 1.5
        }
      }, report.imaging.clinicalHistory)), report.imaging.abnormalFindings?.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 12,
          fontWeight: 700,
          color: "#C62828",
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 6
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          width: 8,
          height: 8,
          borderRadius: 4,
          background: "#E53935"
        }
      }), " Abnormal Findings (", report.imaging.abnormalFindings.length, ")"), report.imaging.abnormalFindings.map((f, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          display: "flex",
          gap: 10,
          padding: "8px 12px",
          background: "#FFEBEE",
          borderRadius: 10,
          marginBottom: 6,
          borderLeft: "3px solid #E53935"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          color: "#B71C1C",
          lineHeight: 1.5
        }
      }, "\u2022 ", f)))), report.imaging.normalFindings?.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 12,
          fontWeight: 700,
          color: "#2E7D32",
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 6
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          width: 8,
          height: 8,
          borderRadius: 4,
          background: "#4CAF50"
        }
      }), " Normal Findings (", report.imaging.normalFindings.length, ")"), report.imaging.normalFindings.map((f, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          display: "flex",
          gap: 10,
          padding: "8px 12px",
          background: "#E8F5E9",
          borderRadius: 10,
          marginBottom: 6,
          borderLeft: "3px solid #4CAF50"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          color: "#1B5E20",
          lineHeight: 1.5
        }
      }, "\u2022 ", f)))), report.imaging.impression && /*#__PURE__*/React.createElement("div", {
        style: {
          background: "#E8EAF6",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: theme.shadow,
          borderLeft: "4px solid #3949AB"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          fontWeight: 700,
          color: "#1A237E",
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: 0.5
        }
      }, "Radiologist Impression"), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: "#1A237E",
          lineHeight: 1.6
        }
      }, report.imaging.impression))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12
        }
      }, /*#__PURE__*/React.createElement("h3", {
        style: {
          fontSize: 16,
          fontWeight: 700,
          color: theme.text,
          margin: 0
        }
      }, "Test Results"), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: theme.textSecondary
        }
      }, report.tests.length, " tests")), report.tests.length === 0 && /*#__PURE__*/React.createElement("p", {
        style: {
          textAlign: "center",
          color: theme.textSecondary,
          padding: 20
        }
      }, "No test results were extracted."), (report.testGroups && report.testGroups.length > 0 ? report.testGroups : [{
        group: "All Tests",
        tests: report.tests
      }]).map((grp, gi) => {
        const groupAbnormal = grp.tests.filter(t => t.status !== "normal").length;
        return /*#__PURE__*/React.createElement("div", {
          key: gi,
          style: {
            marginBottom: 16
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 10,
            padding: "10px 14px",
            background: "linear-gradient(135deg, " + theme.primary + "10, " + theme.primary + "05)",
            borderRadius: 12,
            border: "1px solid " + theme.primary + "20"
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            width: 8,
            height: 8,
            borderRadius: 4,
            background: theme.primary
          }
        }), /*#__PURE__*/React.createElement("div", {
          style: {
            flex: 1
          }
        }, /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 14,
            fontWeight: 700,
            color: theme.primary
          }
        }, grp.group)), /*#__PURE__*/React.createElement("div", {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8
          }
        }, groupAbnormal > 0 && /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 11,
            fontWeight: 600,
            color: theme.warning,
            background: theme.warning + "15",
            padding: "2px 8px",
            borderRadius: 10
          }
        }, groupAbnormal, " alert", groupAbnormal > 1 ? "s" : ""), /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 11,
            color: theme.textSecondary
          }
        }, grp.tests.length, " tests"))), grp.tests.map((test, idx) => /*#__PURE__*/React.createElement("div", {
          key: idx,
          onClick: () => setSelectedTest(test.name),
          style: {
            background: "white",
            borderRadius: 14,
            padding: "14px 16px",
            marginBottom: 8,
            boxShadow: theme.shadow,
            cursor: "pointer",
            borderLeft: "4px solid " + (test.status === "normal" ? theme.accent : test.status === "high" ? theme.warning : theme.primary)
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }
        }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 14,
            fontWeight: 600,
            color: theme.text
          }
        }, test.name), /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 12,
            color: theme.textSecondary,
            marginTop: 3
          }
        }, "Ref: ", test.range, " ", test.unit)), /*#__PURE__*/React.createElement("div", {
          style: {
            textAlign: "right"
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 18,
            fontWeight: 700,
            color: test.status === "normal" ? theme.text : test.status === "high" ? theme.warning : "#1565C0"
          }
        }, test.value, " ", /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 11,
            fontWeight: 400,
            color: theme.textSecondary
          }
        }, test.unit)), /*#__PURE__*/React.createElement("div", {
          style: {
            marginTop: 4
          }
        }, /*#__PURE__*/React.createElement(StatusBadge, {
          status: test.status
        })))), (() => {
          const nt = getNumericTrend(getTestTrend(report.patientId, test.name));
          return nt.length > 1 && /*#__PURE__*/React.createElement("div", {
            style: {
              marginTop: 10,
              borderTop: "1px solid " + theme.border,
              paddingTop: 10
            }
          }, /*#__PURE__*/React.createElement(MiniTrendChart, {
            data: nt,
            color: test.status === "normal" ? theme.accent : theme.warning,
            height: 40,
            abnormalFlags: nt.map(d => getAbnormalStatus(d))
          }), /*#__PURE__*/React.createElement("div", {
            style: {
              fontSize: 11,
              color: theme.primary,
              fontWeight: 600,
              textAlign: "right",
              marginTop: 4
            }
          }, "Tap for trend"));
        })())));
      }))), ") : null}"));
    }
    return /*#__PURE__*/React.createElement("div", {
      style: {
        paddingBottom: 90
      }
    }, /*#__PURE__*/React.createElement(Header, {
      title: "Patients"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: 20
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "white",
        borderRadius: 14,
        padding: "10px 16px",
        boxShadow: theme.shadow,
        marginBottom: 20
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "search",
      size: 18,
      color: theme.textSecondary
    }), /*#__PURE__*/React.createElement("input", {
      value: searchQuery,
      onChange: e => setSearchQuery(e.target.value),
      placeholder: "Search patients...",
      style: {
        border: "none",
        outline: "none",
        flex: 1,
        fontSize: 14,
        color: theme.text,
        background: "transparent"
      }
    })), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: 40,
        color: theme.textSecondary
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "users",
      size: 48,
      color: theme.border
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        marginTop: 12
      }
    }, patients.length === 0 ? "No patients yet. Upload a report to get started!" : "No matching patients found.")), filtered.map(p => {
      const pR = getPatientReports(p.id);
      const ab = pR.flatMap(r => r.tests).filter(t => t.status !== "normal").length;
      return /*#__PURE__*/React.createElement("div", {
        key: p.id,
        onClick: () => setSelectedPatient(p.id),
        style: {
          background: "white",
          borderRadius: 18,
          padding: 18,
          marginBottom: 12,
          boxShadow: theme.shadow,
          cursor: "pointer"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 14
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          width: 56,
          height: 56,
          borderRadius: 16,
          background: "linear-gradient(135deg, #D97757, #C4623F)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          fontWeight: 700,
          color: "white"
        }
      }, p.avatar), /*#__PURE__*/React.createElement("div", {
        style: {
          flex: 1
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 16,
          fontWeight: 700,
          color: theme.text
        }
      }, p.name), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: theme.textSecondary,
          marginTop: 2
        }
      }, p.age > 0 ? p.age + " yrs" : "", " ", p.sex !== "Unknown" ? "- " + p.sex : ""), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: 12,
          marginTop: 6
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: theme.primary,
          fontWeight: 600
        }
      }, pR.length, " reports"), ab > 0 && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: theme.warning,
          fontWeight: 600
        }
      }, ab, " alerts"))), /*#__PURE__*/React.createElement(Icon, {
        type: "chevron",
        size: 20,
        color: theme.textSecondary
      })));
    })));
  };
  const TrendsScreen = () => {
    const [tp, setTp] = useState(patients[0]?.id || "");
    const [selectedGroup, setSelectedGroup] = useState("");
    const [viewMode, setViewMode] = useState("graph");
    const scrollRef = useRef(null);
    const scrollGroupBy = dir => {
      if (scrollRef.current) scrollRef.current.scrollBy({
        left: dir * 160,
        behavior: "smooth"
      });
    };
    const groupedTests = {};
    const seenNames = {};
    if (tp) {
      reports.filter(r => r.patientId === tp).forEach(r => {
        const allTests = [];
        if (r.testGroups?.length > 0) {
          r.testGroups.forEach(g => {
            const gName = g.group || "Others";
            (g.tests || []).forEach(t => {
              if (t.name) allTests.push({
                name: t.name,
                group: gName
              });
            });
          });
        }
        (r.tests || []).forEach(t => {
          if (t.name) {
            const gName = t.group || "Others";
            if (!allTests.some(a => testNamesMatch(a.name, t.name))) {
              allTests.push({
                name: t.name,
                group: gName
              });
            }
          }
        });
        allTests.forEach(({
          name,
          group
        }) => {
          const key = normalizeTestName(name);
          if (!seenNames[key]) seenNames[key] = name.trim();
          const canonical = seenNames[key];
          if (!groupedTests[group]) groupedTests[group] = new Set();
          groupedTests[group].add(canonical);
        });
      });
    }
    const groupEntries = Object.entries(groupedTests).map(([g, s]) => ({
      group: g,
      tests: [...s]
    }));
    const activeGroup = selectedGroup && groupedTests[selectedGroup] ? selectedGroup : groupEntries[0]?.group || "";
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
    const getGroupColor = idx => groupColors[idx % groupColors.length];
    return /*#__PURE__*/React.createElement("div", {
      style: {
        paddingBottom: 90
      }
    }, /*#__PURE__*/React.createElement(Header, {
      title: "Health Trends"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: 20
      }
    }, patients.length === 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: 40,
        color: theme.textSecondary
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "trend",
      size: 48,
      color: theme.border
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        marginTop: 12
      }
    }, "Upload reports to see health trends over time.")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        background: "white",
        borderRadius: 14,
        padding: 14,
        boxShadow: theme.shadow,
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("label", {
      style: {
        fontSize: 12,
        color: theme.textSecondary,
        fontWeight: 600,
        display: "block",
        marginBottom: 6
      }
    }, "Patient"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        flexWrap: "wrap"
      }
    }, patients.map(p => /*#__PURE__*/React.createElement("button", {
      key: p.id,
      onClick: () => {
        setTp(p.id);
        setSelectedGroup("");
      },
      style: {
        padding: "8px 14px",
        borderRadius: 12,
        border: "none",
        cursor: "pointer",
        background: tp === p.id ? theme.primary : theme.bg,
        color: tp === p.id ? "white" : theme.text,
        fontSize: 12,
        fontWeight: 600
      }
    }, p.name)))), groupEntries.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "group-scroll-wrap",
      style: {
        position: "relative",
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => scrollGroupBy(-1),
      className: "group-scroll-arrow group-scroll-left",
      style: {
        position: "absolute",
        left: -2,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 10,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0,
        fontSize: 48,
        color: theme.textSecondary,
        lineHeight: 1,
        opacity: 0,
        transition: "opacity 0.2s"
      }
    }, "\u2039"), /*#__PURE__*/React.createElement("div", {
      ref: scrollRef,
      style: {
        display: "flex",
        gap: 8,
        overflowX: "auto",
        padding: "4px 12px",
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
        msOverflowStyle: "none"
      }
    }, groupEntries.map((ge, gi) => {
      const isActive = ge.group === activeGroup;
      const gColor = getGroupColor(gi);
      const abnormalCount = ge.tests.reduce((c, tn) => {
        const t = getLatestTest(tp, tn);
        return c + (t && t.status !== "normal" ? 1 : 0);
      }, 0);
      return /*#__PURE__*/React.createElement("button", {
        key: gi,
        onClick: () => {
          setSelectedGroup(ge.group);
        },
        style: {
          flexShrink: 0,
          padding: "10px 16px",
          borderRadius: 14,
          border: isActive ? "2px solid " + gColor : "2px solid " + theme.border,
          background: isActive ? gColor + "12" : "white",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 4,
          minWidth: 120,
          boxShadow: isActive ? "0 2px 8px " + gColor + "25" : theme.shadow
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          width: 8,
          height: 8,
          borderRadius: 4,
          background: gColor,
          flexShrink: 0
        }
      }), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          fontWeight: 700,
          color: isActive ? gColor : theme.text,
          whiteSpace: "nowrap"
        }
      }, ge.group)), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 11,
          color: theme.textSecondary
        }
      }, ge.tests.length, " tests"), abnormalCount > 0 && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 10,
          fontWeight: 600,
          color: theme.warning,
          background: theme.warning + "15",
          padding: "1px 6px",
          borderRadius: 8
        }
      }, abnormalCount, " alert", abnormalCount > 1 ? "s" : "")));
    })), /*#__PURE__*/React.createElement("button", {
      onClick: () => scrollGroupBy(1),
      className: "group-scroll-arrow group-scroll-right",
      style: {
        position: "absolute",
        right: -2,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 10,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0,
        fontSize: 48,
        color: theme.textSecondary,
        lineHeight: 1,
        opacity: 0,
        transition: "opacity 0.2s"
      }
    }, "\u203A")), activeTests.length > 0 && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 10,
        height: 10,
        borderRadius: 5,
        background: getGroupColor(groupEntries.findIndex(g => g.group === activeGroup))
      }
    }), /*#__PURE__*/React.createElement("h3", {
      style: {
        fontSize: 17,
        fontWeight: 700,
        color: theme.text,
        margin: 0
      }
    }, activeGroup), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: theme.textSecondary
      }
    }, activeTests.length, " tests")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        background: theme.bg,
        borderRadius: 10,
        padding: 2
      }
    }, [{
      key: "graph",
      icon: "chart"
    }, {
      key: "table",
      icon: "list"
    }].map(v => /*#__PURE__*/React.createElement("button", {
      key: v.key,
      onClick: () => setViewMode(v.key),
      style: {
        padding: "6px 12px",
        borderRadius: 8,
        border: "none",
        cursor: "pointer",
        background: viewMode === v.key ? "white" : "transparent",
        boxShadow: viewMode === v.key ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
        fontWeight: 600,
        color: viewMode === v.key ? theme.primary : theme.textSecondary
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: v.icon,
      size: 14,
      color: viewMode === v.key ? theme.primary : theme.textSecondary
    }), v.key === "graph" ? "Graph" : "Table")))), viewMode === "table" && (() => {
      const allDates = [...new Set(reports.filter(r => r.patientId === tp).map(r => {
        const n = normalizeDate(r.date);
        return n || r.date;
      }))].sort((a, b) => new Date(b + "T00:00:00") - new Date(a + "T00:00:00"));
      const shortDate = d => {
        try {
          return new Date(d + "T00:00:00").toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short"
          });
        } catch (e) {
          return d;
        }
      };
      return /*#__PURE__*/React.createElement("div", {
        style: {
          background: "white",
          borderRadius: 16,
          boxShadow: theme.shadow,
          overflow: "hidden"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          overflowX: "auto",
          WebkitOverflowScrolling: "touch"
        }
      }, /*#__PURE__*/React.createElement("table", {
        style: {
          width: "100%",
          minWidth: Math.max(360, 140 + allDates.length * 72),
          borderCollapse: "collapse"
        }
      }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
        style: {
          background: theme.bg
        }
      }, /*#__PURE__*/React.createElement("th", {
        style: {
          position: "sticky",
          left: 0,
          background: theme.bg,
          zIndex: 2,
          padding: "10px 12px",
          textAlign: "left",
          fontSize: 10,
          fontWeight: 700,
          color: theme.textSecondary,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          borderBottom: "1px solid " + theme.border,
          minWidth: 120
        }
      }, "Test"), /*#__PURE__*/React.createElement("th", {
        style: {
          padding: "10px 8px",
          textAlign: "center",
          fontSize: 10,
          fontWeight: 700,
          color: theme.textSecondary,
          textTransform: "uppercase",
          borderBottom: "1px solid " + theme.border,
          minWidth: 50
        }
      }, "Ref"), allDates.map((d, di) => /*#__PURE__*/React.createElement("th", {
        key: di,
        style: {
          padding: "10px 8px",
          textAlign: "center",
          fontSize: 10,
          fontWeight: 700,
          color: di === 0 ? theme.primary : theme.textSecondary,
          borderBottom: "1px solid " + theme.border,
          minWidth: 62,
          whiteSpace: "nowrap"
        }
      }, shortDate(d), di === 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 8,
          color: theme.primary,
          fontWeight: 700
        }
      }, "LATEST"))))), /*#__PURE__*/React.createElement("tbody", null, activeTests.map((testName, ti) => {
        const trendData = getTestTrend(tp, testName);
        const latest = getLatestTest(tp, testName);
        const dateMap = {};
        trendData.forEach(d => {
          const nd = normalizeDate(d.date) || d.date;
          dateMap[nd] = d;
        });
        return /*#__PURE__*/React.createElement("tr", {
          key: ti,
          style: {
            borderBottom: ti < activeTests.length - 1 ? "1px solid " + theme.border : "none"
          }
        }, /*#__PURE__*/React.createElement("td", {
          style: {
            position: "sticky",
            left: 0,
            background: "white",
            zIndex: 1,
            padding: "10px 12px",
            fontSize: 13,
            fontWeight: 600,
            color: theme.text
          }
        }, testName), /*#__PURE__*/React.createElement("td", {
          style: {
            padding: "10px 8px",
            textAlign: "center",
            fontSize: 10,
            color: theme.textSecondary,
            whiteSpace: "nowrap"
          }
        }, latest?.range || "N/A"), allDates.map((d, di) => {
          const entry = dateMap[d];
          if (!entry) return /*#__PURE__*/React.createElement("td", {
            key: di,
            style: {
              padding: "10px 8px",
              textAlign: "center",
              fontSize: 12,
              color: theme.border
            }
          }, "-");
          const isAbn = getAbnormalStatus(entry);
          return /*#__PURE__*/React.createElement("td", {
            key: di,
            style: {
              padding: "10px 8px",
              textAlign: "center",
              fontSize: 13,
              fontWeight: di === 0 ? 700 : 600,
              color: isAbn ? "#E53935" : theme.text
            }
          }, entry.rawValue || entry.value);
        }));
      })))));
    })(), viewMode === "graph" && activeTests.map((testName, ti) => {
      const trendData = getTestTrend(tp, testName);
      const numericTrend = getNumericTrend(trendData);
      const latest = getLatestTest(tp, testName);
      const gColorIdx = groupEntries.findIndex(g => g.group === activeGroup);
      const gColor = getGroupColor(gColorIdx >= 0 ? gColorIdx : 0);
      const latestAbn = trendData.length > 0 && getAbnormalStatus(trendData[trendData.length - 1]);
      const prevTrend = numericTrend.length >= 2 ? numericTrend[numericTrend.length - 1].value - numericTrend[numericTrend.length - 2].value : null;
      const abnormalFlags = numericTrend.map(d => getAbnormalStatus(d));
      return /*#__PURE__*/React.createElement("div", {
        key: ti,
        style: {
          background: "white",
          borderRadius: 16,
          marginBottom: 12,
          boxShadow: theme.shadow,
          overflow: "hidden",
          borderLeft: "4px solid " + (latestAbn ? "#E53935" : theme.accent)
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          flex: 1
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 14,
          fontWeight: 600,
          color: theme.text
        }
      }, testName), latest && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          color: theme.textSecondary,
          marginTop: 2
        }
      }, "Ref: ", latest.range, " ", latest.unit)), latest && /*#__PURE__*/React.createElement("div", {
        style: {
          textAlign: "right"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 4,
          justifyContent: "flex-end"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 18,
          fontWeight: 700,
          color: latestAbn ? "#E53935" : theme.text
        }
      }, latest.value), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 11,
          fontWeight: 400,
          color: theme.textSecondary
        }
      }, latest.unit), prevTrend !== null && prevTrend !== 0 && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 14,
          fontWeight: 700,
          color: latestAbn ? "#E53935" : prevTrend > 0 ? theme.warning : theme.accent
        }
      }, prevTrend > 0 ? "\u2191" : "\u2193")), /*#__PURE__*/React.createElement(StatusBadge, {
        status: latestAbn ? latest.status === "low" ? "low" : "high" : "normal"
      }))), trendData.length >= 1 && /*#__PURE__*/React.createElement("div", {
        style: {
          padding: "0 16px 14px"
        }
      }, numericTrend.length >= 2 && /*#__PURE__*/React.createElement(MiniTrendChart, {
        data: numericTrend,
        color: gColor,
        height: 100,
        abnormalFlags: abnormalFlags
      }), /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: numericTrend.length >= 2 ? 10 : 0
        }
      }, [...trendData].reverse().map((d, i, arr) => {
        const origIdx = trendData.length - 1 - i;
        const prev = origIdx > 0 ? trendData[origIdx - 1] : null;
        const isAbn = getAbnormalStatus(d);
        return /*#__PURE__*/React.createElement("div", {
          key: i,
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "6px 0",
            borderBottom: i < arr.length - 1 ? "1px solid " + theme.border : "none"
          }
        }, /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 12,
            color: i === 0 ? theme.text : theme.textSecondary,
            fontWeight: i === 0 ? 600 : 400,
            display: "flex",
            alignItems: "center",
            gap: 6
          }
        }, d.label, i === 0 && /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 9,
            fontWeight: 700,
            color: theme.primary,
            background: theme.primary + "15",
            padding: "1px 5px",
            borderRadius: 4
          }
        }, "LATEST")), /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 14,
            fontWeight: 700,
            color: isAbn ? "#E53935" : theme.text,
            display: "flex",
            alignItems: "center",
            gap: 6
          }
        }, d.rawValue || d.value, " ", d.unit && /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 11,
            fontWeight: 400,
            color: isAbn ? "#E5393590" : theme.textSecondary
          }
        }, d.unit), prev && d.numeric && prev.numeric && /*#__PURE__*/React.createElement("span", {
          style: {
            fontSize: 11,
            fontWeight: 600,
            color: isAbn ? "#E53935" : d.value > prev.value ? theme.warning : d.value < prev.value ? theme.accent : theme.textSecondary
          }
        }, d.value > prev.value ? "\u2191" : d.value < prev.value ? "\u2193" : "=", " ", Math.abs(d.value - prev.value).toFixed(1))));
      })), trendData.length === 1 && /*#__PURE__*/React.createElement("p", {
        style: {
          margin: "6px 0 0",
          fontSize: 11,
          color: theme.textSecondary,
          fontStyle: "italic"
        }
      }, "Upload more reports to see trend")), trendData.length === 0 && !latest && /*#__PURE__*/React.createElement("div", {
        style: {
          padding: "0 16px 12px"
        }
      }, /*#__PURE__*/React.createElement("p", {
        style: {
          margin: 0,
          fontSize: 11,
          color: theme.textSecondary,
          fontStyle: "italic"
        }
      }, "No data available")));
    })), groupEntries.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: 40,
        color: theme.textSecondary
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "chart",
      size: 48,
      color: theme.border
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        marginTop: 12,
        fontSize: 14
      }
    }, "No test data available for this patient.")))));
  };
  const ResultTreeScreen = () => {
    const [tp, setTp] = useState(patients[0]?.id || "");
    const [expandedGroups, setExpandedGroups] = useState({});
    const [hoverInfo, setHoverInfo] = useState(null);
    const patientReports = tp ? reports.filter(r => r.patientId === tp).sort((a, b) => {
      const da = normalizeDate(a.date),
        db = normalizeDate(b.date);
      return new Date((db || "1970-01-01") + "T00:00:00") - new Date((da || "1970-01-01") + "T00:00:00");
    }) : [];
    const allDates = [];
    const dateSet = new Set();
    patientReports.forEach(r => {
      const nd = normalizeDate(r.date) || r.date;
      if (!dateSet.has(nd)) {
        dateSet.add(nd);
        allDates.push(nd);
      }
    });
    const groupedTests = {};
    const seenNames = {};
    patientReports.forEach(r => {
      const allTests = [];
      if (r.testGroups?.length > 0) {
        r.testGroups.forEach(g => {
          (g.tests || []).forEach(t => {
            if (t.name) allTests.push({
              name: t.name,
              group: g.group || "Others"
            });
          });
        });
      }
      (r.tests || []).forEach(t => {
        if (t.name && !allTests.some(a => testNamesMatch(a.name, t.name))) {
          allTests.push({
            name: t.name,
            group: t.group || "Others"
          });
        }
      });
      allTests.forEach(({
        name,
        group
      }) => {
        const key = normalizeTestName(name);
        if (!seenNames[key]) seenNames[key] = name.trim();
        if (!groupedTests[group]) groupedTests[group] = new Set();
        groupedTests[group].add(seenNames[key]);
      });
    });
    const groupEntries = Object.entries(groupedTests).map(([g, s]) => ({
      group: g,
      tests: [...s]
    }));
    if (groupEntries.length > 0 && Object.keys(expandedGroups).length === 0) {
      const init = {};
      groupEntries.forEach(g => init[g.group] = true);
    }
    const isExpanded = g => expandedGroups[g] !== false;
    const toggleGroup = g => setExpandedGroups(prev => ({
      ...prev,
      [g]: !isExpanded(g)
    }));
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
    const shortDate = d => {
      try {
        return new Date(d + "T00:00:00").toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "2-digit"
        });
      } catch (e) {
        return d;
      }
    };
    const groupColors = ["#D97757", "#00C48C", "#FF8C42", "#E040FB", "#FF5252", "#00BCD4", "#8D6E63", "#7C4DFF"];
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement(Header, {
      title: "Result Tree"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "12px 12px 0",
        flexShrink: 0
      }
    }, patients.length === 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: 40,
        color: theme.textSecondary
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "grid",
      size: 48,
      color: theme.border
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        marginTop: 12
      }
    }, "Upload reports to see the result tree.")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        background: "white",
        borderRadius: 14,
        padding: 12,
        boxShadow: theme.shadow,
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        flexWrap: "wrap"
      }
    }, patients.map(p => /*#__PURE__*/React.createElement("button", {
      key: p.id,
      onClick: () => {
        setTp(p.id);
        setExpandedGroups({});
      },
      style: {
        padding: "7px 14px",
        borderRadius: 12,
        border: "none",
        cursor: "pointer",
        background: tp === p.id ? theme.primary : theme.bg,
        color: tp === p.id ? "white" : theme.text,
        fontSize: 12,
        fontWeight: 600
      }
    }, p.name)))))), patients.length > 0 && allDates.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: 40,
        color: theme.textSecondary
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "grid",
      size: 48,
      color: theme.border
    }), /*#__PURE__*/React.createElement("p", {
      style: {
        marginTop: 12,
        fontSize: 14
      }
    }, "No reports found for this patient.")), patients.length > 0 && allDates.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        overflow: "hidden",
        padding: "0 12px 90px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        background: "white",
        borderRadius: 16,
        boxShadow: theme.shadow,
        overflow: "hidden",
        height: "100%"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        overflowX: "auto",
        overflowY: "auto",
        height: "100%",
        WebkitOverflowScrolling: "touch"
      }
    }, /*#__PURE__*/React.createElement("table", {
      style: {
        width: "100%",
        minWidth: Math.max(340, 140 + allDates.length * 70),
        borderCollapse: "collapse"
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
      style: {
        position: "sticky",
        left: 0,
        top: 0,
        zIndex: 4,
        background: theme.primary,
        padding: "12px 12px",
        textAlign: "left",
        color: "white",
        fontSize: 12,
        fontWeight: 700,
        borderBottom: "2px solid " + theme.primary,
        minWidth: 130
      }
    }, "Test / Date \u2192"), allDates.map((d, di) => /*#__PURE__*/React.createElement("th", {
      key: di,
      style: {
        position: "sticky",
        top: 0,
        zIndex: 3,
        padding: "8px 6px",
        textAlign: "center",
        fontSize: 11,
        fontWeight: 700,
        color: "white",
        background: di === 0 ? "#1565C0" : theme.primary + "CC",
        borderBottom: "2px solid " + (di === 0 ? "#1565C0" : theme.primary),
        minWidth: 62,
        whiteSpace: "nowrap"
      }
    }, shortDate(d), di === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 8,
        fontWeight: 700,
        opacity: 0.9,
        marginTop: 1,
        letterSpacing: 0.5
      }
    }, "\u2605 LATEST"))))), /*#__PURE__*/React.createElement("tbody", null, groupEntries.map((ge, gi) => {
      const gColor = groupColors[gi % groupColors.length];
      const expanded = isExpanded(ge.group);
      const abnCount = ge.tests.reduce((c, tn) => {
        const t = allDates.length > 0 ? getValueAtDate(tn, allDates[0]) : null;
        if (t) {
          const td = {
            value: parseFloat(String(t.value).replace(/[<>]/g, "")),
            range: t.range,
            status: t.status,
            numeric: !isNaN(parseFloat(String(t.value).replace(/[<>]/g, "")))
          };
          if (getAbnormalStatus(td)) return c + 1;
        }
        return c;
      }, 0);
      return /*#__PURE__*/React.createElement(React.Fragment, {
        key: gi
      }, /*#__PURE__*/React.createElement("tr", {
        onClick: () => toggleGroup(ge.group),
        style: {
          cursor: "pointer",
          background: gColor + "10"
        }
      }, /*#__PURE__*/React.createElement("td", {
        colSpan: 1 + allDates.length,
        style: {
          position: "sticky",
          left: 0,
          zIndex: 2,
          padding: "10px 12px",
          borderBottom: "1px solid " + theme.border,
          background: gColor + "10"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 14,
          fontWeight: 400,
          color: gColor,
          transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          display: "inline-block"
        }
      }, "\u25B6"), /*#__PURE__*/React.createElement("div", {
        style: {
          width: 8,
          height: 8,
          borderRadius: 4,
          background: gColor
        }
      }), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 14,
          fontWeight: 700,
          color: gColor
        }
      }, ge.group), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 11,
          color: theme.textSecondary
        }
      }, ge.tests.length, " tests"), abnCount > 0 && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 10,
          fontWeight: 600,
          color: "#E53935",
          background: "#E5393515",
          padding: "1px 6px",
          borderRadius: 8
        }
      }, abnCount, " alert", abnCount > 1 ? "s" : "")))), expanded && ge.tests.map((testName, ti) => /*#__PURE__*/React.createElement("tr", {
        key: ti
      }, /*#__PURE__*/React.createElement("td", {
        style: {
          position: "sticky",
          left: 0,
          zIndex: 1,
          background: "white",
          padding: "8px 12px 8px 32px",
          fontSize: 12,
          fontWeight: 600,
          color: theme.text,
          borderBottom: "1px solid " + theme.border,
          borderLeft: "3px solid " + gColor
        }
      }, /*#__PURE__*/React.createElement("div", null, testName), (() => {
        const lt = allDates.length > 0 ? getValueAtDate(testName, allDates[0]) : null;
        return lt ? /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 10,
            color: theme.textSecondary,
            marginTop: 1
          }
        }, "Ref: ", lt.range || "N/A") : null;
      })()), allDates.map((dateStr, di) => {
        const t = getValueAtDate(testName, dateStr);
        if (!t) return /*#__PURE__*/React.createElement("td", {
          key: di,
          style: {
            padding: "8px 6px",
            textAlign: "center",
            fontSize: 12,
            color: theme.border,
            borderBottom: "1px solid " + theme.border
          }
        }, "-");
        const numVal = parseFloat(String(t.value).replace(/[<>]/g, "").trim());
        const td = {
          value: numVal,
          range: t.range,
          status: t.status,
          numeric: !isNaN(numVal)
        };
        const isAbn = getAbnormalStatus(td);
        return /*#__PURE__*/React.createElement("td", {
          key: di,
          onMouseEnter: e => {
            if (t.interpretation) {
              const rect = e.currentTarget.getBoundingClientRect();
              setHoverInfo({
                x: rect.left + rect.width / 2,
                y: rect.top,
                test: t
              });
            }
          },
          onMouseLeave: () => setHoverInfo(null),
          onClick: e => {
            if (t.interpretation) {
              const rect = e.currentTarget.getBoundingClientRect();
              setHoverInfo(prev => prev?.test === t ? null : {
                x: rect.left + rect.width / 2,
                y: rect.top,
                test: t
              });
            }
          },
          style: {
            padding: "8px 6px",
            textAlign: "center",
            fontSize: 13,
            fontWeight: di === 0 ? 700 : 500,
            color: isAbn ? "#E53935" : di === 0 ? "#1565C0" : theme.text,
            background: isAbn ? "#E5393508" : di === 0 ? "#E3F2FD" : "transparent",
            borderBottom: "1px solid " + theme.border,
            cursor: t.interpretation ? "pointer" : "default",
            textDecoration: t.interpretation ? "underline dotted" : "none",
            textDecorationColor: t.interpretation ? isAbn ? "#E5393560" : theme.textSecondary : "transparent",
            textUnderlineOffset: 3
          }
        }, t.value);
      }))));
    })))))), hoverInfo && hoverInfo.test?.interpretation && /*#__PURE__*/React.createElement("div", {
      style: {
        position: "fixed",
        zIndex: 200,
        left: Math.min(Math.max(hoverInfo.x, 120), window.innerWidth - 120),
        top: Math.max(hoverInfo.y - 10, 60),
        transform: "translate(-50%, -100%)",
        background: "#1A2138",
        color: "white",
        borderRadius: 12,
        padding: "10px 14px",
        maxWidth: 260,
        minWidth: 140,
        boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
        pointerEvents: "none"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 700,
        color: hoverInfo.test.status === "normal" ? "#66BB6A" : hoverInfo.test.status === "high" ? "#FFB74D" : "#64B5F6",
        marginBottom: 4,
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("span", null, hoverInfo.test.name), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        opacity: 0.7
      }
    }, "(", hoverInfo.test.value, " ", hoverInfo.test.unit, ")")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: "rgba(255,255,255,0.85)",
        lineHeight: 1.5
      }
    }, (() => {
      const txt = hoverInfo.test.interpretation || "";
      const srcMatch = txt.match(/\(Source:\s*([^)]+)\)/i);
      const mainText = txt.replace(/\s*\(Source:\s*[^)]+\)/i, "").trim();
      return /*#__PURE__*/React.createElement(React.Fragment, null, mainText, srcMatch && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 9,
          color: "rgba(255,255,255,0.5)",
          marginTop: 4,
          fontStyle: "italic"
        }
      }, "Source: ", srcMatch[1]));
    })()), /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        bottom: -6,
        left: "50%",
        transform: "translateX(-50%)",
        width: 0,
        height: 0,
        borderLeft: "6px solid transparent",
        borderRight: "6px solid transparent",
        borderTop: "6px solid #1A2138"
      }
    })));
  };
  const SettingsScreen = () => /*#__PURE__*/React.createElement("div", {
    style: {
      paddingBottom: 90
    }
  }, /*#__PURE__*/React.createElement(Header, {
    title: "Settings"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "white",
      borderRadius: 18,
      boxShadow: theme.shadow,
      overflow: "hidden"
    }
  }, [{
    label: "App Name",
    value: "My Health Plus",
    desc: "Customizable"
  }, {
    label: "AI Engine",
    value: "Claude Sonnet",
    desc: "For extraction & analysis"
  }, {
    label: "Formats",
    value: "PDF, DOCX, JPG, PNG",
    desc: "Supported uploads"
  }, {
    label: "PDF Reader",
    value: "pdf.js",
    desc: "Text extraction from PDFs"
  }, {
    label: "Doc Reader",
    value: "Mammoth.js",
    desc: "Word document support"
  }, {
    label: "Image OCR",
    value: "Claude Vision API",
    desc: "Image-based reports"
  }, {
    label: "Platform",
    value: "iOS & Android",
    desc: "Cross-platform ready"
  }].map((item, i, arr) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      padding: "14px 20px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      borderBottom: i < arr.length - 1 ? "1px solid " + theme.border : "none"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: theme.text
    }
  }, item.label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: theme.textSecondary,
      marginTop: 2
    }
  }, item.desc)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: theme.primary,
      fontWeight: 500,
      textAlign: "right",
      maxWidth: "45%"
    }
  }, item.value)))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFF8E1",
      border: "1px solid #FFE082",
      borderRadius: 14,
      padding: 16,
      marginTop: 20,
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 13,
      color: "#5D4037",
      fontWeight: 600,
      marginBottom: 6
    }
  }, "Medical Disclaimer"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 12,
      color: "#5D4037",
      lineHeight: 1.6
    }
  }, "This app uses AI for informational purposes only. Always consult a qualified physician for diagnosis and treatment."))));
  const AnalysisModal = () => {
    const report = reports.find(r => r.id === showAnalysis);
    if (!report) return null;
    const abnormalTests = report.tests.filter(t => t.status !== "normal");
    return /*#__PURE__*/React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 300,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)"
      },
      onClick: e => {
        if (e.target === e.currentTarget) setShowAnalysis(null);
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        background: "white",
        borderRadius: "24px 24px 0 0",
        width: "100%",
        maxWidth: 430,
        padding: "24px 24px 40px",
        maxHeight: "80vh",
        overflowY: "auto"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 20
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 40,
        height: 40,
        borderRadius: 12,
        background: "linear-gradient(135deg, #D97757, #C4623F)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "ai",
      size: 22,
      color: "white"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
      style: {
        margin: 0,
        fontSize: 17,
        fontWeight: 700,
        color: theme.text
      }
    }, "AI Analysis"), /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 12,
        color: theme.textSecondary
      }
    }, "Powered by Claude"))), /*#__PURE__*/React.createElement("button", {
      onClick: () => setShowAnalysis(null),
      style: {
        background: theme.bg,
        border: "none",
        borderRadius: 10,
        padding: 6,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "close",
      size: 18,
      color: theme.textSecondary
    }))), analysisLoading ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: "30px 0"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 60,
        height: 60,
        borderRadius: 30,
        background: theme.primary + "10",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        margin: "0 auto 16px",
        animation: "pulse 1.5s ease-in-out infinite"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "ai",
      size: 28,
      color: theme.primary
    })), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 14,
        fontWeight: 600,
        color: theme.text
      }
    }, "Generating AI analysis..."), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 12,
        color: theme.textSecondary
      }
    }, "Reviewing ", report.tests.length, " test results")) : analysisData ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        background: "linear-gradient(135deg, #D97757, #C4623F)",
        borderRadius: 14,
        padding: "14px 16px",
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 13,
        color: "rgba(255,255,255,0.85)",
        lineHeight: 1.6
      }
    }, analysisData.summary)), (analysisData.sections || []).map((section, si) => {
      const iconMap = {
        findings: {
          icon: "trend",
          bg: "#E8F4FD",
          color: "#1565C0"
        },
        warning: {
          icon: "alert",
          bg: "#FFF3E0",
          color: "#E65100"
        },
        check: {
          icon: "check",
          bg: "#E8F5E9",
          color: "#2E7D32"
        },
        recommend: {
          icon: "ai",
          bg: "#F3E5F5",
          color: "#7B1FA2"
        }
      };
      const style = iconMap[section.icon] || iconMap.findings;
      return /*#__PURE__*/React.createElement("div", {
        key: si,
        style: {
          marginBottom: 14
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          width: 28,
          height: 28,
          borderRadius: 8,
          background: style.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0
        }
      }, /*#__PURE__*/React.createElement(Icon, {
        type: style.icon,
        size: 14,
        color: style.color
      })), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          fontWeight: 700,
          color: theme.text
        }
      }, section.title)), /*#__PURE__*/React.createElement("div", {
        style: {
          paddingLeft: 4
        }
      }, (section.points || []).map((point, pi) => /*#__PURE__*/React.createElement("div", {
        key: pi,
        style: {
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          padding: "7px 12px",
          background: style.bg + "88",
          borderRadius: 10,
          marginBottom: 6,
          borderLeft: "3px solid " + style.color + "55"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          color: style.color,
          fontSize: 16,
          lineHeight: 1,
          marginTop: 1,
          flexShrink: 0
        }
      }, "\u2022"), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          color: theme.text,
          lineHeight: 1.5
        }
      }, point)))));
    })) : /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: "20px 0",
        color: theme.textSecondary,
        fontSize: 13
      }
    }, "Analysis could not be generated. Please try again."), /*#__PURE__*/React.createElement("div", {
      style: {
        background: "#FFF8E1",
        border: "1px solid #FFE082",
        borderRadius: 14,
        padding: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "alert",
      size: 20,
      color: "#F9A825"
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 13,
        fontWeight: 700,
        color: "#5D4037",
        marginBottom: 4
      }
    }, "Important Notice"), /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 12,
        color: "#5D4037",
        lineHeight: 1.5
      }
    }, "This AI analysis is for informational purposes only and does not constitute medical advice. Please consult your physician for proper diagnosis and treatment."))))));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: pageStyle
  }, /*#__PURE__*/React.createElement("style", null, `
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes loading { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { width: 0; height: 0; }
        .group-scroll-wrap:hover .group-scroll-arrow { opacity: 0.6 !important; }
        .group-scroll-arrow:hover { opacity: 1 !important; }
        body { margin: 0; padding: 0; background: ${theme.bg}; }
      `), activeTab === "home" && /*#__PURE__*/React.createElement(HomeScreen, null), activeTab === "patients" && /*#__PURE__*/React.createElement(PatientsScreen, null), activeTab === "trends" && /*#__PURE__*/React.createElement(TrendsScreen, null), activeTab === "results" && /*#__PURE__*/React.createElement(ResultTreeScreen, null), /*#__PURE__*/React.createElement(BottomNav, null), showUpload && UploadModal(), showAnalysis && AnalysisModal(), showSettings && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 300,
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "center",
      background: "rgba(0,0,0,0.5)",
      backdropFilter: "blur(4px)"
    },
    onClick: e => {
      if (e.target === e.currentTarget) {
        setShowSettings(false);
        setEditingPatient(null);
        setEditingReport(null);
      }
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "white",
      borderRadius: "24px 24px 0 0",
      width: "100%",
      maxWidth: 430,
      padding: "20px 20px 36px",
      maxHeight: "88vh",
      overflowY: "auto",
      animation: "slideUp 0.3s ease"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      fontSize: 17,
      fontWeight: 700,
      color: theme.text
    }
  }, "Settings"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setShowSettings(false);
      setEditingPatient(null);
      setEditingReport(null);
    },
    style: {
      background: theme.bg,
      border: "none",
      borderRadius: 10,
      padding: 6,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    type: "close",
    size: 18,
    color: theme.textSecondary
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      marginBottom: 16,
      background: theme.bg,
      borderRadius: 12,
      padding: 4
    }
  }, [{
    id: "patients",
    label: "Demographics"
  }, {
    id: "labs",
    label: "Lab Data"
  }, {
    id: "info",
    label: "App Info"
  }].map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    onClick: () => {
      setSettingsTab(t.id);
      setEditingPatient(null);
      setEditingReport(null);
    },
    style: {
      flex: 1,
      padding: "8px 6px",
      border: "none",
      borderRadius: 10,
      fontSize: 12,
      fontWeight: 600,
      cursor: "pointer",
      background: settingsTab === t.id ? theme.primary : "transparent",
      color: settingsTab === t.id ? "white" : theme.textSecondary
    }
  }, t.label))), settingsTab === "patients" && !editingPatient && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 12,
      color: theme.textSecondary,
      margin: "0 0 12px"
    }
  }, "Tap a patient to edit their information"), patients.length === 0 ? /*#__PURE__*/React.createElement("p", {
    style: {
      textAlign: "center",
      color: theme.textSecondary,
      fontSize: 13,
      padding: 20
    }
  }, "No patients yet. Upload a report first.") : patients.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    onClick: () => setEditingPatient({
      ...p
    }),
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "12px 14px",
      background: theme.bg,
      borderRadius: 14,
      marginBottom: 8,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 42,
      height: 42,
      borderRadius: 12,
      background: "linear-gradient(135deg, #D97757, #C4623F)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 14,
      fontWeight: 700,
      color: "white",
      flexShrink: 0
    }
  }, p.avatar), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: theme.text
    }
  }, p.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: theme.textSecondary
    }
  }, p.age > 0 ? p.age + " yrs" : "Age N/A", " \xB7 ", p.sex, " \xB7 ", reports.filter(r => r.patientId === p.id).length, " reports")), /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: theme.textSecondary,
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M9 18l6-6-6-6"
  }))))), settingsTab === "patients" && editingPatient && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    onClick: () => setEditingPatient(null),
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      background: "none",
      border: "none",
      cursor: "pointer",
      fontSize: 13,
      color: theme.primary,
      fontWeight: 600,
      marginBottom: 14,
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M15 18l-6-6 6-6"
  })), " Back to list"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 50,
      height: 50,
      borderRadius: 14,
      background: "linear-gradient(135deg, #D97757, #C4623F)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 18,
      fontWeight: 700,
      color: "white"
    }
  }, editingPatient.avatar), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 700,
      color: theme.text
    }
  }, "Edit Patient"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: theme.textSecondary
    }
  }, "Update demographics"))), [{
    key: "name",
    label: "Full Name",
    type: "text"
  }, {
    key: "age",
    label: "Age",
    type: "number"
  }, {
    key: "sex",
    label: "Sex",
    type: "select",
    options: ["Male", "Female", "Other", "Unknown"]
  }, {
    key: "phone",
    label: "Phone",
    type: "tel"
  }, {
    key: "address",
    label: "Address",
    type: "text"
  }, {
    key: "dateOfBirth",
    label: "Date of Birth",
    type: "text"
  }, {
    key: "referredBy",
    label: "Referred By",
    type: "text"
  }].map(field => /*#__PURE__*/React.createElement("div", {
    key: field.key,
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      fontSize: 12,
      fontWeight: 600,
      color: theme.textSecondary,
      marginBottom: 4,
      display: "block"
    }
  }, field.label), field.type === "select" ? /*#__PURE__*/React.createElement("select", {
    value: editingPatient[field.key] || "",
    onChange: e => setEditingPatient(prev => ({
      ...prev,
      [field.key]: e.target.value
    })),
    style: {
      width: "100%",
      padding: "10px 12px",
      border: "1.5px solid " + theme.border,
      borderRadius: 10,
      fontSize: 14,
      background: "white",
      color: theme.text,
      outline: "none"
    }
  }, field.options.map(o => /*#__PURE__*/React.createElement("option", {
    key: o,
    value: o
  }, o))) : /*#__PURE__*/React.createElement("input", {
    value: editingPatient[field.key] || "",
    onChange: e => setEditingPatient(prev => ({
      ...prev,
      [field.key]: field.type === "number" ? e.target.value : e.target.value
    })),
    type: field.type,
    style: {
      width: "100%",
      padding: "10px 12px",
      border: "1.5px solid " + theme.border,
      borderRadius: 10,
      fontSize: 14,
      color: theme.text,
      outline: "none"
    },
    placeholder: "Enter " + field.label.toLowerCase()
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const updated = {
        ...editingPatient,
        age: parseInt(editingPatient.age) || 0
      };
      const parts = (updated.name || "").trim().split(/\s+/);
      updated.avatar = parts.map(n => (n[0] || "").toUpperCase()).join("").slice(0, 2) || "??";
      setPatients(prev => prev.map(p => p.id === updated.id ? updated : p));
      setEditingPatient(null);
    },
    style: {
      width: "100%",
      padding: "13px",
      background: "linear-gradient(135deg, #D97757, #C4623F)",
      color: "white",
      border: "none",
      borderRadius: 14,
      fontSize: 15,
      fontWeight: 700,
      cursor: "pointer",
      marginTop: 6
    }
  }, "Save Changes")), settingsTab === "labs" && !editingReport && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 12,
      color: theme.textSecondary,
      margin: "0 0 12px"
    }
  }, "Tap a report to edit test results & reference ranges"), reports.length === 0 ? /*#__PURE__*/React.createElement("p", {
    style: {
      textAlign: "center",
      color: theme.textSecondary,
      fontSize: 13,
      padding: 20
    }
  }, "No reports yet. Upload a report first.") : reports.map(r => {
    const p = patients.find(pt => pt.id === r.patientId);
    const abnCount = r.tests.filter(t => t.status !== "normal").length;
    return /*#__PURE__*/React.createElement("div", {
      key: r.id,
      onClick: () => {
        setEditingReport(r.id);
        setEditingTests(r.tests.map(t => ({
          ...t
        })));
      },
      style: {
        padding: "12px 14px",
        background: theme.bg,
        borderRadius: 14,
        marginBottom: 8,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: 600,
        color: theme.text
      }
    }, r.labName), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: theme.textSecondary
      }
    }, p?.name || "Unknown", " \xB7 ", formatTestDate(r.date))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontWeight: 600,
        color: theme.textSecondary,
        background: theme.border,
        padding: "3px 8px",
        borderRadius: 8
      }
    }, r.tests.length, " tests"), abnCount > 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontWeight: 600,
        color: "#E65100",
        background: "#FFF3E0",
        padding: "3px 8px",
        borderRadius: 8
      }
    }, abnCount, " abnormal"), /*#__PURE__*/React.createElement("svg", {
      width: "16",
      height: "16",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: theme.textSecondary,
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M9 18l6-6-6-6"
    })))));
  })), settingsTab === "labs" && editingReport && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditingReport(null);
      setEditingTests([]);
    },
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      background: "none",
      border: "none",
      cursor: "pointer",
      fontSize: 13,
      color: theme.primary,
      fontWeight: 600,
      marginBottom: 14,
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M15 18l-6-6 6-6"
  })), " Back to reports"), (() => {
    const rep = reports.find(r => r.id === editingReport);
    const pat = patients.find(p => p.id === rep?.patientId);
    if (!rep) return null;
    const groups = [...new Set(editingTests.map(t => t.group))];
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 16,
        fontWeight: 700,
        color: theme.text
      }
    }, rep.labName), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: theme.textSecondary
      }
    }, pat?.name, " \xB7 ", formatTestDate(rep.date), " \xB7 ", editingTests.length, " tests")), groups.map(g => /*#__PURE__*/React.createElement("div", {
      key: g,
      style: {
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: theme.primary,
        marginBottom: 8,
        padding: "6px 10px",
        background: theme.primary + "10",
        borderRadius: 8
      }
    }, g), editingTests.filter(t => t.group === g).map((test, ti) => {
      const idx = editingTests.indexOf(test);
      return /*#__PURE__*/React.createElement("div", {
        key: idx,
        style: {
          background: theme.bg,
          borderRadius: 12,
          padding: "12px 14px",
          marginBottom: 6,
          border: test.status !== "normal" ? "1.5px solid " + (test.status === "high" ? "#FFB74D" : "#64B5F6") : "1px solid " + theme.border
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8
        }
      }, /*#__PURE__*/React.createElement("input", {
        value: test.name,
        onChange: e => {
          const t = [...editingTests];
          t[idx] = {
            ...t[idx],
            name: e.target.value
          };
          setEditingTests(t);
        },
        style: {
          fontSize: 14,
          fontWeight: 600,
          color: theme.text,
          border: "none",
          background: "transparent",
          outline: "none",
          flex: 1
        },
        placeholder: "Test name"
      }), /*#__PURE__*/React.createElement("select", {
        value: test.status,
        onChange: e => {
          const t = [...editingTests];
          t[idx] = {
            ...t[idx],
            status: e.target.value
          };
          setEditingTests(t);
        },
        style: {
          fontSize: 11,
          fontWeight: 700,
          padding: "4px 8px",
          borderRadius: 8,
          border: "none",
          cursor: "pointer",
          background: test.status === "normal" ? "#E8F5E9" : test.status === "high" ? "#FFF3E0" : "#E3F2FD",
          color: test.status === "normal" ? "#2E7D32" : test.status === "high" ? "#E65100" : "#1565C0"
        }
      }, /*#__PURE__*/React.createElement("option", {
        value: "normal"
      }, "Normal"), /*#__PURE__*/React.createElement("option", {
        value: "high"
      }, "High"), /*#__PURE__*/React.createElement("option", {
        value: "low"
      }, "Low"))), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1.3fr",
          gap: 8
        }
      }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
        style: {
          fontSize: 10,
          fontWeight: 600,
          color: theme.textSecondary,
          display: "block",
          marginBottom: 3
        }
      }, "Value"), /*#__PURE__*/React.createElement("input", {
        value: test.value,
        onChange: e => {
          const t = [...editingTests];
          t[idx] = {
            ...t[idx],
            value: e.target.value
          };
          setEditingTests(t);
        },
        style: {
          width: "100%",
          padding: "7px 8px",
          border: "1px solid " + theme.border,
          borderRadius: 8,
          fontSize: 13,
          color: theme.text,
          outline: "none"
        }
      })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
        style: {
          fontSize: 10,
          fontWeight: 600,
          color: theme.textSecondary,
          display: "block",
          marginBottom: 3
        }
      }, "Unit"), /*#__PURE__*/React.createElement("input", {
        value: test.unit,
        onChange: e => {
          const t = [...editingTests];
          t[idx] = {
            ...t[idx],
            unit: e.target.value
          };
          setEditingTests(t);
        },
        style: {
          width: "100%",
          padding: "7px 8px",
          border: "1px solid " + theme.border,
          borderRadius: 8,
          fontSize: 13,
          color: theme.text,
          outline: "none"
        }
      })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
        style: {
          fontSize: 10,
          fontWeight: 600,
          color: theme.textSecondary,
          display: "block",
          marginBottom: 3
        }
      }, "Ref Range"), /*#__PURE__*/React.createElement("input", {
        value: test.range || "",
        onChange: e => {
          const t = [...editingTests];
          t[idx] = {
            ...t[idx],
            range: e.target.value
          };
          setEditingTests(t);
        },
        style: {
          width: "100%",
          padding: "7px 8px",
          border: "1px solid " + theme.border,
          borderRadius: 8,
          fontSize: 13,
          color: theme.text,
          outline: "none"
        },
        placeholder: "e.g. 4.0-11.0"
      }))), /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: 8
        }
      }, /*#__PURE__*/React.createElement("label", {
        style: {
          fontSize: 10,
          fontWeight: 600,
          color: theme.textSecondary,
          display: "block",
          marginBottom: 3
        }
      }, "Interpretation"), /*#__PURE__*/React.createElement("input", {
        value: test.interpretation || "",
        onChange: e => {
          const t = [...editingTests];
          t[idx] = {
            ...t[idx],
            interpretation: e.target.value
          };
          setEditingTests(t);
        },
        style: {
          width: "100%",
          padding: "7px 8px",
          border: "1px solid " + theme.border,
          borderRadius: 8,
          fontSize: 12,
          color: theme.text,
          outline: "none"
        },
        placeholder: "Clinical meaning or notes"
      })));
    }))), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setReports(prev => prev.map(r => {
          if (r.id !== editingReport) return r;
          const groupMap = {};
          editingTests.forEach(t => {
            const g = t.group || "Others";
            if (!groupMap[g]) groupMap[g] = [];
            groupMap[g].push(t);
          });
          const newGroups = Object.entries(groupMap).map(([group, tests]) => ({
            group,
            tests
          }));
          return {
            ...r,
            tests: editingTests,
            testGroups: newGroups
          };
        }));
        setEditingReport(null);
        setEditingTests([]);
      },
      style: {
        width: "100%",
        padding: "13px",
        background: "linear-gradient(135deg, #D97757, #C4623F)",
        color: "white",
        border: "none",
        borderRadius: 14,
        fontSize: 15,
        fontWeight: 700,
        cursor: "pointer",
        marginTop: 6
      }
    }, "Save All Changes"));
  })()), settingsTab === "info" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 14,
      overflow: "hidden",
      border: "1px solid " + theme.border
    }
  }, [{
    label: "App Name",
    value: "My Health Plus"
  }, {
    label: "AI Engine",
    value: "Claude Sonnet"
  }, {
    label: "Formats",
    value: "PDF, DOCX, JPG, PNG"
  }, {
    label: "PDF Reader",
    value: "pdf.js"
  }, {
    label: "Doc Reader",
    value: "Mammoth.js"
  }, {
    label: "Image OCR",
    value: "Claude Vision API"
  }].map((item, i, arr) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      padding: "12px 16px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      borderBottom: i < arr.length - 1 ? "1px solid " + theme.border : "none"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      color: theme.text
    }
  }, item.label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: theme.primary,
      fontWeight: 500
    }
  }, item.value)))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFF8E1",
      border: "1px solid #FFE082",
      borderRadius: 12,
      padding: 14,
      marginTop: 16,
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 12,
      color: "#5D4037",
      fontWeight: 600,
      marginBottom: 4
    }
  }, "Medical Disclaimer"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 11,
      color: "#5D4037",
      lineHeight: 1.5
    }
  }, "This app uses AI for informational purposes only. Always consult a qualified physician."))))), showReportViewer && (() => {
    const report = reports.find(r => r.id === selectedReport);
    if (!report?.fileData) {
      setShowReportViewer(false);
      return null;
    }
    const isPdf = report.fileType?.includes("pdf") || report.fileName?.toLowerCase().endsWith(".pdf");
    const isImage = report.fileType?.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(report.fileName || "");
    const handleClose = () => setShowReportViewer(false);
    const handleDownload = () => {
      const a = document.createElement("a");
      a.href = report.fileData;
      a.download = report.fileName || "report";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 400,
        background: "#000000ee",
        display: "flex",
        flexDirection: "column"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        background: "#1A2138",
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "file",
      size: 18,
      color: "white"
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "white",
        fontSize: 14,
        fontWeight: 600,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis"
      }
    }, report.fileName)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: handleDownload,
      style: {
        background: "rgba(255,255,255,0.15)",
        border: "none",
        borderRadius: 8,
        padding: "6px 12px",
        cursor: "pointer",
        color: "white",
        fontSize: 12,
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("svg", {
      style: {
        width: 14,
        height: 14
      },
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
    })), "Save"), /*#__PURE__*/React.createElement("button", {
      onClick: handleClose,
      style: {
        background: "rgba(255,255,255,0.15)",
        border: "none",
        borderRadius: 8,
        padding: 6,
        cursor: "pointer",
        display: "flex"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "close",
      size: 20,
      color: "white"
    })))), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        overflow: "auto",
        padding: 8
      }
    }, isPdf && /*#__PURE__*/React.createElement(PDFCanvasViewer, {
      fileData: report.fileData
    }), isImage && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100%"
      }
    }, /*#__PURE__*/React.createElement("img", {
      src: report.fileData,
      alt: report.fileName,
      style: {
        maxWidth: "100%",
        maxHeight: "100%",
        objectFit: "contain",
        borderRadius: 8
      }
    })), !isPdf && !isImage && /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: 40
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 80,
        height: 80,
        borderRadius: 20,
        background: "rgba(255,255,255,0.1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        margin: "0 auto 20px"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      type: "file",
      size: 40,
      color: "white"
    })), /*#__PURE__*/React.createElement("p", {
      style: {
        color: "white",
        fontSize: 16,
        fontWeight: 600,
        marginBottom: 8
      }
    }, report.fileName), /*#__PURE__*/React.createElement("p", {
      style: {
        color: "rgba(255,255,255,0.6)",
        fontSize: 13,
        marginBottom: 20
      }
    }, "This file type cannot be previewed in-app."), /*#__PURE__*/React.createElement("button", {
      onClick: handleDownload,
      style: {
        padding: "14px 32px",
        background: theme.primary,
        color: "white",
        border: "none",
        borderRadius: 14,
        fontSize: 15,
        fontWeight: 700,
        cursor: "pointer"
      }
    }, "Download to View"))));
  })());
}
window.MyHealthPlus = MyHealthPlus;
(function () {
  function mount() {
    var rootEl = document.getElementById('root');
    if (!rootEl) return;
    ReactDOM.createRoot(rootEl).render(React.createElement(MyHealthPlus));
    setTimeout(function () {
      var s = document.getElementById('splash');
      if (s) {
        s.classList.add('hidden');
        setTimeout(function () {
          if (s.parentNode) s.parentNode.removeChild(s);
        }, 600);
      }
    }, 300);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();

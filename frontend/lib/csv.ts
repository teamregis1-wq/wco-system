/**
 * Shared CSV parsing, validation, and export helpers.
 *
 * The previous importers split rows on "," which corrupted any file containing
 * quoted fields with commas (e.g. an address or a note). This module implements
 * an RFC 4180 parser and validates every row, reporting exactly which rows were
 * rejected and why instead of silently dropping them.
 */

// ── Parsing ───────────────────────────────────────────────────────────────────

export interface ParsedCSV {
  headers: string[];
  /** One record per data row, keyed by normalised header. */
  rows: Record<string, string>[];
  /** 1-based line number in the source file for each row (for error messages). */
  lineNumbers: number[];
}

/** Detect the delimiter — Excel exports use ";" in some locales, ".tsv" uses tabs. */
function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = {
    ",": (headerLine.match(/,/g) ?? []).length,
    ";": (headerLine.match(/;/g) ?? []).length,
    "\t": (headerLine.match(/\t/g) ?? []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ",";
}

/** Normalise a header cell: "WCO Code" → "wco_code". */
function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

/**
 * RFC 4180 CSV parser. Correctly handles quoted fields containing the
 * delimiter, escaped double-quotes (""), CRLF endings, and a UTF-8 BOM.
 */
export function parseCSV(text: string): ParsedCSV {
  const src = text.replace(/^\uFEFF/, "");           // strip BOM
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = detectDelimiter(firstLine);

  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;

  const pushField = () => { cells.push(field); field = ""; };
  const pushRecord = () => {
    cells.push(field); field = "";
    if (cells.some(c => c.trim() !== "")) records.push({ cells, line: recordStartLine });
    cells = [];
    recordStartLine = line;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; }
    else if (c === delim) { pushField(); }
    else if (c === "\r") { /* handled with the following \n */ }
    else if (c === "\n") { line++; pushRecord(); }
    else field += c;
  }
  if (field !== "" || cells.length) pushRecord();

  if (!records.length) return { headers: [], rows: [], lineNumbers: [] };

  const headers = records[0].cells.map(normHeader);
  const rows: Record<string, string>[] = [];
  const lineNumbers: number[] = [];
  for (const rec of records.slice(1)) {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (rec.cells[i] ?? "").trim(); });
    rows.push(row);
    lineNumbers.push(rec.line);
  }
  return { headers, rows, lineNumbers };
}

/** Read the first non-empty value among several accepted header aliases. */
function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== "") return v;
  }
  return "";
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface RowError {
  /** 1-based line number in the source file. */
  line: number;
  message: string;
}

export interface ValidationResult<T> {
  valid: T[];
  errors: RowError[];
}

// ── Date normalisation ────────────────────────────────────────────────────────

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Accepts YYYY-MM-DD (preferred), unambiguous D/M/YYYY or M/D/YYYY, and Excel
 * serial numbers. Truly ambiguous slash dates (e.g. 03/04/2026) are REJECTED
 * rather than guessed — silently importing the wrong date would corrupt the
 * weekly series the forecast is trained on.
 */
export function normalizeDate(raw: string): { value?: string; error?: string } {
  const s = raw.trim();
  if (!s) return { error: "date is empty" };

  // ISO: YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return isRealDate(y, mo, d) ? { value: iso(y, mo, d) } : { error: `"${s}" is not a real calendar date` };
  }

  // Excel serial number (days since 1899-12-30)
  if (/^\d{5}$/.test(s)) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return { value: iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()) };
  }

  // Slash / dash separated
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    if (a > 12 && b <= 12) {
      return isRealDate(y, b, a) ? { value: iso(y, b, a) } : { error: `"${s}" is not a real calendar date` };
    }
    if (b > 12 && a <= 12) {
      return isRealDate(y, a, b) ? { value: iso(y, a, b) } : { error: `"${s}" is not a real calendar date` };
    }
    if (a <= 12 && b <= 12) {
      return { error: `"${s}" is ambiguous (day/month could be either) — use YYYY-MM-DD` };
    }
    return { error: `"${s}" is not a valid date` };
  }

  return { error: `"${s}" is not a recognised date — use YYYY-MM-DD` };
}

// ── Establishments ────────────────────────────────────────────────────────────

export const ESTABLISHMENT_TYPES = ["restaurant", "fast_food", "food_manufacturer"] as const;

/** Map common spellings onto the three accepted type values. */
function normalizeType(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!t) return "restaurant";                       // sensible default
  const aliases: Record<string, string> = {
    restaurant: "restaurant", resto: "restaurant", carinderia: "restaurant",
    eatery: "restaurant", cafe: "restaurant", restaurants: "restaurant",
    fast_food: "fast_food", fastfood: "fast_food", fast_food_chain: "fast_food",
    food_manufacturer: "food_manufacturer", manufacturer: "food_manufacturer",
    food_processor: "food_manufacturer", processor: "food_manufacturer",
    food_manufacturing: "food_manufacturer",
  };
  return aliases[t] ?? null;
}

// Generous bounding box around Batangas — catches swapped lat/lng, which is the
// most common coordinate mistake and silently places sites in the wrong country.
const BBOX = { latMin: 13.2, latMax: 14.4, lngMin: 120.3, lngMax: 121.8 };

export interface EstablishmentImportRow {
  wco_code: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  address: string | null;
  barangay: string | null;
  business_hours: string | null;
  seating_capacity: number | null;
  contact_info: string | null;
  consent_given: true;
}

export function validateEstablishments(parsed: ParsedCSV): ValidationResult<EstablishmentImportRow> {
  const valid: EstablishmentImportRow[] = [];
  const errors: RowError[] = [];
  const seenCodes = new Set<string>();

  parsed.rows.forEach((row, i) => {
    const line = parsed.lineNumbers[i];
    const fail = (msg: string) => errors.push({ line, message: msg });

    const wco_code = pick(row, "wco_code", "code", "wcocode");
    const name = pick(row, "name", "establishment", "establishment_name", "business_name");
    if (!wco_code) return fail("wco_code is required");
    if (!name) return fail("name is required");

    const key = wco_code.toLowerCase();
    if (seenCodes.has(key)) return fail(`duplicate wco_code "${wco_code}" in this file`);

    const type = normalizeType(pick(row, "type", "category", "establishment_type"));
    if (type === null) {
      return fail(`type "${pick(row, "type", "category", "establishment_type")}" is not recognised — use ${ESTABLISHMENT_TYPES.join(", ")}`);
    }

    const latRaw = pick(row, "latitude", "lat", "y");
    const lngRaw = pick(row, "longitude", "lng", "lon", "long", "x");
    if (!latRaw || !lngRaw) return fail("latitude and longitude are required");

    const latitude = Number(latRaw);
    const longitude = Number(lngRaw);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return fail(`latitude/longitude must be numbers (got "${latRaw}", "${lngRaw}")`);
    }
    const inBox = (la: number, ln: number) =>
      la >= BBOX.latMin && la <= BBOX.latMax && ln >= BBOX.lngMin && ln <= BBOX.lngMax;
    if (!inBox(latitude, longitude)) {
      return fail(
        inBox(longitude, latitude)
          ? `coordinates (${latitude}, ${longitude}) look swapped — latitude should come first`
          : `coordinates (${latitude}, ${longitude}) are outside the Batangas area`
      );
    }

    const seatRaw = pick(row, "seating_capacity", "seats", "capacity");
    let seating_capacity: number | null = null;
    if (seatRaw) {
      const n = Number(seatRaw);
      if (!Number.isFinite(n) || n < 0) return fail(`seating_capacity must be a positive number (got "${seatRaw}")`);
      seating_capacity = Math.round(n);
    }

    seenCodes.add(key);
    valid.push({
      wco_code, name, type, latitude, longitude,
      address: pick(row, "address", "street_address") || null,
      barangay: pick(row, "barangay", "brgy", "village") || null,
      business_hours: pick(row, "business_hours", "hours", "operating_hours") || null,
      seating_capacity,
      contact_info: pick(row, "contact_info", "contact", "phone", "contact_number") || null,
      consent_given: true,
    });
  });

  return { valid, errors };
}

// ── WCO records ───────────────────────────────────────────────────────────────

/** Above this a weekly figure is almost certainly a typo or a unit mix-up. */
const MAX_WEEKLY_LITERS = 10_000;

export interface WcoImportRow {
  establishment_id: number;
  week_date: string;
  week_end_date: string | null;
  quantity_liters: number;
  notes: string | null;
}

export function validateWcoRecords(parsed: ParsedCSV, establishmentId: number): ValidationResult<WcoImportRow> {
  const valid: WcoImportRow[] = [];
  const errors: RowError[] = [];
  const seenWeeks = new Set<string>();
  // Allow a little slack for a week that has just started.
  const maxDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

  parsed.rows.forEach((row, i) => {
    const line = parsed.lineNumbers[i];
    const fail = (msg: string) => errors.push({ line, message: msg });

    const dateRaw = pick(row, "week_date", "date", "week", "week_start", "week_starting");
    if (!dateRaw) return fail("week_date is required");
    const d = normalizeDate(dateRaw);
    if (d.error) return fail(`week_date: ${d.error}`);
    const week_date = d.value!;
    if (week_date > maxDate) return fail(`week_date ${week_date} is in the future`);
    if (seenWeeks.has(week_date)) return fail(`duplicate week_date ${week_date} in this file`);

    const qtyRaw = pick(row, "quantity_liters", "quantity", "liters", "litres", "volume", "amount");
    if (!qtyRaw) return fail("quantity_liters is required");
    // Tolerate thousands separators and a trailing unit ("120 L", "1,250")
    const qty = Number(qtyRaw.replace(/,/g, "").replace(/\s*(l|li|liters|litres)\s*$/i, ""));
    if (!Number.isFinite(qty)) return fail(`quantity_liters must be a number (got "${qtyRaw}")`);
    if (qty < 0) return fail(`quantity_liters cannot be negative (got ${qty})`);
    if (qty > MAX_WEEKLY_LITERS) {
      return fail(`quantity_liters ${qty} exceeds ${MAX_WEEKLY_LITERS.toLocaleString()} L — check the units`);
    }

    let week_end_date: string | null = null;
    const endRaw = pick(row, "week_end_date", "end_date", "week_ending");
    if (endRaw) {
      const e = normalizeDate(endRaw);
      if (e.error) return fail(`week_end_date: ${e.error}`);
      if (e.value! < week_date) return fail(`week_end_date ${e.value} is before week_date ${week_date}`);
      week_end_date = e.value!;
    }

    seenWeeks.add(week_date);
    valid.push({
      establishment_id: establishmentId,
      week_date,
      week_end_date,
      quantity_liters: qty,
      notes: pick(row, "notes", "remarks", "comment") || null,
    });
  });

  return { valid, errors };
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Serialise rows to CSV text. Emits a UTF-8 BOM and CRLF endings so Excel
 * renders accented barangay names (e.g. "Bañaga") correctly instead of mojibake.
 */
export function toCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map(r => headers.map(h => escape(r[h])).join(","));
  return "\uFEFF" + [headers.join(","), ...body].join("\r\n") + "\r\n";
}

export function downloadText(text: string, filename: string, mime = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadCSV(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  downloadText(toCSV(rows), filename);
}

// ── Templates ─────────────────────────────────────────────────────────────────

export function downloadEstablishmentTemplate() {
  downloadCSV([
    {
      wco_code: "WCO-001",
      name: "Example Restaurant",
      type: "restaurant",
      latitude: 13.756500,
      longitude: 121.058300,
      address: "123 P. Burgos St.",
      barangay: "Poblacion",
      business_hours: "8:00 AM - 10:00 PM",
      seating_capacity: 40,
      contact_info: "0917-000-0000",
    },
  ], "establishments_template.csv");
}

export function downloadWcoTemplate() {
  downloadCSV([
    { week_date: "2026-01-05", week_end_date: "2026-01-11", quantity_liters: 120.5, notes: "" },
    { week_date: "2026-01-12", week_end_date: "2026-01-18", quantity_liters: 98,    notes: "holiday week" },
  ], "wco_records_template.csv");
}

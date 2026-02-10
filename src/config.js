// Public CSV feed for tasks (Google Sheets)
// Sheet: SNAKESANDLADDERS
export const TASKS_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTPK3XUF7vYVA80h9jXKXmapZmrTotD-D3I5RHHcWlwKzbfAWiaCWspTjiUcCezA274Il2JhQyco-kz/pub?output=csv';

// Edit/view link for the task bank (shown in the UI)
export const TASKS_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1ITLDp3Bp_ohKnw-Zg4gq4JJ-pIAnFMCEp0Rumyx3zdM/edit';

// Target mix per session (rough weights)
export const DEFAULT_TYPE_WEIGHTS = {
  speaking: 3,
  error_correction: 2,
  translate_ca_en: 2,
  translate_en_ca: 2,
};

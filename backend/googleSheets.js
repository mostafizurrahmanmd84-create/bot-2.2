import crypto from 'node:crypto';

export const normalizeQuery = (query = '') => String(query ?? '').trim().toLowerCase();

export const getGoogleSheetConfig = () => ({
  spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim() || '',
  serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || '',
  privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim() || '',
  apiKey: process.env.GOOGLE_API_KEY?.trim() || ''
});

export const isGoogleSheetConfigured = () => {
  const { spreadsheetId, serviceAccountEmail, privateKey, apiKey } = getGoogleSheetConfig();
  return Boolean(spreadsheetId && ((serviceAccountEmail && privateKey) || apiKey));
};

const normalizeCellValue = (value) => value === null || value === undefined ? '' : String(value).trim();
const searchStopWords = new Set(['a', 'an', 'and', 'are', 'can', 'do', 'does', 'for', 'give', 'has', 'have', 'how', 'is', 'me', 'of', 'please', 'show', 'student', 'students', 'tell', 'the', 'their', 'what', 'which', 'who', 'with', 'id']);
const getSearchTerms = (query) => normalizeQuery(query).replace(/[’']s\b/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter((term) => term.length > 1 && !searchStopWords.has(term));

export const searchGoogleSheet = (query, rows = []) => {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return [];
  
  const searchTerms = getSearchTerms(normalizedQuery);

  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') return null;
    
    // সারির সব ভ্যালুকে একসাথে normalised করে খোঁজা
    const values = Object.values(row).map((value) => normalizeQuery(normalizeCellValue(value)));
    const keys = Object.keys(row).map((key) => normalizeQuery(key));

    // পুরো কুয়েরি মিলে যায় কিনা অথবা সার্চ টার্মগুলোর সাথে ম্যাচ করে কিনা
    const exactMatch = values.some((value) => value.includes(normalizedQuery)) || 
                       keys.some((key, i) => normalizedQuery.includes(key) && values[i]?.includes(normalizedQuery.replace(key, '').trim()));

    const score = exactMatch ? searchTerms.length + 2 : searchTerms.reduce((total, term) => total + (values.some((value) => value.includes(term)) ? 1 : 0), 0);
    
    return score > 0 ? { row, score, index } : null;
  })
  .filter(Boolean)
  .sort((left, right) => right.score - left.score || left.index - right.index)
  .slice(0, 20)
  .map(({ row }) => row);
};

const convertSheetRows = (values) => {
  if (!Array.isArray(values) || values.length === 0) return [];
  const headers = values[0].map((header) => String(header || '').trim()).filter(Boolean);
  if (!headers.length) return [];
  return values.slice(1).map((row) => {
    const rowObject = {};
    headers.forEach((header, index) => { rowObject[header] = row[index] ?? ''; });
    return rowObject;
  }).filter((row) => Object.values(row).some((value) => normalizeCellValue(value) !== ''));
};

const createJwt = ({ serviceAccountEmail, privateKey }) => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iss: serviceAccountEmail, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING, format: 'pem' });
  return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
};

const getAccessToken = async ({ serviceAccountEmail, privateKey }) => {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: createJwt({ serviceAccountEmail, privateKey }) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error_description || data?.error || 'Google OAuth token request failed.');
  return data.access_token;
};

export const getGoogleSheetRows = async () => {
  const { spreadsheetId, serviceAccountEmail, privateKey, apiKey } = getGoogleSheetConfig();
  if (!spreadsheetId) throw new Error('Google Sheets credentials are not configured. Please set GOOGLE_SHEET_ID in the backend .env file.');
  const accessToken = serviceAccountEmail && privateKey ? await getAccessToken({ serviceAccountEmail, privateKey }) : '';
  const query = accessToken ? '' : `?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/A:ZZ${query}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Google Sheets request failed.');
  return convertSheetRows(Array.isArray(data?.values) ? data.values : []);
};

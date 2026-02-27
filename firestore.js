// Firestore REST API helpers for NTS Radio extension

const FIREBASE_API_KEY = 'AIzaSyA4Qp5AvHC8Rev72-10-_DY614w_bxUCJU';
const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/nts-ios-app/databases/(default)/documents';

async function refreshAccessToken(refreshToken) {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`
    }
  );
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: parseInt(data.expires_in) * 1000
  };
}

async function firestoreQuery(collectionId, uid, accessToken, options = {}) {
  const { orderBy = 'created_at', limit = 200 } = options;
  const res = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'device_id' },
            op: 'EQUAL',
            value: { stringValue: uid }
          }
        },
        orderBy: [{ field: { fieldPath: orderBy }, direction: 'DESCENDING' }],
        limit
      }
    })
  });
  if (!res.ok) throw new Error(`Firestore query failed: ${res.status}`);
  const results = await res.json();
  return results
    .filter(r => r.document)
    .map(r => ({
      _id: r.document.name.split('/').pop(),
      ...parseFields(r.document.fields)
    }));
}

async function firestoreCreate(collectionId, fields, accessToken) {
  const res = await fetch(`${FIRESTORE_BASE}/${collectionId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: encodeFields(fields) })
  });
  if (!res.ok) throw new Error(`Firestore create failed: ${res.status}`);
  return res.json();
}

async function firestoreDelete(collectionId, docId, accessToken) {
  const res = await fetch(`${FIRESTORE_BASE}/${collectionId}/${docId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Firestore delete failed: ${res.status}`);
}

// Parse Firestore typed fields into plain JS objects
function parseFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = parseValue(v);
  return out;
}

function parseValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return parseFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(parseValue);
  return null;
}

// Encode plain JS objects into Firestore typed fields
function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = encodeValue(v);
  return out;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return { timestampValue: v };
    return { stringValue: v };
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

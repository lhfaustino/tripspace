import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const IADP_HOST = 'crewlink.prd.glo.weur.cloud.lhsystems.com';
const SENSITIVE_NAME = /authorization|cookie|token|secret|password|passwd|session|assertion|credential|(^|_)code($|_)/i;
const SAFE_HEADER_VALUE = new Set(['accept', 'content-type', 'origin']);

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? '.iadp-analysis/iadp-protocol-summary.json';

if (!inputPath) {
  console.error('Uso: npm run iadp:inspect-har -- <captura.har> [resumo.json]');
  process.exitCode = 1;
} else {
  await sanitizeHar(inputPath, outputPath);
}

async function sanitizeHar(source, destination) {
  const har = JSON.parse(await readFile(source, 'utf8'));
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const iadpEntries = entries.filter((entry) => isIadpRequest(entry?.request?.url));
  const summary = {
    generatedAt: new Date().toISOString(),
    source: path.basename(source),
    warning: 'Resumo estrutural sanitizado. Nao contem cookies, tokens ou valores de dados pessoais.',
    requestCount: iadpEntries.length,
    requests: iadpEntries.map(summarizeEntry),
  };

  await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
  await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`${iadpEntries.length} requisicao(oes) IADP sanitizada(s) em ${destination}`);
}

function isIadpRequest(value) {
  try {
    return new URL(value).hostname === IADP_HOST;
  } catch {
    return false;
  }
}

function summarizeEntry(entry) {
  const request = entry.request ?? {};
  const response = entry.response ?? {};
  const responseContent = response.content ?? {};

  return {
    startedDateTime: describeDateTime(entry.startedDateTime),
    request: {
      method: request.method ?? '<unknown>',
      url: summarizeUrl(request.url),
      headerNames: headerNames(request.headers),
      selectedHeaders: selectedHeaders(request.headers),
      body: summarizePostData(request.postData),
    },
    response: {
      status: Number.isInteger(response.status) ? response.status : '<unknown>',
      headerNames: headerNames(response.headers),
      selectedHeaders: selectedHeaders(response.headers),
      redirectUrl: response.redirectURL ? summarizeUrl(response.redirectURL) : null,
      contentType: responseContent.mimeType || null,
      bodySchema: summarizeResponseBody(responseContent),
    },
  };
}

function summarizeUrl(value) {
  try {
    const url = new URL(value);
    const query = {};
    for (const [name, rawValue] of url.searchParams.entries()) {
      const described = SENSITIVE_NAME.test(name) ? '<redacted:sensitive>' : describeString(rawValue);
      query[name] = name in query ? arrayify(query[name], described) : described;
    }

    return {
      origin: url.origin,
      path: url.pathname.split('/').map(sanitizePathSegment).join('/'),
      query,
    };
  } catch {
    return '<invalid-url>';
  }
}

function sanitizePathSegment(segment) {
  if (!segment || /^[a-z][a-z0-9_-]{0,40}$/.test(segment)) return segment;
  return describeString(decodeURIComponent(segment));
}

function headerNames(headers) {
  return [...new Set((headers ?? []).map((header) => String(header.name).toLowerCase()))].sort();
}

function selectedHeaders(headers) {
  const selected = {};
  for (const header of headers ?? []) {
    const name = String(header.name).toLowerCase();
    if (SENSITIVE_NAME.test(name)) continue;
    if (SAFE_HEADER_VALUE.has(name)) {
      selected[name] = name === 'origin' ? safeOrigin(header.value) : String(header.value).slice(0, 200);
    }
    if (name === 'location') selected[name] = summarizeUrl(header.value);
  }
  return selected;
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '<invalid-origin>';
  }
}

function summarizePostData(postData) {
  if (!postData) return null;
  const mimeType = postData.mimeType || null;

  if (Array.isArray(postData.params)) {
    return {
      mimeType,
      parameters: postData.params.map((parameter) => ({
        name: parameter.name,
        value: SENSITIVE_NAME.test(parameter.name)
          ? '<redacted:sensitive>'
          : describeString(parameter.value ?? ''),
        hasFile: Boolean(parameter.fileName),
      })),
    };
  }

  const parsed = tryParseJson(postData.text);
  return {
    mimeType,
    schema: parsed.ok ? schemaOf(parsed.value) : postData.text ? '<non-json-body-present>' : null,
  };
}

function summarizeResponseBody(content) {
  if (!content?.text || content.encoding === 'base64') return null;
  const parsed = tryParseJson(content.text);
  return parsed.ok ? schemaOf(parsed.value) : '<non-json-body-present>';
}

function tryParseJson(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function schemaOf(value, key = '', depth = 0) {
  if (SENSITIVE_NAME.test(key)) return '<redacted:sensitive>';
  if (depth > 8) return '<max-depth>';
  if (value === null) return '<null>';
  if (Array.isArray(value)) {
    const uniqueItems = [...new Set(value.slice(0, 20).map((item) => JSON.stringify(schemaOf(item, '', depth + 1))))]
      .map((item) => JSON.parse(item));
    return { type: 'array', itemSchemas: uniqueItems.slice(0, 5) };
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, childValue]) => [childKey, schemaOf(childValue, childKey, depth + 1)])
    );
  }
  if (typeof value === 'string') return describeString(value);
  return `<${typeof value}>`;
}

function describeString(value) {
  const text = String(value);
  if (/^(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(text)) return '<redacted:jwt>';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return '<string:date-yyyy-mm-dd>';
  if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(text)) return '<string:date-dd-mm-yyyy>';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '<string:iso-datetime>';
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(text)) return '<string:time>';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) return '<string:uuid>';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return '<redacted:email>';
  if (/^\d+$/.test(text)) return `<string:numeric:length=${text.length}>`;
  if (/^[A-Z]{3}$/.test(text)) return '<string:three-uppercase-letters>';
  return `<string:length=${text.length}>`;
}

function describeDateTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    ? '<iso-datetime>'
    : null;
}

function arrayify(current, next) {
  return Array.isArray(current) ? [...current, next] : [current, next];
}

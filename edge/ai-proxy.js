/**
 * ESA 边缘函数：AI 模型请求转发
 *
 * 把命中 /v1/* 与 /api/* 的请求原样转发到 https://api.edgefn.net，
 * 路径与查询串保持不变，例如：
 *   POST /v1/chat/completions  ->  https://api.edgefn.net/v1/chat/completions
 *
 * 鉴权由客户端携带 Authorization 头，本函数不做注入或替换。
 */

const UPSTREAM_ORIGIN = 'https://api.edgefn.net';

// 需要转发的路径前缀
const PROXY_PREFIXES = ['/v1', '/api'];

// 不向客户端透传的响应头：body 已被运行时解压，content-length 不再可信
const STRIPPED_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding']);

// 临时诊断入口：返回边缘节点出口 IP 归属与上游探测结果
const DIAG_PATH = '/__diag';
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function isProxyPath(pathname) {
  return PROXY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/')
  );
}

function jsonError(status, message) {
  return new Response(
    JSON.stringify({ error: { message, type: 'invalid_request_error', code: String(status) } }),
    {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }
  );
}

async function diagnose(request) {
  const report = {};

  const visibleHeaders = {};
  try {
    request.headers.forEach((value, name) => {
      visibleHeaders[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? '<redacted>' : value;
    });
  } catch (err) {
    report.headerError = err.message;
  }
  report.requestHeaders = visibleHeaders;

  // 1. 边缘节点的出口 IP 归属
  try {
    const res = await fetch('https://ipinfo.io/json');
    report.egress = await res.json();
  } catch (err) {
    report.egress = { error: err.message };
  }

  // 2. 从同一出口访问上游端点得到的真实响应
  try {
    const res = await fetch(UPSTREAM_ORIGIN + '/v1/models', { method: 'GET' });
    report.upstream = {
      status: res.status,
      server: res.headers.get('server'),
      xSer: res.headers.get('x-ser'),
      bodyPreview: (await res.text()).slice(0, 200),
    };
  } catch (err) {
    report.upstream = { error: err.message };
  }

  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === DIAG_PATH) {
    return diagnose(request);
  }

  if (!isProxyPath(url.pathname)) {
    return jsonError(404, `No proxy route for ${request.method} ${url.pathname}`);
  }

  const target = new URL(url.pathname + url.search, UPSTREAM_ORIGIN).toString();

  let upstream;
  try {
    // 复用原始 Request，方法、请求头与 body 一并透传
    upstream = await fetch(new Request(target, request));
  } catch (err) {
    return jsonError(502, `Upstream request to ${UPSTREAM_ORIGIN} failed: ${err.message}`);
  }

  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  });

  // body 直接以流的方式回传，保证 SSE 等流式响应不被缓冲
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

const handler = {
  fetch(request) {
    return handleRequest(request);
  },
};

export default handler;

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/[[path]].ts
var MAX_AVATAR_BYTES = 2 * 1024 * 1024;
var ALLOWED_AVATAR_TYPES = /* @__PURE__ */ new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);
var SUBMISSION_WINDOW_MS = 60 * 60 * 1e3;
var SUBMISSION_LIMIT = 5;
var ApiError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
  static {
    __name(this, "ApiError");
  }
};
async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    const segments = getPathSegments(context.params.path);
    if (context.request.method === "GET" && segments[0] === "testimonials") {
      if (segments[1] === "avatar" && segments[2]) {
        return serveAvatar(context, decodeURIComponent(segments.slice(2).join("/")));
      }
      if (segments.length === 1) {
        return listApprovedTestimonials(context);
      }
    }
    if (context.request.method === "POST" && segments.length === 1 && segments[0] === "testimonials") {
      return createTestimonial(context);
    }
    if (segments[0] === "admin" && segments[1] === "testimonials") {
      const authResponse = requireAdmin(context.request, context.env);
      if (authResponse) return authResponse;
      if (context.request.method === "GET" && segments.length === 2) {
        return listAdminTestimonials(context);
      }
      const id = segments[2];
      const action = segments[3];
      if (!id || !action) return json({ error: "Not found" }, 404);
      if (context.request.method === "GET" && action === "avatar") {
        return serveAdminAvatar(context, id);
      }
      if (context.request.method === "POST") {
        const status = getModerationStatus(action);
        if (status) return updateStatus(context, id, status);
      }
      if (context.request.method === "DELETE" && action === "delete") {
        return deleteTestimonial(context, id);
      }
    }
    return json({ error: `No API route for ${url.pathname}` }, 404);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Unexpected server error" }, 500);
  }
}
__name(onRequest, "onRequest");
function getPathSegments(path) {
  if (!path) return [];
  return Array.isArray(path) ? path : path.split("/");
}
__name(getPathSegments, "getPathSegments");
async function createTestimonial({ request, env }) {
  const formData = await request.formData();
  const honeypot = String(formData.get("website") ?? "").trim();
  if (honeypot) return json({ ok: true }, 202);
  const payload = parseSubmission(formData);
  const ip = getClientIp(request);
  const rateLimit = await checkRateLimit(env.DB, ip);
  if (!rateLimit.allowed) {
    throw new ApiError("Too many submissions. Please try later.", 429);
  }
  const avatar = await storeAvatar(env.TESTIMONIAL_AVATARS, payload.avatarFile);
  const id = crypto.randomUUID();
  try {
    await insertTestimonial(env.DB, id, payload, avatar);
  } catch (error) {
    if (avatar.key) {
      await env.TESTIMONIAL_AVATARS.delete(avatar.key).catch(() => void 0);
    }
    throw error;
  }
  return json({ id, status: "pending" }, 201);
}
__name(createTestimonial, "createTestimonial");
async function listApprovedTestimonials({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM testimonials
     WHERE status = 'approved'
     ORDER BY created_at DESC
     LIMIT 30`
  ).all();
  return json({
    testimonials: results.map(toPublicTestimonial)
  });
}
__name(listApprovedTestimonials, "listApprovedTestimonials");
async function listAdminTestimonials({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM testimonials
     ORDER BY created_at DESC
     LIMIT 100`
  ).all();
  return json({
    testimonials: results.map(toAdminTestimonial)
  });
}
__name(listAdminTestimonials, "listAdminTestimonials");
async function updateStatus({ env }, id, status) {
  const result = await env.DB.prepare(
    `UPDATE testimonials
     SET status = ?, updated_at = ?
     WHERE id = ?`
  ).bind(status, (/* @__PURE__ */ new Date()).toISOString(), id).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new ApiError("Testimonial not found.", 404);
  }
  return json({ ok: true });
}
__name(updateStatus, "updateStatus");
async function deleteTestimonial({ env }, id) {
  const row = await env.DB.prepare(
    "SELECT avatar_r2_key FROM testimonials WHERE id = ?"
  ).bind(id).first();
  if (!row) {
    throw new ApiError("Testimonial not found.", 404);
  }
  const result = await env.DB.prepare("DELETE FROM testimonials WHERE id = ?").bind(id).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new ApiError("Testimonial not found.", 404);
  }
  if (row?.avatar_r2_key) {
    await env.TESTIMONIAL_AVATARS.delete(row.avatar_r2_key);
  }
  return json({ ok: true });
}
__name(deleteTestimonial, "deleteTestimonial");
async function serveAvatar({ env }, key) {
  const row = await env.DB.prepare(
    `SELECT id FROM testimonials
     WHERE avatar_r2_key = ? AND status = 'approved'`
  ).bind(key).first();
  if (!row) return json({ error: "Avatar not found" }, 404);
  const object = await env.TESTIMONIAL_AVATARS.get(key);
  if (!object) return json({ error: "Avatar not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream"
    }
  });
}
__name(serveAvatar, "serveAvatar");
async function serveAdminAvatar({ env }, id) {
  const row = await env.DB.prepare(
    "SELECT avatar_r2_key FROM testimonials WHERE id = ?"
  ).bind(id).first();
  if (!row?.avatar_r2_key) return json({ error: "Avatar not found" }, 404);
  const object = await env.TESTIMONIAL_AVATARS.get(row.avatar_r2_key);
  if (!object) return json({ error: "Avatar not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, max-age=300",
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream"
    }
  });
}
__name(serveAdminAvatar, "serveAdminAvatar");
function toPublicTestimonial(row) {
  return {
    id: row.id,
    quote: row.quote,
    name: row.name,
    role: row.role,
    avatarUrl: row.avatar_r2_key ? `/api/testimonials/avatar/${encodeURIComponent(row.avatar_r2_key)}` : row.avatar_url ?? ""
  };
}
__name(toPublicTestimonial, "toPublicTestimonial");
function toAdminTestimonial(row) {
  return {
    ...toPublicTestimonial(row),
    status: row.status,
    avatarKind: row.avatar_r2_key ? "r2" : row.avatar_url ? "url" : "none",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(toAdminTestimonial, "toAdminTestimonial");
function getModerationStatus(action) {
  if (action === "approve") return "approved";
  if (action === "reject") return "rejected";
  return null;
}
__name(getModerationStatus, "getModerationStatus");
function parseSubmission(formData) {
  const quote = normalizeRequiredField(formData.get("quote"), 20, 500, "Quote");
  const name = normalizeRequiredField(formData.get("name"), 2, 80, "Name");
  const role = normalizeRequiredField(formData.get("role"), 2, 120, "Role");
  const avatarUrl = normalizeOptionalUrl(formData.get("avatarUrl"));
  const avatarFile = normalizeAvatarFile(formData.get("avatar"));
  if (!avatarFile && !avatarUrl) {
    throw new ApiError("Add an avatar upload or avatar URL.", 400);
  }
  return {
    quote,
    name,
    role,
    avatarUrl,
    avatarFile
  };
}
__name(parseSubmission, "parseSubmission");
async function storeAvatar(bucket, avatarFile) {
  if (!avatarFile) {
    return {
      key: null,
      contentType: null
    };
  }
  const key = `testimonials/${crypto.randomUUID()}-${safeFileName(
    avatarFile.name
  )}`;
  await bucket.put(key, await avatarFile.arrayBuffer(), {
    httpMetadata: { contentType: avatarFile.type }
  });
  return {
    key,
    contentType: avatarFile.type
  };
}
__name(storeAvatar, "storeAvatar");
async function insertTestimonial(db, id, payload, avatar) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.prepare(
    `INSERT INTO testimonials (
        id, quote, name, role, status, avatar_url, avatar_r2_key,
        avatar_content_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  ).bind(
    id,
    payload.quote,
    payload.name,
    payload.role,
    payload.avatarUrl,
    avatar.key,
    avatar.contentType,
    now,
    now
  ).run();
}
__name(insertTestimonial, "insertTestimonial");
async function checkRateLimit(db, ip) {
  const windowStart = new Date(Date.now() - SUBMISSION_WINDOW_MS).toISOString();
  const row = await db.prepare(
    `SELECT COUNT(*) as count
     FROM testimonial_submission_rate_limits
     WHERE ip_hash = ? AND created_at > ?`
  ).bind(await sha256(ip), windowStart).first();
  if ((row?.count ?? 0) >= SUBMISSION_LIMIT) {
    return { allowed: false };
  }
  await db.prepare(
    `INSERT INTO testimonial_submission_rate_limits (id, ip_hash, created_at)
     VALUES (?, ?, ?)`
  ).bind(crypto.randomUUID(), await sha256(ip), (/* @__PURE__ */ new Date()).toISOString()).run();
  return { allowed: true };
}
__name(checkRateLimit, "checkRateLimit");
function requireAdmin(request, env) {
  const expectedToken = env.TESTIMONIALS_ADMIN_TOKEN;
  if (!expectedToken) return json({ error: "Admin token is not configured." }, 500);
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token !== expectedToken) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}
__name(requireAdmin, "requireAdmin");
function normalizeRequiredField(value, minLength, maxLength, label) {
  const text = String(value ?? "").trim();
  if (text.length < minLength) {
    throw new ApiError(`${label} is too short.`, 400);
  }
  if (text.length > maxLength) {
    throw new ApiError(`${label} is too long.`, 400);
  }
  return text;
}
__name(normalizeRequiredField, "normalizeRequiredField");
function normalizeOptionalUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ApiError("Avatar URL must be a valid URL.", 400);
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new ApiError("Avatar URL must use http or https.", 400);
  }
  return url.toString();
}
__name(normalizeOptionalUrl, "normalizeOptionalUrl");
function normalizeAvatarFile(value) {
  if (!(value instanceof File) || value.size === 0) return null;
  if (value.size > MAX_AVATAR_BYTES) {
    throw new ApiError("Avatar upload must be 2 MB or smaller.", 400);
  }
  if (!ALLOWED_AVATAR_TYPES.has(value.type)) {
    throw new ApiError("Avatar must be PNG, JPG, GIF, or WebP.", 400);
  }
  return value;
}
__name(normalizeAvatarFile, "normalizeAvatarFile");
function safeFileName(name) {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").slice(0, 80);
}
__name(safeFileName, "safeFileName");
async function sha256(value) {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
}
__name(getClientIp, "getClientIp");
function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
__name(json, "json");

// ../.wrangler/tmp/pages-mWFFVC/functionsRoutes-0.17172619486799867.mjs
var routes = [
  {
    routePath: "/api/:path*",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../.wrangler/tmp/bundle-KDhvn3/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../.wrangler/tmp/bundle-KDhvn3/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.40756129955866693.mjs.map

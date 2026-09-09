export type ParsedCurlRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const BODY_OPTIONS = new Set([
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "-d",
]);

function tokenizeCurl(value: string) {
  const normalizedValue = value
    .trim()
    .replace(/\\\s*\r?\n\s*/g, " ");
  const tokens = normalizedValue.match(
    /(?:[^\s"'\\]|\\.|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g,
  );

  if (!tokens || tokens[0].toLowerCase() !== "curl") {
    throw new Error("Content is not a valid cURL command.");
  }

  return tokens;
}

function unquote(value: string) {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) {
      const content = value.slice(1, -1);
      return quote === '"' ? content.replace(/\\([\\"'])/g, "$1") : content;
    }
  }

  return value.replace(/\\([\\\s"'\\])/g, "$1");
}

function splitHeader(value: string) {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    throw new Error("cURL header must use the name: value format.");
  }

  return [value.slice(0, separatorIndex).trim(), value.slice(separatorIndex + 1).trim()] as const;
}

export function parseCurl(value: string): ParsedCurlRequest {
  const tokens = tokenizeCurl(value);
  let url = "";
  let method = "";
  const headers: Record<string, string> = {};
  const bodyParts: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    const option = token.toLowerCase();

    if (option === "--url" || option === "-url") {
      if (!nextToken) throw new Error("cURL URL is missing.");
      url = unquote(nextToken);
      index += 1;
      continue;
    }

    if (option === "--request" || option === "-x") {
      if (!nextToken) throw new Error("cURL method is missing.");
      method = unquote(nextToken).toUpperCase();
      index += 1;
      continue;
    }

    if (option === "--header" || option === "-h") {
      if (!nextToken) throw new Error("cURL header value is missing.");
      const [name, headerValue] = splitHeader(unquote(nextToken));
      headers[name] = headerValue;
      index += 1;
      continue;
    }

    if (BODY_OPTIONS.has(option)) {
      if (!nextToken) throw new Error("cURL body is missing.");
      bodyParts.push(unquote(nextToken));
      if (!method) method = "POST";
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      if (option === "--compressed" || option === "--location" || option === "-l") {
        continue;
      }

      throw new Error(`Unsupported cURL option: ${token}`);
    }

    if (url) throw new Error("cURL command contains more than one URL.");
    url = unquote(token);
  }

  if (!url) throw new Error("cURL URL is missing.");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only HTTP and HTTPS cURL URLs are supported.");
  }

  try {
    new URL(url);
  } catch {
    throw new Error("cURL URL is invalid.");
  }

  return {
    url,
    method: method || "GET",
    headers,
    ...(bodyParts.length > 0 ? { body: bodyParts.join("&") } : {}),
  };
}

export function isValidCurl(value: string) {
  try {
    parseCurl(value);
    return true;
  } catch {
    return false;
  }
}

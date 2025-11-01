// OpenAI-Compatible Venice.ai Proxy with Token Rotation and Authentication
export default {
  async fetch(request, env) {
    // Get tokens and API key from environment variables
    const tokens = env.OPENAI_TOKENS ? env.OPENAI_TOKENS.split(",") : [];
    const proxyApiKey = env.PROXY_API_KEY;

    if (tokens.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No tokens configured",
          type: "internal_error",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const url = new URL(request.url);

    // Health check endpoint (no auth required)
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          tokens_count: tokens.length,
          target: "https://api.venice.ai/api/v1",
          auth_enabled: !!proxyApiKey,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Require API key for all other endpoints
    if (proxyApiKey) {
      const authHeader = request.headers.get("Authorization");
      const providedKey = authHeader?.replace("Bearer ", "");

      if (providedKey !== proxyApiKey) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Invalid API key",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Build target URL - proxy to Venice.ai API endpoints
    // Remove the /v1 prefix if present to avoid double /v1
    let pathname = url.pathname;
    if (pathname.startsWith("/v1")) {
      pathname = pathname.substring(3);
    }
    const targetUrl = `https://api.venice.ai/api/v1${pathname}${url.search}`;

    // Clone the request body to allow multiple attempts
    let requestBody = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      requestBody = await request.clone().text();
    }

    // Try each token until one works
    let lastError = null;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].trim();
      const headers = new Headers(request.headers);

      // Remove the proxy auth header and add Venice token
      headers.delete("Authorization");
      headers.set("Authorization", `Bearer ${token}`);

      // Remove any OpenAI-specific headers that Venice might not support
      headers.delete("OpenAI-Organization");
      headers.delete("OpenAI-Project");

      try {
        const response = await fetch(targetUrl, {
          method: request.method,
          headers,
          body: requestBody,
        });

        // If not rate limited, return the response (supports streaming)
        if (response.status !== 429) {
          // Transform response headers to be OpenAI-compatible
          const responseHeaders = new Headers(response.headers);
          responseHeaders.set("Access-Control-Allow-Origin", "*");
          responseHeaders.set(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, DELETE, OPTIONS",
          );
          responseHeaders.set(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
          );

          // Handle CORS preflight
          if (request.method === "OPTIONS") {
            return new Response(null, {
              status: 200,
              headers: responseHeaders,
            });
          }

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        }

        // If rate limited, try next token
        console.log(`Token ${i + 1} rate limited, trying next token`);
        lastError = `Token ${i + 1} rate limited`;
      } catch (error) {
        console.log(`Token ${i + 1} failed:`, error.message);
        lastError = `Token ${i + 1} failed: ${error.message}`;
        // Continue to next token
      }
    }

    // All tokens failed - return OpenAI-compatible error
    return new Response(
      JSON.stringify({
        error: {
          message: `All tokens failed. Last error: ${lastError}`,
          type: "api_error",
          code: "rate_limit_exceeded",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  },
};

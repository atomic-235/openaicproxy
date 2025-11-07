// Simplified OpenAI-Compatible Venice.ai Proxy
export default {
  async fetch(request, env) {
    const tokens = env.OPENAI_TOKENS?.split(",") || [];
    const proxyApiKey = env.PROXY_API_KEY;

    if (tokens.length === 0) {
      return jsonResponse({ error: "No tokens configured" }, 500);
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return jsonResponse({
        status: "healthy",
        tokens_count: tokens.length,
      });
    }

    // Check API key if configured
    if (proxyApiKey) {
      const providedKey = request.headers
        .get("Authorization")
        ?.replace("Bearer ", "");
      if (providedKey !== proxyApiKey) {
        return jsonResponse(
          {
            error: {
              message: "Invalid API key",
              type: "invalid_request_error",
            },
          },
          401,
        );
      }
    }

    // Build Venice API URL
    const pathname = url.pathname.replace(/^\/v1/, "");
    const targetUrl = `https://api.venice.ai/api/v1${pathname}${url.search}`;

    // Get request body once
    const body =
      request.method !== "GET" && request.method !== "HEAD"
        ? await request.text()
        : null;

    // Try each token
    for (const token of tokens) {
      try {
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            "Content-Type": "application/json",
          },
          body,
        });

        if (response.ok) {
          return new Response(response.body, {
            status: response.status,
            headers: {
              ...Object.fromEntries(response.headers),
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
      } catch (error) {
        console.error("Token failed:", error.message);
      }
    }

    // All tokens failed
    return jsonResponse(
      {
        error: {
          message: "All tokens failed",
          type: "api_error",
          code: "rate_limit_exceeded",
        },
      },
      429,
    );
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

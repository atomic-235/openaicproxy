// Simplified OpenAI-Compatible Venice.ai Proxy
export default {
  async fetch(request, env) {
    const tokens = env.OPENAI_TOKENS?.split(",") || [];
    const proxyApiKey = env.PROXY_API_KEY;
    let lastError = null;
    let lastErrorStatus = 500;

    if (tokens.length === 0) {
      return jsonResponse({ error: "No tokens configured" }, 500);
    }

    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Health check (no auth required)
    if (url.pathname === "/health") {
      return jsonResponse({
        status: "healthy",
        tokens_count: tokens.length,
        target: "https://api.venice.ai/api/v1",
        auth_enabled: Boolean(proxyApiKey),
      });
    }

    // Proxy auth is required for all non-health endpoints
    if (!proxyApiKey) {
      return jsonResponse(
        {
          error: {
            message: "Proxy API key not configured",
            type: "server_error",
          },
        },
        500,
      );
    }

    const authHeader = request.headers.get("Authorization") || "";
    const providedKey = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (!providedKey || providedKey !== proxyApiKey) {
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

    // Build Venice API URL
    let pathname = url.pathname.replace(/^\/v1/, "");

    // Some clients probe the API root with `GET /v1` and expect a list-shaped
    // OpenAI JSON response containing a top-level `data` field.
    // Map `GET /v1` to the OpenAI-compatible `/v1/models` response.
    if (request.method === "GET" && (url.pathname === "/v1" || url.pathname === "/v1/")) {
      pathname = "/models";
    }

    // Models endpoint - pass through Venice response as-is
    if (request.method === "GET" && pathname === "/models") {
      let lastModelsError = null;
      let lastModelsErrorStatus = 500;

      for (const token of tokens) {
        try {
          const response = await fetch(`https://api.venice.ai/api/v1/models${url.search}`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token.trim()}`,
              "Content-Type": "application/json",
            },
          });

          if (!response.ok) {
            lastModelsErrorStatus = response.status;
            try {
              lastModelsError = await response.json();
            } catch (e) {
              lastModelsError = {
                error: {
                  message: response.statusText || "Unknown error",
                  type: "api_error",
                },
              };
            }
            continue;
          }

          const headers = new Headers(response.headers);
          headers.set("Access-Control-Allow-Origin", "*");

          return new Response(response.body, {
            status: response.status,
            headers,
          });
        } catch (error) {
          lastModelsError = {
            error: {
              message: error.message,
              type: "api_error",
              code: "exception_error",
            },
          };
          lastModelsErrorStatus = 500;
        }
      }

      return jsonResponse(
        lastModelsError || {
          error: {
            message: "All tokens failed",
            type: "api_error",
            code: "rate_limit_exceeded",
          },
        },
        lastModelsErrorStatus,
      );
    }

    const targetUrl = `https://api.venice.ai/api/v1${pathname}${url.search}`;

    // Audio transcriptions endpoint - handles multipart/form-data
    if (request.method === "POST" && pathname === "/audio/transcriptions") {
      const contentType = request.headers.get("Content-Type") || "";
      
      // Must be multipart/form-data for file uploads
      if (!contentType.includes("multipart/form-data")) {
        return jsonResponse(
          {
            error: {
              message: "Content-Type must be multipart/form-data for audio transcriptions",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }

      // Get the raw body to forward
      const audioBody = await request.arrayBuffer();
      let lastTranscriptionError = null;
      let lastTranscriptionErrorStatus = 500;

      for (const token of tokens) {
        try {
          const response = await fetch(`https://api.venice.ai/api/v1/audio/transcriptions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token.trim()}`,
              "Content-Type": contentType, // Preserve the boundary
            },
            body: audioBody,
          });

          console.log(`Audio transcription attempt - Status: ${response.status}`);

          if (response.ok) {
            const headers = new Headers(response.headers);
            headers.set("Access-Control-Allow-Origin", "*");

            // Return the response directly (could be JSON or text depending on response_format)
            return new Response(response.body, {
              status: response.status,
              headers,
            });
          }

          // Store error and try next token
          try {
            const errorText = await response.text();
            console.log(`Audio transcription error (${response.status}): ${errorText.substring(0, 500)}`);
            lastTranscriptionError = JSON.parse(errorText);
            lastTranscriptionErrorStatus = response.status;
          } catch (e) {
            lastTranscriptionError = {
              error: {
                message: response.statusText || "Unknown error",
                type: "api_error",
              },
            };
            lastTranscriptionErrorStatus = response.status;
          }
        } catch (error) {
          console.error("Audio transcription token failed with exception:", error.message);
          lastTranscriptionError = {
            error: {
              message: error.message,
              type: "api_error",
              code: "exception_error",
            },
          };
          lastTranscriptionErrorStatus = 500;
        }
      }

      return jsonResponse(
        lastTranscriptionError || {
          error: {
            message: "All tokens failed",
            type: "api_error",
            code: "rate_limit_exceeded",
          },
        },
        lastTranscriptionErrorStatus,
      );
    }

    // Get request body once and check if it's a streaming request
    let body = null;
    let isStreaming = false;

    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.text();
      try {
        const parsed = JSON.parse(body);
        isStreaming = parsed.stream === true;

        // Transform camelCase keys to snake_case for Venice.ai compatibility
        // Venice supports prompt_cache_key for prompt caching optimization
        let modified = false;
        if ("promptCacheKey" in parsed) {
          parsed.prompt_cache_key = parsed.promptCacheKey;
          delete parsed.promptCacheKey;
          modified = true;
        }

        // Filter out invalid assistant messages (must have content or tool_calls)
        if (Array.isArray(parsed.messages)) {
          const originalLength = parsed.messages.length;
          parsed.messages = parsed.messages.filter((msg) => {
            if (msg.role !== "assistant") return true;
            // Assistant messages must have content or tool_calls
            return msg.content || msg.tool_calls;
          });
          if (parsed.messages.length !== originalLength) {
            console.log(
              `Filtered out ${originalLength - parsed.messages.length} invalid assistant messages from request`,
            );
            modified = true;
          }
        }

        if (modified) {
          body = JSON.stringify(parsed);
        }
      } catch (e) { }
    }

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

        console.log(
          `Token attempt - Status: ${response.status}, Streaming: ${isStreaming}`,
        );

        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set("Access-Control-Allow-Origin", "*");

          // For streaming, we need to peek at the first chunk to validate
          if (isStreaming) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            // Read first chunk
            const { value, done } = await reader.read();

            if (done || !value) {
              console.log("Empty streaming response, trying next token");
              continue;
            }

            const firstChunk = decoder.decode(value, { stream: true });
            console.log(`First stream chunk: ${firstChunk.substring(0, 200)}`);

            // Check if first chunk contains an error
            if (
              firstChunk.includes('"error"') ||
              firstChunk.includes("Cannot read properties")
            ) {
              console.log(
                "Streaming response contains error, trying next token",
              );
              reader.cancel();
              continue;
            }

            // Create a new readable stream that includes the first chunk
            const stream = new ReadableStream({
              start(controller) {
                // Enqueue the first chunk we already read
                controller.enqueue(value);

                // Continue reading the rest
                (async () => {
                  try {
                    while (true) {
                      const { value, done } = await reader.read();
                      if (done) break;
                      controller.enqueue(value);
                    }
                  } catch (error) {
                    controller.error(error);
                  } finally {
                    controller.close();
                  }
                })();
              },
            });

            return new Response(stream, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }

          // For non-streaming, validate before returning
          const text = await response.text();
          console.log(
            `Response text (first 200 chars): ${text.substring(0, 200)}`,
          );

          if (!text || text.trim() === "") {
            console.log("Empty response, trying next token");
            continue;
          }

          // Validate JSON structure
          try {
            const data = JSON.parse(text);

            // Check for error in response
            if (data.error) {
              console.log(
                "Response contains error, trying next token:",
                data.error,
              );
              continue;
            }

            // Check if choices is missing or undefined (but not for models endpoint)
            if (data.choices === undefined && !pathname.includes("/models")) {
              console.log(
                "Response missing 'choices' field, trying next token",
              );
              continue;
            }

            // Filter out invalid choices (assistant messages without content or tool_calls)
            if (data.choices && Array.isArray(data.choices)) {
              const validChoices = data.choices.filter((choice) => {
                const msg = choice.message;
                if (!msg) return false;
                // Assistant message must have content or tool_calls
                return msg.content || msg.tool_calls;
              });

              if (validChoices.length !== data.choices.length) {
                console.log(
                  `Filtered out ${data.choices.length - validChoices.length} invalid choices`,
                );
              }

              if (validChoices.length === 0) {
                console.log(
                  "No valid choices after filtering, trying next token",
                );
                continue;
              }

              data.choices = validChoices;
            }

            return new Response(JSON.stringify(data), {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          } catch (e) {
            console.log("Invalid JSON response, trying next token:", e.message);
            continue;
          }
        }

        // Store the actual error response for this token
        try {
          const errorText = await response.text();
          console.log(`Error response from Venice (${response.status}): ${errorText.substring(0, 500)}`);
          lastError = JSON.parse(errorText);
          lastErrorStatus = response.status;
        } catch (e) {
          lastError = {
            message: response.statusText || "Unknown error",
            type: "api_error",
            code: "unknown_error",
          };
          lastErrorStatus = response.status;
        }
        console.log(`Non-OK status ${response.status}, trying next token`);
      } catch (error) {
        console.error("Token failed with exception:", error.message);
        lastError = {
          message: error.message,
          type: "api_error",
          code: "exception_error",
        };
        lastErrorStatus = 500;
      }
    }

    // All tokens failed - return the last actual error
    return jsonResponse(
      lastError || {
        message: "All tokens failed",
        type: "api_error",
        code: "rate_limit_exceeded",
      },
      lastErrorStatus,
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

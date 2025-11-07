// Shared test utilities for Venice.ai Proxy API tests

// Add fetch support for Node.js
if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

const API_BASE_URL = "https://venice-proxy.openaicproxy.workers.dev";
const API_KEY = process.env.PROXY_API_KEY || "your-api-key-here";

/**
 * Read and display streaming response
 */
async function readStreamResponse(response, maxLines = 10) {
  console.log("📋 Streaming response (first few lines):");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let linesRead = 0;

  try {
    while (linesRead < maxLines) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (linesRead < maxLines && line.trim() !== "") {
          console.log(`   ${line}`);
          linesRead++;
        }
      }
    }
  } catch (error) {
    console.log("⚠️  Error reading stream:", error.message);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Make API call and handle response
 */
async function makeApiCall(endpoint, requestBody, testName) {
  console.log(`🧪 Test: ${testName}`);

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  console.log("✅ Response status:", response.status);

  if (response.status === 200) {
    if (requestBody.stream) {
      await readStreamResponse(response);
    } else {
      const data = await response.json();
      console.log("📋 Response:", JSON.stringify(data, null, 2));
    }
  } else {
    const errorText = await response.text();
    console.log("❌ Error:", errorText);

    // Try to parse as JSON if possible
    try {
      const errorData = JSON.parse(errorText);
      console.log("📋 Error details:", JSON.stringify(errorData, null, 2));
    } catch (e) {
      // Not JSON, just show as text
    }
  }

  console.log("");
  return response;
}

module.exports = {
  API_BASE_URL,
  API_KEY,
  makeApiCall,
  readStreamResponse,
};

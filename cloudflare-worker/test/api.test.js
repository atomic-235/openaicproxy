// Test script for Venice.ai Proxy API
// This script tests the functionality of the proxy deployed at https://venice-proxy.openaicproxy.workers.dev/v1

const { API_BASE_URL, API_KEY, makeApiCall } = require("./test-utils.js");

// Test cases
async function runTests() {
  console.log("🚀 Starting API tests for Venice.ai Proxy...\n");

  try {
    // Test 1: Health check
    console.log("🧪 Test 1: Health Check");
    const healthResponse = await fetch(`${API_BASE_URL}/health`);
    const healthData = await healthResponse.json();
    console.log("✅ Health check status:", healthResponse.status);
    console.log("📋 Health data:", JSON.stringify(healthData, null, 2));
    console.log("");

    // Test 2: Non-streaming chat completion
    await makeApiCall(
      "/v1/chat/completions",
      {
        model: "qwen3-235b",
        messages: [{ role: "user", content: 'Say "Hello, World!"' }],
        stream: false,
      },
      "Non-streaming Chat Completion",
    );

    // Test 3: Streaming chat completion
    await makeApiCall(
      "/v1/chat/completions",
      {
        model: "qwen3-235b",
        messages: [{ role: "user", content: "Count from 1 to 5" }],
        stream: true,
      },
      "Streaming Chat Completion",
    );

    // Test 4: GLM-4 model with specific parameters
    await makeApiCall(
      "/v1/chat/completions",
      {
        model: "zai-org-glm-4.6:include_venice_system_prompt=false",
        messages: [
          {
            role: "user",
            content:
              "Explain what the include_venice_system_prompt parameter does",
          },
        ],
        stream: false,
        temperature: 0.7,
        max_tokens: 500,
      },
      "GLM-4 Model with include_venice_system_prompt=false",
    );

    // Test 5: GLM-4 model streaming
    await makeApiCall(
      "/v1/chat/completions",
      {
        model: "zai-org-glm-4.6:include_venice_system_prompt=false",
        messages: [{ role: "user", content: "Count to 5" }],
        stream: true,
        temperature: 0.7,
      },
      "GLM-4 Model Streaming",
    );

    // Test 6: Token rotation simulation
    console.log("🧪 Test 6: Token Rotation Simulation");

    // Make multiple rapid requests to test token rotation
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        makeApiCall(
          "/v1/chat/completions",
          {
            model: "qwen3-235b",
            messages: [
              {
                role: "user",
                content: `Request ${i + 1} for token rotation test`,
              },
            ],
            stream: false,
            max_tokens: 50,
          },
          `Token Rotation Request ${i + 1}`,
        ),
      );
    }

    // Wait for all requests to complete
    const results = await Promise.all(promises);
    console.log(
      `✅ Completed ${results.length} requests for token rotation test`,
    );

    // Test 7: Authentication error (wrong API key)
    console.log("🧪 Test 7: Authentication Error");
    const authErrorResponse = await fetch(
      `${API_BASE_URL}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-key",
        },
        body: JSON.stringify({
          model: "qwen3-235b",
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    );

    console.log(
      "✅ Auth error status (should be 401):",
      authErrorResponse.status,
    );
    if (authErrorResponse.status === 401) {
      const errorData = await authErrorResponse.json();
      console.log(
        "📋 Auth error response:",
        JSON.stringify(errorData, null, 2),
      );
    }
    console.log("");

    console.log("🏁 All tests completed!");
  } catch (error) {
    console.error("❌ Test failed with error:", error.message);
    console.error("Stack trace:", error.stack);
  }
}

// Run the tests
if (typeof require !== "undefined" && require.main === module) {
  runTests();
}

// Export for use in other modules
module.exports = { runTests };

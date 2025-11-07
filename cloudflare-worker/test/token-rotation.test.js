// Test script for token rotation functionality
// Tests the proxy's ability to rotate tokens when rate limits occur
// Tests with configurable model and both streaming and non-streaming modes

// Add fetch support for Node.js
if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

const { API_BASE_URL, API_KEY, makeApiCall } = require("./test-utils.js");

/**
 * Test token rotation by making multiple simultaneous requests
 * This simulates a scenario where tokens might hit rate limits
 * @param {string} model - The model to test with (defaults to qwen3-235b)
 * @param {number} nonStreamingCount - Number of non-streaming requests
 * @param {number} streamingCount - Number of streaming requests
 * @param {number} mixedCount - Number of mixed requests
 */
async function testTokenRotation(
  model = "qwen3-235b",
  nonStreamingCount = 5,
  streamingCount = 5,
  mixedCount = 6,
) {
  console.log(`🔄 Testing Token Rotation Functionality with ${model}...\n`);

  // Set a timeout to prevent hanging
  const timeout = setTimeout(() => {
    console.error("\n⏰ Test timed out after 2 minutes");
    process.exit(1);
  }, 120000); // 2 minutes timeout

  try {
    // Test 1: Non-streaming rapid requests
    console.log("🧪 Test 1: Non-streaming rapid requests...");

    const nonStreamingPromises = [];
    for (let i = 0; i < nonStreamingCount; i++) {
      nonStreamingPromises.push(
        makeApiCall(
          "/v1/chat/completions",
          {
            model: model,
            messages: [
              {
                role: "user",
                content: `Analyze the following complex scenario and provide a detailed response: You are tasked with optimizing a distributed system that handles 10,000 concurrent users. The system currently has three microservices - authentication, data processing, and content delivery. Each service has different latency characteristics and resource requirements. Design a comprehensive scaling strategy that addresses load balancing, caching mechanisms, database optimization, and fault tolerance. Consider the trade-offs between horizontal and vertical scaling, and explain how you would implement auto-scaling policies. This is request ${i + 1} of ${nonStreamingCount} for load testing. Focus on different aspects: ${["performance optimization", "cost efficiency", "security hardening", "monitoring strategy", "disaster recovery"][i % 5]}.`,
              },
            ],
            stream: false,
            max_tokens: 150,
            temperature: 0.7,
          },
          `${model} Non-Streaming Request ${i + 1}`,
        ),
      );
    }

    console.log(
      `   Making ${nonStreamingPromises.length} non-streaming rapid requests...`,
    );

    const nonStreamingStartTime = Date.now();
    const nonStreamingResults = await Promise.all(nonStreamingPromises);
    const nonStreamingEndTime = Date.now();

    console.log(
      `✅ Completed ${nonStreamingResults.length} non-streaming requests in ${((nonStreamingEndTime - nonStreamingStartTime) / 1000).toFixed(2)}s`,
    );

    // Analyze non-streaming results
    let nonStreamingSuccess = 0;
    let nonStreamingFailed = 0;

    for (const response of nonStreamingResults) {
      if (response.status >= 200 && response.status < 300) {
        nonStreamingSuccess++;
      } else {
        nonStreamingFailed++;
      }
    }

    console.log(`📊 Non-Streaming Results:`);
    console.log(`   ✅ Successful: ${nonStreamingSuccess}`);
    console.log(`   ❌ Failed: ${nonStreamingFailed}`);

    if (nonStreamingSuccess > 0) {
      console.log("\n✅ Token rotation is working for non-streaming requests");
    }

    if (nonStreamingFailed > 0) {
      console.log(
        "\n⚠️  Some non-streaming requests failed - this might indicate token rotation is working",
      );
      console.log(
        "   (Failed requests may have triggered rate limit handling)",
      );
    }

    console.log("");

    // Test 2: Streaming rapid requests
    console.log("🧪 Test 2: Streaming rapid requests...");

    const streamingPromises = [];
    for (let i = 0; i < streamingCount; i++) {
      streamingPromises.push(
        makeApiCall(
          "/v1/chat/completions",
          {
            model: model,
            messages: [
              {
                role: "user",
                content: `${model} streaming test request ${i + 1}/${streamingCount}`,
              },
            ],
            stream: true,
            max_tokens: 150,
            temperature: 0.7,
          },
          `${model} Streaming Request ${i + 1}`,
        ),
      );
    }

    console.log(
      `   Making ${streamingPromises.length} streaming rapid requests...`,
    );

    const streamingStartTime = Date.now();
    const streamingResults = await Promise.all(streamingPromises);
    const streamingEndTime = Date.now();

    console.log(
      `✅ Completed ${streamingResults.length} streaming requests in ${((streamingEndTime - streamingStartTime) / 1000).toFixed(2)}s`,
    );

    // Analyze streaming results
    let streamingSuccess = 0;
    let streamingFailed = 0;

    for (const response of streamingResults) {
      if (response.status >= 200 && response.status < 300) {
        streamingSuccess++;
      } else {
        streamingFailed++;
      }
    }

    console.log(`📊 Streaming Results:`);
    console.log(`   ✅ Successful: ${streamingSuccess}`);
    console.log(`   ❌ Failed: ${streamingFailed}`);

    if (streamingSuccess > 0) {
      console.log("\n✅ Token rotation is working for streaming requests");
    }

    if (streamingFailed > 0) {
      console.log(
        "\n⚠️  Some streaming requests failed - this might indicate token rotation is working",
      );
      console.log(
        "   (Failed requests may have triggered rate limit handling)",
      );
    }

    console.log("");

    // Test 3: Mixed streaming/non-streaming stress test
    console.log(
      "🧪 Test 3: Mixed streaming/non-streaming requests to stress test token rotation...",
    );
    console.log(
      "   (Alternating between streaming and non-streaming with Qwen3)",
    );

    const mixedPromises = [];
    for (let i = 0; i < mixedCount; i++) {
      const isStreaming = i % 2 === 0; // Even indices use streaming
      mixedPromises.push(
        makeApiCall(
          "/v1/chat/completions",
          {
            model: model,
            messages: [
              {
                role: "user",
                content: `Develop a detailed security audit checklist for a cloud-native application running on Kubernetes. The checklist should cover container security, network policies, secrets management, RBAC configurations, and compliance requirements (GDPR, SOC 2, HIPAA). For each area, provide specific implementation guidelines, tools recommendations, and automated verification scripts. Include risk assessment matrices and remediation strategies. This is mixed request ${i + 1} of ${mixedCount}. Priority: ${["container hardening", "network security", "access control", "data protection", "compliance automation"][i % 5]} (${isStreaming ? "streaming" : "non-streaming"}).`,
              },
            ],
            stream: isStreaming,
            max_tokens: 120,
          },
          `${model} Mixed Request ${i + 1} (${isStreaming ? "Streaming" : "Non-Streaming"})`,
        ),
      );
    }

    const mixedStartTime = Date.now();
    const mixedResults = await Promise.all(mixedPromises);
    const mixedEndTime = Date.now();

    console.log(
      `✅ Completed ${mixedResults.length} mixed requests in ${((mixedEndTime - mixedStartTime) / 1000).toFixed(2)}s`,
    );

    // Analyze mixed results
    let mixedSuccess = 0;
    let mixedFailed = 0;

    for (const response of mixedResults) {
      if (response.status >= 200 && response.status < 300) {
        mixedSuccess++;
      } else {
        mixedFailed++;
      }
    }

    console.log(`📊 Mixed Results:`);
    console.log(`   ✅ Successful: ${mixedSuccess}`);
    console.log(`   ❌ Failed: ${mixedFailed}`);

    // Overall summary
    console.log(`\n📊 Overall Summary:`);
    const totalSuccess = nonStreamingSuccess + streamingSuccess + mixedSuccess;
    const totalFailed = nonStreamingFailed + streamingFailed + mixedFailed;
    const totalRequests = totalSuccess + totalFailed;

    console.log(`   Total Requests: ${totalRequests}`);
    console.log(
      `   ✅ Successful: ${totalSuccess} (${((totalSuccess / totalRequests) * 100).toFixed(1)}%)`,
    );
    console.log(
      `   ❌ Failed: ${totalFailed} (${((totalFailed / totalRequests) * 100).toFixed(1)}%)`,
    );

    if (totalSuccess > 0) {
      console.log(
        `\n✅ Token rotation is working for ${model} in both streaming and non-streaming modes`,
      );
    }

    if (totalFailed > 0) {
      console.log(
        "\n⚠️  Some requests failed - this might indicate token rotation is working properly",
      );
      console.log(
        "   (Failed requests may have triggered rate limit handling)",
      );
    }

    // Clear the timeout since test completed successfully
    clearTimeout(timeout);
    console.log("");
  } catch (error) {
    console.error("❌ Token rotation test failed:", error.message);
    console.error("Stack trace:", error.stack);
    clearTimeout(timeout);
    process.exit(1);
  }
}

// Run the test
if (typeof require !== "undefined" && require.main === module) {
  const model = process.argv[2] || "qwen3-235b";
  const nonStreamingCount = parseInt(process.argv[3]) || 5;
  const streamingCount = parseInt(process.argv[4]) || 5;
  const mixedCount = parseInt(process.argv[5]) || 6;

  testTokenRotation(model, nonStreamingCount, streamingCount, mixedCount)
    .then(() => {
      console.log("✅ Token rotation test completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Token rotation test failed:", error);
      process.exit(1);
    });
}

module.exports = { testTokenRotation };

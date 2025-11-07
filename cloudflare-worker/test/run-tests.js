#!/usr/bin/env node

// Test runner for Venice.ai Proxy API
const { runTests } = require("./api.test.js");
const { testTokenRotation } = require("./token-rotation.test.js");

async function runAllTests() {
  console.log("🏃 Running all API tests...\n");

  // Run general API tests
  await runTests();

  console.log("\n" + "=".repeat(50) + "\n");

  // Run token rotation tests
  await testTokenRotation();

  console.log("\n🏁 All tests completed!");
}

// Run the tests
runAllTests().catch((error) => {
  console.error("Tests failed:", error);
  process.exit(1);
});

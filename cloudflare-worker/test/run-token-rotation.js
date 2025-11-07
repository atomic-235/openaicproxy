#!/usr/bin/env node

// Test runner for token rotation tests
const { testTokenRotation } = require("./token-rotation.test.js");

// Run the token rotation test
testTokenRotation().catch((error) => {
  console.error("Token rotation test failed:", error);
  process.exit(1);
});

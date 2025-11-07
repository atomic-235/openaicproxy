# Venice.ai Proxy API Tests

This directory contains tests for verifying the functionality of the Venice.ai proxy API deployed at `https://venice-proxy.openaicproxy.workers.dev`.

## Test Cases

The test script (`api.test.js`) includes the following test cases:

1. **Health Check** - Verifies the proxy is running and responsive
2. **Non-streaming Chat Completion** - Tests standard chat completion requests
3. **Streaming Chat Completion** - Tests streaming responses from the API
4. **GLM-4 Model Tests** - Tests the specific zai-org-glm-4.6 model with include_venice_system_prompt parameter (both regular and streaming)
5. **Token Rotation Tests** - Tests the proxy's ability to rotate tokens when rate limits occur
6. **Authentication Error** - Verifies proper error handling for invalid API keys

## Running Tests

To run the tests, you need to set your API key as an environment variable:

```bash
# Set your API key
export PROXY_API_KEY=your-api-key-here

# Run tests
npm test
```

Or run directly with Node.js:

```bash
PROXY_API_KEY=your-api-key-here node test/run-tests.js
```

## What the Tests Verify

- ✅ API connectivity and basic functionality
- ✅ Proper handling of streaming responses
- ✅ Correct error responses for authentication failures
- ✅ Health endpoint functionality
- ✅ Proxy's token rotation mechanism
- ✅ Specific model support (GLM-4 with parameters)
- ✅ Rate limit handling and token switching

## Test Output

The tests will output detailed information about each test case including:
- HTTP status codes
- Response data (where applicable)
- Error messages (if any)
- Stream content samples (for streaming tests)

## Troubleshooting

If tests fail, check:
1. That your API key is valid and properly set
2. That the Venice.ai tokens configured in the proxy are valid
3. The Cloudflare Worker logs for any errors
4. Network connectivity to the proxy endpoint
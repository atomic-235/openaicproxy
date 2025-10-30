import os
import httpx
import time
import json
import asyncio
import random
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import logging
from contextlib import asynccontextmanager

# Load environment variables

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.venice.ai/api/v1")
PROXY_PATH_PREFIX = os.getenv("PROXY_PATH_PREFIX", "/api/v1")
TIMEOUT = float(os.getenv("TIMEOUT", "300"))

# Retry configuration
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "5"))
BASE_RETRY_DELAY = float(os.getenv("BASE_RETRY_DELAY", "1.0"))
RATE_LIMIT_WAIT = int(
    os.getenv("RATE_LIMIT_WAIT", "30")
)  # For failed request rate limit

# Create HTTP client with lifespan
client = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    global client
    client = httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT))
    yield
    # Shutdown
    await client.aclose()


app = FastAPI(title="OpenAI Proxy Server", lifespan=lifespan)


async def retry_with_backoff(func, max_retries=None, base_delay=None):
    """
    Retry a function with exponential backoff.
    Handles Venice API rate limits and 429 errors.
    """
    if max_retries is None:
        max_retries = MAX_RETRIES
    if base_delay is None:
        base_delay = BASE_RETRY_DELAY

    for attempt in range(max_retries + 1):
        try:
            response = await func()

            # If we get a 429 rate limit error, handle it specially
            if response.status_code == 429:
                # Check if this is the special "too many failed attempts" error
                try:
                    error_content = await response.aread()
                    error_text = error_content.decode("utf-8")

                    if "Too many failed attempts" in error_text:
                        # This is the 30-second wait error - wait exactly 30 seconds
                        if attempt < max_retries:
                            logger.warning(
                                f"Hit failed request rate limit. Waiting {RATE_LIMIT_WAIT} seconds before retry {attempt + 1}/{max_retries}"
                            )
                            await asyncio.sleep(RATE_LIMIT_WAIT)
                            continue
                        else:
                            logger.error(
                                "Max retries exceeded for failed request rate limit"
                            )
                            return response

                    # Regular 429 error - use rate limit headers if available
                    reset_requests_header = response.headers.get(
                        "x-ratelimit-reset-requests"
                    )
                    if reset_requests_header:
                        try:
                            reset_time = int(reset_requests_header)
                            current_time = int(time.time())
                            wait_time = max(1, reset_time - current_time)

                            # Handle different header formats:
                            # 1. Unix timestamp in seconds (e.g., 1698691200)
                            # 2. Unix timestamp in milliseconds (e.g., 1698691200000)
                            # 3. Seconds until reset (e.g., 60)

                            # If it's milliseconds (larger than current time in seconds * 1000)
                            if reset_time > current_time * 1000:
                                # Convert milliseconds to seconds
                                reset_time = reset_time // 1000
                                wait_time = max(1, reset_time - current_time)
                            # If it's a reasonable number (seconds until reset, typically < 3600)
                            elif reset_time < 3600:
                                wait_time = max(1, reset_time)
                            # Otherwise assume it's a Unix timestamp in seconds
                            else:
                                wait_time = max(1, reset_time - current_time)

                            # Cap the wait time to prevent excessive delays
                            wait_time = min(wait_time, 3600)  # Max 1 hour wait

                            if attempt < max_retries:
                                logger.warning(
                                    f"Rate limit exceeded. Waiting {wait_time} seconds before retry {attempt + 1}/{max_retries}"
                                )
                                await asyncio.sleep(wait_time)
                                continue
                        except ValueError:
                            logger.warning(
                                f"Invalid rate limit header value: {reset_requests_header}"
                            )
                            pass

                    # Fallback to exponential backoff for 429 errors
                    if attempt < max_retries:
                        delay = base_delay * (2**attempt) + random.uniform(0, 1)
                        logger.warning(
                            f"Rate limit exceeded. Using exponential backoff: {delay:.2f}s before retry {attempt + 1}/{max_retries}"
                        )
                        await asyncio.sleep(delay)
                        continue

                except Exception as e:
                    logger.error(f"Error parsing 429 response: {e}")
                    # Fall through to return the response

                return response

            # For 5xx errors, retry with exponential backoff
            elif response.status_code >= 500:
                if attempt < max_retries:
                    delay = base_delay * (2**attempt) + random.uniform(0, 1)
                    logger.warning(
                        f"Server error {response.status_code}. Retrying in {delay:.2f}s (attempt {attempt + 1}/{max_retries})"
                    )
                    await asyncio.sleep(delay)
                    continue
                else:
                    logger.error(
                        f"Max retries exceeded for server error {response.status_code}"
                    )
                    return response

            # Success or client error (4xx except 429) - return immediately
            return response

        except httpx.RequestError as e:
            if attempt < max_retries:
                delay = base_delay * (2**attempt) + random.uniform(0, 1)
                logger.warning(
                    f"Request error: {e}. Retrying in {delay:.2f}s (attempt {attempt + 1}/{max_retries})"
                )
                await asyncio.sleep(delay)
                continue
            else:
                logger.error(f"Max retries exceeded for request error: {e}")
                raise
        except Exception as e:
            logger.error(f"Unexpected error in retry_with_backoff: {e}")
            raise

    # This should never be reached
    raise Exception("Unexpected end of retry_with_backoff")


@app.api_route(
    f"{PROXY_PATH_PREFIX}/{{path:path}}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
)
async def proxy_request(path: str, request: Request):
    """
    Proxy all requests to OpenAI API.
    Supports both regular requests and streaming (SSE) responses.
    Includes rate limit handling with exponential backoff.
    """
    # Handle Ollama API compatibility
    # Ollama might send requests like /api/v1/api/tags, which should go to /api/tags on Venice
    target_path = path
    if path.startswith("api/") and OPENAI_BASE_URL.endswith("/api/v1"):
        # Remove the extra api/ prefix if it's already included in the base URL
        target_path = path[4:]  # Remove "api/" prefix

    # Construct target URL
    target_url = f"{OPENAI_BASE_URL}/{target_path}"

    # Get query parameters
    query_params = str(request.url.query)
    if query_params:
        target_url = f"{target_url}?{query_params}"

    # Prepare headers - forward most headers but remove host
    headers = dict(request.headers)
    headers.pop("host", None)

    # Read request body
    body = await request.body()

    # Log the path being proxied
    logger.info(f"Proxying request to path: {path}")

    # Clean up unsupported parameters for chat completions
    if "chat/completions" in path and body:
        try:
            import json

            body_json = json.loads(body.decode("utf-8"))

            # Remove parameters that Venice doesn't support
            unsupported_params = ["prompt_cache_key", "logprobs", "top_logprobs"]
            for param in unsupported_params:
                body_json.pop(param, None)

            # Preserve tool calling protocol - only remove parallel_tool_calls if it causes issues
            # Check if parallel_tool_calls is causing the specific error with tool_use/tool_result sequence
            if "parallel_tool_calls" in body_json:
                # Only remove parallel_tool_calls if it's not a boolean (malformed)
                if not isinstance(body_json["parallel_tool_calls"], bool):
                    body_json.pop("parallel_tool_calls", None)

            # Validate tool calling message sequence integrity
            if "messages" in body_json and isinstance(body_json["messages"], list):
                messages = body_json["messages"]
                # Check for tool_result blocks and ensure they reference valid tool_use blocks
                tool_use_ids = set()

                # First pass: collect all tool_use_ids
                for msg in messages:
                    if isinstance(msg, dict) and "tool_calls" in msg:
                        tool_calls = msg["tool_calls"]
                        if isinstance(tool_calls, list):
                            for tool_call in tool_calls:
                                if isinstance(tool_call, dict) and "id" in tool_call:
                                    tool_use_ids.add(tool_call["id"])

                # Second pass: validate tool_result blocks reference valid tool_use_ids
                for msg in messages:
                    if (
                        isinstance(msg, dict)
                        and "content" in msg
                        and isinstance(msg["content"], list)
                    ):
                        content_items = msg["content"]
                        for item in content_items:
                            if (
                                isinstance(item, dict)
                                and item.get("type") == "tool_result"
                            ):
                                tool_use_id = item.get("tool_use_id")
                                if tool_use_id and tool_use_id not in tool_use_ids:
                                    # Log warning but don't remove to avoid breaking the sequence
                                    import logging

                                    logging.warning(
                                        f"tool_result references unknown tool_use_id: {tool_use_id}"
                                    )

            # Log tool calls if present in the request
            if "tools" in body_json:
                num_tools = (
                    len(body_json["tools"])
                    if isinstance(body_json["tools"], list)
                    else 0
                )
                logger.info(f"Request contains {num_tools} tools")
                for i, tool in enumerate(body_json.get("tools", [])):
                    if isinstance(tool, dict) and "function" in tool:
                        function_name = tool["function"].get("name", "unknown")
                        logger.info(f"Tool {i + 1}: {function_name}")

            # Log tool calls in messages if present
            if "messages" in body_json and isinstance(body_json["messages"], list):
                for msg_idx, msg in enumerate(body_json["messages"]):
                    if isinstance(msg, dict) and "tool_calls" in msg:
                        tool_calls = msg["tool_calls"]
                        if isinstance(tool_calls, list) and len(tool_calls) > 0:
                            logger.info(
                                f"Message {msg_idx} contains {len(tool_calls)} tool calls"
                            )
                            for tc_idx, tool_call in enumerate(tool_calls):
                                if isinstance(tool_call, dict):
                                    tc_id = tool_call.get("id", "unknown")
                                    tc_type = tool_call.get("type", "unknown")
                                    tc_name = (
                                        tool_call.get("function", {}).get(
                                            "name", "unknown"
                                        )
                                        if "function" in tool_call
                                        else "unknown"
                                    )
                                    tc_args = (
                                        tool_call.get("function", {}).get(
                                            "arguments", ""
                                        )
                                        if "function" in tool_call
                                        else ""
                                    )

                                    # Transform read_file tool call arguments
                                    if (
                                        tc_name == "read_file"
                                        and tc_args
                                        and "function" in tool_call
                                    ):
                                        try:
                                            args_dict = json.loads(tc_args)
                                            logger.info(
                                                f"  Before transformation - start_line type: {type(args_dict.get('start_line'))}, value: {args_dict.get('start_line')}"
                                            )
                                            logger.info(
                                                f"  Before transformation - end_line type: {type(args_dict.get('end_line'))}, value: {args_dict.get('end_line')}"
                                            )
                                            modified = False

                                            # Convert start_line from string to int
                                            if "start_line" in args_dict and isinstance(
                                                args_dict["start_line"], str
                                            ):
                                                args_dict["start_line"] = int(
                                                    args_dict["start_line"]
                                                )
                                                modified = True

                                            # Convert end_line from string to int
                                            if "end_line" in args_dict and isinstance(
                                                args_dict["end_line"], str
                                            ):
                                                args_dict["end_line"] = int(
                                                    args_dict["end_line"]
                                                )
                                                modified = True

                                            # Update the arguments if modified
                                            if modified:
                                                logger.info(
                                                    f"  After transformation - start_line type: {type(args_dict.get('start_line'))}, value: {args_dict.get('start_line')}"
                                                )
                                                logger.info(
                                                    f"  After transformation - end_line type: {type(args_dict.get('end_line'))}, value: {args_dict.get('end_line')}"
                                                )
                                                tool_call["function"]["arguments"] = (
                                                    json.dumps(args_dict)
                                                )
                                                tc_args = tool_call["function"][
                                                    "arguments"
                                                ]
                                                logger.info(
                                                    f"  Transformed read_file arguments JSON string: {tc_args}"
                                                )
                                                # Verify the JSON string contains integers
                                                verification = json.loads(tc_args)
                                                logger.info(
                                                    f"  Verification - start_line type in JSON: {type(verification.get('start_line'))}, value: {verification.get('start_line')}"
                                                )
                                        except (json.JSONDecodeError, ValueError) as e:
                                            logger.warning(
                                                f"  Failed to transform read_file arguments: {e}"
                                            )

                                    logger.info(
                                        f"  Tool call {tc_idx + 1}: id={tc_id}, type={tc_type}, name={tc_name}"
                                    )
                                    if tc_args:
                                        logger.info(f"    Arguments: {tc_args}")

                    # Log tool results
                    if isinstance(msg, dict) and msg.get("role") == "tool":
                        tool_call_id = msg.get("tool_call_id", "unknown")
                        tool_content = msg.get("content", "")
                        logger.info(
                            f"Message {msg_idx} is a tool result for tool_call_id={tool_call_id}"
                        )
                        if tool_content:
                            # Truncate long content for logging
                            content_preview = (
                                tool_content[:500]
                                if len(tool_content) > 500
                                else tool_content
                            )
                            if len(tool_content) > 500:
                                logger.info(
                                    f"  Content: {content_preview}... (truncated, total length: {len(tool_content)})"
                                )
                            else:
                                logger.info(f"  Content: {content_preview}")

            # Re-encode the body
            body = json.dumps(body_json).encode("utf-8")

            # Debug: Log the transformed body to verify the changes
            logger.info(f"Transformed body being sent: {body.decode('utf-8')[:2000]}")

            # Update Content-Length header to match the new body size
            headers["content-length"] = str(len(body))
        except Exception as e:
            logger.warning(f"Error cleaning request parameters: {e}")

    # Transform embeddings request if needed
    if path == "embeddings" and body:
        try:
            import json

            body_json = json.loads(body.decode("utf-8"))

            # Transform encoding_format if it's "base64" to "float"
            # Venice API doesn't support base64 encoding format
            if body_json.get("encoding_format") == "base64":
                body_json["encoding_format"] = "float"

            # Re-encode the body
            body = json.dumps(body_json).encode("utf-8")

            # Update Content-Length header if it exists
            if "content-length" in headers:
                headers["content-length"] = str(len(body))
        except Exception as e:
            logger.error(f"Error transforming embeddings request: {e}")

    try:
        # Build the request once
        proxied_request = client.build_request(
            method=request.method,
            url=target_url,
            headers=headers,
            content=body,
        )

        # Define a function to make the request for retry logic
        async def make_request():
            return await client.send(proxied_request, stream=True)

        # Use retry logic with exponential backoff
        response = await retry_with_backoff(make_request)

        # Check if this is a streaming response (SSE)
        content_type = response.headers.get("content-type", "")
        is_streaming = "text/event-stream" in content_type or "stream" in content_type

        if is_streaming:
            # For streaming responses, parse SSE chunks to log tool calls
            async def stream_generator():
                buffer = ""
                async for chunk in response.aiter_bytes():
                    # Decode chunk and add to buffer
                    try:
                        buffer += chunk.decode("utf-8")
                    except UnicodeDecodeError:
                        # If we can't decode, just yield the chunk as-is
                        yield chunk
                        continue

                    # Process complete lines from buffer
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()

                        # Parse SSE data lines for tool calls
                        if line.startswith("data: ") and line != "data: [DONE]":
                            try:
                                data_str = line[6:]  # Remove "data: " prefix
                                data = json.loads(data_str)

                                # Check for tool calls in streaming response
                                if "choices" in data and isinstance(
                                    data["choices"], list
                                ):
                                    for choice in data["choices"]:
                                        if (
                                            isinstance(choice, dict)
                                            and "delta" in choice
                                        ):
                                            delta = choice["delta"]
                                            if (
                                                isinstance(delta, dict)
                                                and "tool_calls" in delta
                                            ):
                                                tool_calls = delta["tool_calls"]
                                                if isinstance(tool_calls, list):
                                                    for tool_call in tool_calls:
                                                        if isinstance(tool_call, dict):
                                                            tc_index = tool_call.get(
                                                                "index", "?"
                                                            )
                                                            tc_id = tool_call.get(
                                                                "id", ""
                                                            )
                                                            tc_type = tool_call.get(
                                                                "type", ""
                                                            )
                                                            tc_name = (
                                                                tool_call.get(
                                                                    "function", {}
                                                                ).get("name", "")
                                                                if "function"
                                                                in tool_call
                                                                else ""
                                                            )
                                                            tc_args = (
                                                                tool_call.get(
                                                                    "function", {}
                                                                ).get("arguments", "")
                                                                if "function"
                                                                in tool_call
                                                                else ""
                                                            )

                                                            # Transform read_file tool call arguments in streaming response
                                                            if (
                                                                tc_name == "read_file"
                                                                and tc_args
                                                                and "function"
                                                                in tool_call
                                                            ):
                                                                try:
                                                                    args_dict = (
                                                                        json.loads(
                                                                            tc_args
                                                                        )
                                                                    )
                                                                    modified = False

                                                                    # Convert start_line from string to int
                                                                    if (
                                                                        "start_line"
                                                                        in args_dict
                                                                        and isinstance(
                                                                            args_dict[
                                                                                "start_line"
                                                                            ],
                                                                            str,
                                                                        )
                                                                    ):
                                                                        args_dict[
                                                                            "start_line"
                                                                        ] = int(
                                                                            args_dict[
                                                                                "start_line"
                                                                            ]
                                                                        )
                                                                        modified = True

                                                                    # Convert end_line from string to int
                                                                    if (
                                                                        "end_line"
                                                                        in args_dict
                                                                        and isinstance(
                                                                            args_dict[
                                                                                "end_line"
                                                                            ],
                                                                            str,
                                                                        )
                                                                    ):
                                                                        args_dict[
                                                                            "end_line"
                                                                        ] = int(
                                                                            args_dict[
                                                                                "end_line"
                                                                            ]
                                                                        )
                                                                        modified = True

                                                                    # Update the arguments if modified
                                                                    if modified:
                                                                        tool_call[
                                                                            "function"
                                                                        ][
                                                                            "arguments"
                                                                        ] = json.dumps(
                                                                            args_dict
                                                                        )
                                                                        tc_args = tool_call[
                                                                            "function"
                                                                        ]["arguments"]
                                                                        logger.info(
                                                                            f"Transformed streaming read_file arguments: {tc_args}"
                                                                        )
                                                                        # Mark that we need to reconstruct this chunk
                                                                        data_str = (
                                                                            json.dumps(
                                                                                data
                                                                            )
                                                                        )
                                                                        line = f"data: {data_str}"
                                                                except (
                                                                    json.JSONDecodeError,
                                                                    ValueError,
                                                                ) as e:
                                                                    logger.warning(
                                                                        f"Failed to transform streaming read_file arguments: {e}"
                                                                    )

                                                            # Log tool call start (when we have id and name)
                                                            if tc_id and tc_name:
                                                                logger.info(
                                                                    f"Streaming response tool call: index={tc_index}, id={tc_id}, type={tc_type}, name={tc_name}"
                                                                )
                                                                if tc_args:
                                                                    logger.info(
                                                                        f"  Arguments: {tc_args}"
                                                                    )
                                                            elif tc_name:
                                                                logger.info(
                                                                    f"Streaming response tool call: index={tc_index}, name={tc_name}"
                                                                )
                                                                if tc_args:
                                                                    logger.info(
                                                                        f"  Arguments: {tc_args}"
                                                                    )
                            except Exception as e:
                                logger.debug(
                                    f"Could not parse streaming chunk for tool call logging: {e}"
                                )

                        # Yield the line back in original format
                        yield (line + "\n").encode("utf-8")

                # Yield any remaining buffer content
                if buffer:
                    yield buffer.encode("utf-8")

            return StreamingResponse(
                stream_generator(),
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=content_type,
            )
        else:
            # For non-streaming responses, read all content
            content = await response.aread()

            # Log tool calls in successful responses
            if response.status_code == 200 and "chat/completions" in path:
                try:
                    response_json = json.loads(content.decode("utf-8"))
                    if "choices" in response_json and isinstance(
                        response_json["choices"], list
                    ):
                        for choice_idx, choice in enumerate(response_json["choices"]):
                            if isinstance(choice, dict) and "message" in choice:
                                message = choice["message"]
                                if (
                                    isinstance(message, dict)
                                    and "tool_calls" in message
                                ):
                                    tool_calls = message["tool_calls"]
                                    if (
                                        isinstance(tool_calls, list)
                                        and len(tool_calls) > 0
                                    ):
                                        logger.info(
                                            f"Response choice {choice_idx} contains {len(tool_calls)} tool calls"
                                        )
                                        for tc_idx, tool_call in enumerate(tool_calls):
                                            if isinstance(tool_call, dict):
                                                tc_id = tool_call.get("id", "unknown")
                                                tc_type = tool_call.get(
                                                    "type", "unknown"
                                                )
                                                tc_name = (
                                                    tool_call.get("function", {}).get(
                                                        "name", "unknown"
                                                    )
                                                    if "function" in tool_call
                                                    else "unknown"
                                                )
                                                tc_args = (
                                                    tool_call.get("function", {}).get(
                                                        "arguments", ""
                                                    )
                                                    if "function" in tool_call
                                                    else ""
                                                )

                                                # Transform read_file tool call arguments in non-streaming response
                                                if (
                                                    tc_name == "read_file"
                                                    and tc_args
                                                    and "function" in tool_call
                                                ):
                                                    try:
                                                        args_dict = json.loads(tc_args)
                                                        modified = False

                                                        # Convert start_line from string to int
                                                        if (
                                                            "start_line" in args_dict
                                                            and isinstance(
                                                                args_dict["start_line"],
                                                                str,
                                                            )
                                                        ):
                                                            args_dict["start_line"] = (
                                                                int(
                                                                    args_dict[
                                                                        "start_line"
                                                                    ]
                                                                )
                                                            )
                                                            modified = True

                                                        # Convert end_line from string to int
                                                        if (
                                                            "end_line" in args_dict
                                                            and isinstance(
                                                                args_dict["end_line"],
                                                                str,
                                                            )
                                                        ):
                                                            args_dict["end_line"] = int(
                                                                args_dict["end_line"]
                                                            )
                                                            modified = True

                                                        # Update the arguments if modified
                                                        if modified:
                                                            tool_call["function"][
                                                                "arguments"
                                                            ] = json.dumps(args_dict)
                                                            tc_args = tool_call[
                                                                "function"
                                                            ]["arguments"]
                                                            logger.info(
                                                                f"Transformed non-streaming read_file arguments: {tc_args}"
                                                            )
                                                    except (
                                                        json.JSONDecodeError,
                                                        ValueError,
                                                    ) as e:
                                                        logger.warning(
                                                            f"Failed to transform non-streaming read_file arguments: {e}"
                                                        )

                                                logger.info(
                                                    f"  Tool call {tc_idx + 1}: id={tc_id}, type={tc_type}, name={tc_name}"
                                                )
                                                if tc_args:
                                                    logger.info(
                                                        f"    Arguments: {tc_args}"
                                                    )
                    # Re-encode the modified response
                    content = json.dumps(response_json).encode("utf-8")
                except Exception as e:
                    logger.debug(f"Could not parse response for tool call logging: {e}")

            # Log error responses for debugging
            if response.status_code >= 400:
                try:
                    error_str = content.decode("utf-8")
                    logger.error(
                        f"Upstream API error {response.status_code} for {target_url}: {error_str}"
                    )

                    # Log rate limit headers for debugging
                    rate_limit_headers = {
                        "x-ratelimit-limit-requests": response.headers.get(
                            "x-ratelimit-limit-requests"
                        ),
                        "x-ratelimit-remaining-requests": response.headers.get(
                            "x-ratelimit-remaining-requests"
                        ),
                        "x-ratelimit-reset-requests": response.headers.get(
                            "x-ratelimit-reset-requests"
                        ),
                        "x-ratelimit-limit-tokens": response.headers.get(
                            "x-ratelimit-limit-tokens"
                        ),
                        "x-ratelimit-remaining-tokens": response.headers.get(
                            "x-ratelimit-remaining-tokens"
                        ),
                        "x-ratelimit-reset-tokens": response.headers.get(
                            "x-ratelimit-reset-tokens"
                        ),
                    }

                    # Only log rate limit headers that are present
                    present_headers = {
                        k: v for k, v in rate_limit_headers.items() if v is not None
                    }
                    if present_headers:
                        logger.info(f"Rate limit headers: {present_headers}")

                except:
                    logger.error(
                        f"Upstream API error {response.status_code} for {target_url}: <binary data, {len(content)} bytes>"
                    )

                # Log request payload for debugging
                if body:
                    try:
                        request_payload = body.decode("utf-8")
                        logger.error(
                            f"Request payload for {target_url}: {request_payload}"
                        )
                    except:
                        logger.error(
                            f"Request payload for {target_url}: <binary data, {len(body)} bytes>"
                        )

                return Response(
                    content=content,
                    status_code=response.status_code,
                    headers=dict(response.headers),
                )

            return Response(
                content=content,
                status_code=response.status_code,
                headers=dict(response.headers),
            )

    except httpx.RequestError as e:
        logger.error(f"Request error for {target_url}: {e}")
        return Response(
            content=f"Proxy request failed: {str(e)}",
            status_code=502,
        )
    except Exception as e:
        logger.error(f"Unexpected error for {target_url}: {e}")
        return Response(
            content=f"Internal proxy error: {str(e)}",
            status_code=500,
        )


# Ollama endpoints removed


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "target": OPENAI_BASE_URL}


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "9000"))

    logger.info(f"Starting Venice Proxy on http://{host}:{port}")
    logger.info(f"Target: {OPENAI_BASE_URL}")

    uvicorn.run(
        "proxy:app",
        host=host,
        port=port,
        log_level="info",
    )

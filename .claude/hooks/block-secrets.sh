#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$CMD" | grep -qEi '(AKIA|sk-ant-|sk-[a-zA-Z0-9]{20,}|ghp_|gho_|CLAUDE_CODE_OAUTH_TOKEN=|GH_TOKEN=|password=)'; then
    echo "BLOCKED: Potential secret detected in command" >&2
    exit 2
fi

exit 0

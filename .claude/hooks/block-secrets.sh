#!/bin/bash
# Scans the text a tool is about to introduce (a Bash command, or content written/edited into a
# file) for likely secret patterns. Covers Bash (tool_input.command), Write (tool_input.content)
# and Edit (tool_input.new_string) -- a secret pasted into a source file via Write/Edit used to
# slip past this hook entirely, since it only ever looked at Bash commands (issue #85).
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
    Bash)
        TEXT=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
        ;;
    Write)
        TEXT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
        ;;
    Edit)
        TEXT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
        ;;
    *)
        TEXT=""
        ;;
esac

if echo "$TEXT" | grep -qEi '(AKIA|sk-ant-|sk-[a-zA-Z0-9]{20,}|ghp_|gho_|CLAUDE_CODE_OAUTH_TOKEN=|GH_TOKEN=|password=)'; then
    echo "BLOCKED: Potential secret detected in $TOOL input" >&2
    exit 2
fi

exit 0

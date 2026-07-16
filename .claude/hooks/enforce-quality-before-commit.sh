#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$CMD" | grep -qE '^git\s+commit'; then
    PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

    if ! LINT_OUTPUT=$(cd "$PROJECT_DIR" && npm run lint 2>&1); then
        echo "LINT FAILED -- fix before committing:" >&2
        echo "$LINT_OUTPUT" >&2
        exit 2
    fi

    if ! TEST_OUTPUT=$(cd "$PROJECT_DIR" && npm test 2>&1); then
        echo "TESTS FAILED -- fix before committing:" >&2
        echo "$TEST_OUTPUT" >&2
        exit 2
    fi
fi

exit 0

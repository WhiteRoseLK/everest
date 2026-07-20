#!/bin/bash
# Runs lint/test before letting a `git commit` Bash call through. Matches `git commit` right
# after the start of the command or after a shell operator (;, &&, ||, |, newline), optionally
# preceded by `env VAR=val` assignments or `git -C <path>` -- not just a literal prefix of the
# whole command -- so `cd sub && git commit`, `env X=Y git commit` or `git -C . commit` can't slip
# past the anchored `^git\s+commit` this used to require (issue #85). This is early feedback for
# the agent; the real non-bypassable gate is the Husky `pre-commit` hook (see .husky/pre-commit),
# which runs regardless of how `git commit` was invoked.
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$CMD" | grep -qE '(^|[;&|]|&&|\|\|)[[:space:]]*(env[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*=\S+[[:space:]]+)*git([[:space:]]+-C[[:space:]]+\S+)?[[:space:]]+commit\b'; then
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

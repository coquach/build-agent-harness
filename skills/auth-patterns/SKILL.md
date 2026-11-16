---
description: Authentication patterns and security checks for this project
---
# Auth Patterns

Use the project's existing authentication and authorization conventions before
adding new flows.

## Checklist

- Identify where credentials or tokens are validated.
- Keep secrets in environment variables; never commit them.
- Apply authentication before authorization checks.
- Add focused tests for unauthenticated and unauthorized requests.
- Run the project's discovered verification gates after changes.

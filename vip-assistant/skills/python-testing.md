# Skill: Expert Python Testing & Automation

When writing or executing tests in Python:

1. **Framework Best Practices:**
   - Prefer `pytest` over standard `unittest` unless `unittest` is already used in the workspace.
   - Use clean, modular pytest fixtures (`conftest.py`) to manage setup and teardown actions.
   - Avoid hardcoding database connections, tokens, or file paths. Use Mocking / Monkeypatching tools dynamically.

2. **Automated Running & Validation:**
   - When generating or editing test scripts, immediately run them via bash: `pytest -v <filename>.py` to verify all test suites pass.
   - If tests fail, read the output traceback, analyze the root cause, and implement a code correction directly without stopping.

3. **Coverage Standards:**
   - Target full coverage of both success paths and error handling branches.
   - Verify code compiles and passes py_compile syntax validation check before execution.
